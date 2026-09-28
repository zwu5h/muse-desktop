// Muse Desktop — Tauri backend.
// Wraps the `muse` CLI: `muse exec --json` streams JSONL events,
// `--image <path>` (repeatable) gives the model vision.
// Pasted images arrive as base64 and are stored under app-data/attachments.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

struct RunState {
    running: bool,
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
    cli_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct MuseEvent {
    run_id: String,
    line: String,
}

#[tauri::command]
async fn check_cli(cli_path: Option<String>) -> Result<CliStatus, String> {
    let exe = resolve_muse(cli_path.as_deref())?;
    let out = tokio::process::Command::new(&exe)
        .arg("--version")
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
    {
        let mut s = state.lock().await;
        s.running = true;
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let result = run_exec(&app, &run_id, &args).await;

    {
        let mut s = state.lock().await;
        s.running = false;
    }
    result
}

async fn run_exec(app: &AppHandle, run_id: &str, args: &SendPromptArgs) -> Result<String, String> {
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
    for img in &args.images {
        if !img.trim().is_empty() {
            cmd.arg("--image").arg(img.trim());
        }
    }
    cmd.arg(&args.prompt);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("muse starten: {e}"))?;
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
        if collected.len() > 4 * 1024 * 1024 {
            break;
        }
    }

    let status = child.wait().await.map_err(|e| format!("warten: {e}"))?;
    if status.success() {
        Ok(run_id.to_string())
    } else {
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
        .manage(Mutex::new(RunState { running: false }))
        .invoke_handler(tauri::generate_handler![
            check_cli,
            save_pasted_image,
            send_prompt,
            pick_workspace,
            pick_images
        ])
        .run(tauri::generate_context!())
        .expect("Tauri-Laufzeitfehler");
}
