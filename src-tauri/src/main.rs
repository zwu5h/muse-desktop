#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
// Muse Desktop — Tauri backend.
// Wraps the `muse` CLI: `muse exec --json` streams JSONL events,
// `--image <path>` (repeatable) gives the model vision.
// Pasted images arrive as base64 and are stored under app-data/attachments.
// NOTE: windows_subsystem="windows" (oben, nur Release) verhindert das
// eigene Konsolenfenster der App. Die CLI-Kinderprozesse bekommen zusätzlich
// CREATE_NO_WINDOW, damit beim Spawnen von muse.exe kein cmd-Fenster aufpoppt.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
/// CREATE_NO_WINDOW: kein cmd-Fenster beim Spawnen der CLI auf Windows.
/// (tokio::process::Command kennt `creation_flags` auf Windows direkt.)
#[cfg(target_os = "windows")]
const NO_WINDOW: u32 = 0x08000000;

struct RunState {
    running: bool,
    run_id: Option<String>,
    pid: Option<u32>,
}

#[derive(Debug, Serialize)]
struct CliStatus {
    ok: bool,
    version: String,
    path: String,
}

/// Findet die echte `muse`-Binary.
/// Auf Windows liegt im PATH oft nur ein `.cmd`-Shim (Powershell-Launcher),
/// den Rust nicht direkt spawnen kann — bevorzuge daher `muse.exe` bzw.
/// versionswechslende `muse-bin-*.exe` im selben Ordner.
fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default()
}

fn find_on_path(file: &str) -> Option<PathBuf> {
    path_dirs()
        .into_iter()
        .map(|d| d.join(file))
        .find(|p| p.is_file())
}

fn best_in_dir(dir: &std::path::Path) -> Option<PathBuf> {
    let direct = dir.join("muse.exe");
    if direct.is_file() {
        return Some(direct);
    }
    let mut cands: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("exe"))
                && p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("muse-bin-"))
        })
        .collect();
    cands.sort();
    cands.pop()
}

fn resolve_muse(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
        // Manueller Pfad ist veraltet (Exe-Namen enthalten die Version) →
        // stillschweigend auf Auto-Erkennung zurückfallen.
    }
    if let Some(exe) = find_on_path("muse.exe") {
        return Ok(exe);
    }
    if let Some(shim) = find_on_path("muse.cmd").or_else(|| find_on_path("muse")) {
        if let Some(dir) = shim.parent() {
            if let Some(exe) = best_in_dir(dir) {
                return Ok(exe);
            }
        }
    }
    let mut dirs = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Programs").join("muse"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    for d in dirs {
        if let Some(exe) = best_in_dir(&d) {
            return Ok(exe);
        }
    }
    Err("muse CLI nicht gefunden — weder muse.exe im PATH noch im Muse-Installationsordner. Pfad ggf. unten manuell setzen.".into())
}

#[derive(Debug, Deserialize)]
struct SendPromptArgs {
    prompt: String,
    workspace: String,
    images: Vec<String>,
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    approval_mode: Option<String>,
    #[serde(default)]
    disable_approval: bool,
    #[serde(default)]
    cli_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct MuseEvent {
    run_id: String,
    line: String,
}

/// User-facing execution progress event streamed live to the frontend.
///
/// Deliberately structured: the UI renders `title`/`detail` directly and
/// never sees chain-of-thought or raw model reasoning. Only structured
/// tool fields (kind/operation/path/command) feed the title; free-form
/// model text is never copied into an activity item.
#[derive(Debug, Serialize, Clone)]
struct ActivityEvent {
    id: String,
    run_id: String,
    #[serde(rename = "type")]
    event_type: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// pending | running | success | error
    status: String,
    timestamp: u64,
    /// Idle | Thinking | Reading | Searching | Editing | Running | Waiting
    /// | Completed | Failed
    task_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    /// Internal envelope kind (e.g. payload_type) for the expandable
    /// "Details" section only. Never rendered as a title.
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_kind: Option<String>,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn activity_event(
    run_id: &str,
    event_type: &str,
    title: &str,
    detail: Option<String>,
    status: &str,
    task_state: &str,
) -> ActivityEvent {
    ActivityEvent {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        event_type: event_type.to_string(),
        title: title.to_string(),
        detail,
        status: status.to_string(),
        timestamp: now_ms(),
        task_state: task_state.to_string(),
        file: None,
        operation: None,
        command: None,
        exit_code: None,
        duration_ms: None,
        raw_kind: None,
    }
}

fn short_base(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn clean_chunk(s: &str, max: usize) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = one_line.trim().to_string();
    if out.len() > max {
        out.truncate(max);
        out.push('…');
    }
    out
}

/// Map one `muse exec --json` JSONL line to a user-facing activity item.
///
/// Returns `None` for streaming assistant text (`run.output.delta`),
/// terminal duplicates, and internal `task_lifecycle`/`tool_result`
/// noise — those are handled by the explicit start/completion events or
/// by the existing `muse-event` text stream. Never copies free-form model
/// text into titles.
fn classify_line(run_id: &str, line: &str) -> Option<ActivityEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.is_string() {
        return None;
    }
    let o = v.as_object()?;
    let ty = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let ptype = o
        .get("payload_type")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let low = format!("{ty} {ptype}").to_lowercase();
    if low.contains("run.output.delta") || low.contains("delta") {
        return None;
    }
    if low.contains("run.terminal") || low.contains("completed") || low.contains("final") {
        return None;
    }
    if low.contains("tool_result") || low.contains("internal") {
        return None;
    }
    if low.contains("lifecycle") {
        if low.contains("start") || low.contains("begin") || low.contains("created") {
            return Some(activity_event(
                run_id,
                "status",
                "Analyzing request",
                None,
                "running",
                "Thinking",
            ));
        }
        return None;
    }
    let payload = o.get("payload");
    let get_str = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(s) = payload.and_then(|p| p.get(*k)).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return Some(s.to_string());
                }
            }
            if let Some(s) = o.get(*k).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    };
    let kind = get_str(&["kind"]).unwrap_or_default();
    let op = get_str(&["operation", "op", "action"]).unwrap_or_default();
    let path = get_str(&["path", "file", "filename"]);
    let cmd = get_str(&["command", "cmd", "argv"]);
    let query = get_str(&["query", "pattern", "text_query", "needle"]);
    let hay = format!("{low} {kind} {op}").to_lowercase();

    if hay.contains("approval") {
        let mut ev = activity_event(
            run_id,
            "status",
            "Waiting for approval",
            None,
            "running",
            "Waiting",
        );
        ev.raw_kind = Some(clean_chunk(ptype, 80));
        return Some(ev);
    }
    if hay.contains("plan") && path.is_none() && cmd.is_none() {
        return Some(activity_event(
            run_id,
            "status",
            "Planning next step…",
            None,
            "running",
            "Thinking",
        ));
    }
    // File reads.
    if path.is_some()
        && (hay.contains("read")
            || hay.contains("cat")
            || hay.contains("open")
            || hay.contains("show")
            || hay.contains("view"))
    {
        let p = path.clone().unwrap_or_default();
        let mut ev = activity_event(
            run_id,
            "file",
            &format!("Reading {}", short_base(&p)),
            Some(clean_chunk(&p, 160)),
            "running",
            "Reading",
        );
        ev.file = Some(clean_chunk(&p, 260));
        ev.operation = Some(clean_chunk(
            if op.is_empty() { kind.as_str() } else { op.as_str() },
            80,
        ));
        ev.raw_kind = Some(clean_chunk(ptype, 80));
        return Some(ev);
    }
    // Project structure scans.
    if hay.contains("list")
        || hay.contains("glob")
        || hay.contains(" tree")
        || hay.contains("inspect")
        || hay.contains("structure")
        || (hay.contains("ls") && path.is_none() && cmd.is_none())
    {
        return Some(activity_event(
            run_id,
            "status",
            "Inspecting project structure",
            path.clone().map(|p| clean_chunk(&p, 160)),
            "running",
            "Reading",
        ));
    }
    // Search.
    if hay.contains("search") || hay.contains("grep") || hay.contains(" rg") || hay.contains("find") {
        let detail = query
            .as_deref()
            .or(path.as_deref())
            .map(|q| clean_chunk(q, 140));
        let title = match &detail {
            Some(q) if q.len() < 60 => format!("Searching for {q}"),
            _ => "Searching project".to_string(),
        };
        return Some(activity_event(
            run_id,
            "tool",
            &title,
            detail,
            "running",
            "Searching",
        ));
    }
    // Edits / writes.
    if hay.contains("edit")
        || hay.contains("write")
        || hay.contains("apply")
        || hay.contains("patch")
        || hay.contains("save")
        || hay.contains("create")
        || hay.contains("modify")
    {
        if let Some(p) = path.clone() {
            let mut ev = activity_event(
                run_id,
                "file",
                &format!("Editing {}", short_base(&p)),
                Some(clean_chunk(&p, 160)),
                "running",
                "Editing",
            );
            ev.file = Some(clean_chunk(&p, 260));
            ev.operation = Some(clean_chunk(
                if op.is_empty() { kind.as_str() } else { op.as_str() },
                80,
            ));
            ev.raw_kind = Some(clean_chunk(ptype, 80));
            return Some(ev);
        }
        return Some(activity_event(
            run_id,
            "tool",
            "Updating files",
            None,
            "running",
            "Editing",
        ));
    }
    // Shell commands / builds.
    if hay.contains("exec")
        || hay.contains("run")
        || hay.contains("build")
        || hay.contains("test")
        || hay.contains("npm")
        || hay.contains("cargo")
        || hay.contains("node")
        || hay.contains("command")
        || hay.contains("shell")
        || hay.contains("tsc")
    {
        let raw_cmd = cmd.clone().unwrap_or_else(|| {
            if hay.contains("build") {
                "build".to_string()
            } else {
                "command".to_string()
            }
        });
        let short = clean_chunk(&raw_cmd, 80);
        let title = if short.to_lowercase().contains("build") {
            "Running build".to_string()
        } else {
            format!("Running {short}")
        };
        let mut ev = activity_event(
            run_id,
            "command",
            &title,
            Some(clean_chunk(&raw_cmd, 200)),
            "running",
            "Running",
        );
        ev.command = Some(clean_chunk(&raw_cmd, 260));
        ev.raw_kind = Some(clean_chunk(ptype, 80));
        return Some(ev);
    }
    // Errors surfaced mid-run (kept as error items; the run continues).
    if hay.contains("error") || hay.contains("fail") {
        let detail = path
            .clone()
            .or(cmd.clone())
            .map(|d| clean_chunk(&d, 160));
        let mut ev = activity_event(
            run_id,
            "result",
            "Step reported an error",
            detail,
            "error",
            "Running",
        );
        ev.raw_kind = Some(clean_chunk(ptype, 80));
        return Some(ev);
    }
    // Generic tool call: user-readable, never raw JSON.
    if hay.contains("tool") || hay.contains("side_effect") || !kind.is_empty() || !op.is_empty() {
        let label = if !op.is_empty() {
            clean_chunk(&op, 60)
        } else if !kind.is_empty() {
            clean_chunk(&kind, 60)
        } else {
            "Working".to_string()
        };
        return Some(activity_event(
            run_id,
            "tool",
            &label,
            path.clone().map(|p| clean_chunk(&p, 160)),
            "running",
            "Thinking",
        ));
    }
    None
}

fn emit_activity(app: &AppHandle, ev: &ActivityEvent) {
    let _ = app.emit("muse://task-activity", ev);
}

#[tauri::command]
async fn check_cli(cli_path: Option<String>) -> Result<CliStatus, String> {
    let exe = resolve_muse(cli_path.as_deref())?;
    let mut version_cmd = tokio::process::Command::new(&exe);
    version_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    version_cmd.creation_flags(NO_WINDOW);
    let out = version_cmd
        .output()
        .await
        .map_err(|e| format!("muse starten ({}): {e}", exe.display()))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let version = if version.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        version
    };
    Ok(CliStatus {
        ok: out.status.success(),
        version,
        path: exe.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn save_pasted_image(
    app: AppHandle,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data_base64.trim(),
    )
    .map_err(|e| format!("base64 ungültig: {e}"))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("Bild zu groß (max 12 MB)".into());
    }
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app-data Pfad: {e}"))?
        .join("attachments");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Ordner anlegen: {e}"))?;
    let name = format!(
        "{}-{}.png",
        chrono_stamp(),
        if safe.is_empty() { "paste" } else { &safe }
    );
    let path = dir.join(name);
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("Bild speichern: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

/// Run `muse exec --json` and forward every stdout line as `muse-event`.
/// Returns the process exit note; per-line payloads arrive via events so the
/// UI can stream (Text, Tool-Calls, Fehler) noch während der Antwort.
#[tauri::command]
async fn send_prompt(
    app: AppHandle,
    state: State<'_, Mutex<RunState>>,
    args: SendPromptArgs,
) -> Result<String, String> {
    {
        let s = state.lock().await;
        if s.running {
            return Err("Es läuft bereits eine Anfrage — bitte warten oder abbrechen.".into());
        }
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    {
        let mut s = state.lock().await;
        s.running = true;
        s.run_id = Some(run_id.clone());
        s.pid = None;
    }
    let started = activity_event(
        &run_id,
        "status",
        "Analyzing request",
        None,
        "running",
        "Thinking",
    );
    emit_activity(&app, &started);
    let result = run_exec(&app, &state, &run_id, &args).await;

    {
        let mut s = state.lock().await;
        s.running = false;
        s.run_id = None;
        s.pid = None;
    }
    result
}

#[tauri::command]
async fn cancel_run(
    app: AppHandle,
    state: State<'_, Mutex<RunState>>,
) -> Result<bool, String> {
    let (pid, run_id) = {
        let s = state.lock().await;
        (s.pid, s.run_id.clone())
    };
    let Some(pid) = pid else {
        return Ok(false);
    };
    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = tokio::process::Command::new("kill")
            .arg(pid.to_string())
            .output()
            .await;
    }
    if let Some(rid) = run_id {
        let mut ev = activity_event(
            &rid,
            "result",
            "Task stopped",
            None,
            "error",
            "Failed",
        );
        ev.raw_kind = Some("cancelled".to_string());
        emit_activity(&app, &ev);
    }
    Ok(true)
}

async fn run_exec(
    app: &AppHandle,
    state: &State<'_, Mutex<RunState>>,
    run_id: &str,
    args: &SendPromptArgs,
) -> Result<String, String> {
    if args.prompt.trim().is_empty() {
        return Err("Leerer Prompt".into());
    }
    let exe = resolve_muse(args.cli_path.as_deref())?;
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg("exec")
        .arg("--json")
        .arg("--workspace")
        .arg(&args.workspace);
    if !args.model.trim().is_empty() && args.model != "default" {
        cmd.arg("--model").arg(args.model.trim());
    }
    if let Some(eff) = &args.reasoning_effort {
        if !eff.trim().is_empty() {
            cmd.arg("--reasoning-effort").arg(eff.trim());
        }
    }
    // --disable-approval überspringt Approval-Rückfragen, die OS-Sandbox
    // bleibt dabei aktiv (ideal für Contributor-Modelle mit begrenztem
    // Dateizugriff). Schließt --approval-mode aus, um Konflikte zu vermeiden.
    if args.disable_approval {
        cmd.arg("--disable-approval");
    } else if let Some(mode) = &args.approval_mode {
        if !mode.trim().is_empty() {
            cmd.arg("--approval-mode").arg(mode.trim());
        }
    }
    for img in &args.images {
        if !img.trim().is_empty() {
            cmd.arg("--image").arg(img.trim());
        }
    }
    cmd.arg(&args.prompt);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("muse starten: {e}"))?;
    {
        let mut s = state.lock().await;
        s.pid = child.id();
    }
    let started_at = now_ms();
    let stdout = child.stdout.take().ok_or("kein stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut collected = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        collected.push_str(&line);
        collected.push('\n');
        let payload = MuseEvent {
            run_id: run_id.to_string(),
            line: line.clone(),
        };
        // Fehlende Listener (z. B. Fenster zu) dürfen den Lauf nicht abbrechen.
        let _ = app.emit("muse-event", payload);
        // Structured progress: emitted immediately, never waits for completion.
        if let Some(ev) = classify_line(run_id, &line) {
            emit_activity(app, &ev);
        }
        if collected.len() > 4 * 1024 * 1024 {
            break;
        }
    }

    let status = child.wait().await.map_err(|e| format!("warten: {e}"))?;
    let duration_ms = now_ms().saturating_sub(started_at);
    if status.success() {
        let mut done = activity_event(
            run_id,
            "result",
            "Task completed",
            None,
            "success",
            "Completed",
        );
        done.duration_ms = Some(duration_ms);
        emit_activity(app, &done);
        Ok(run_id.to_string())
    } else {
        let code = status.code().unwrap_or(-1);
        let mut failed = activity_event(
            run_id,
            "result",
            "Task failed",
            Some(format!("Exit code: {code}")),
            "error",
            "Failed",
        );
        failed.exit_code = Some(code);
        failed.duration_ms = Some(duration_ms);
        failed.raw_kind = Some("run.terminal.error".to_string());
        emit_activity(app, &failed);
        Err(format!("muse exec Fehler (exit {status}) — siehe Events"))
    }
}

#[tauri::command]
async fn pick_workspace(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Arbeitsordner wählen")
        .blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
async fn pick_images(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Bilder anhängen (Vision)")
        .add_filter("Bilder", &["png", "jpg", "jpeg", "webp", "gif"])
        .blocking_pick_files();
    Ok(picked
        .map(|paths| paths.into_iter().map(|p| p.to_string()).collect())
        .unwrap_or_default())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Mutex::new(RunState {
            running: false,
            run_id: None,
            pid: None,
        }))
        .invoke_handler(tauri::generate_handler![
            check_cli,
            save_pasted_image,
            send_prompt,
            cancel_run,
            pick_workspace,
            pick_images
        ])
        .run(tauri::generate_context!())
        .expect("Tauri-Laufzeitfehler");
}
