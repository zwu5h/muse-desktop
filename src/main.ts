// Muse Desktop — Frontend: Chat + Paste/Vision gegen das Tauri-Backend.
// Backend-Kommandos (src-tauri/src/main.rs): check_cli, send_prompt,
// save_pasted_image, pick_workspace, pick_images. Events: "muse-event".

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Role = "user" | "assistant";

interface ChatMessage {
  role: Role;
  text: string;
  images?: string[];
  toolNotes?: string[];
  ts?: number;
}

interface Session {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
}

interface MuseEventPayload {
  run_id: string;
  line: string;
}

interface CliStatus {
  ok: boolean;
  version: string;
  path: string;
}

const LS_SESSIONS = "muse-desktop.sessions.v1";
const LS_ACTIVE = "muse-desktop.active.v1";
const LS_WORKSPACE = "muse-desktop.workspace.v1";
const LS_MODEL = "muse-desktop.model.v1";
const LS_EFFORT = "muse-desktop.effort.v1";
const LS_CLI = "muse-desktop.cli-path.v1";

// Reasoning-Stufen der Muse-CLI (--reasoning-effort), Default: high.
const EFFORTS = [
  { id: "none", label: "Aus" },
  { id: "minimal", label: "Min" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

const SUGGESTIONS: { title: string; sub: string; prompt: string }[] = [
  {
    title: "Projekt erklären",
    sub: "Struktur und Einstiegspunkte verstehen",
    prompt: "Erkläre mir die Struktur dieses Projekts: Welche Ordner und Dateien sind die wichtigsten Einstiegspunkte?",
  },
  {
    title: "Code prüfen",
    sub: "Bugs und Risiken im Arbeitsordner finden",
    prompt: "Schau dir den Arbeitsordner an und nenne mir die drei größten Bugs oder Risiken, die du findest.",
  },
  {
    title: "Etwas bauen",
    sub: "Feature oder Test umsetzen lassen",
    prompt: "Schlage eine kleine, sinnvolle Verbesserung für dieses Projekt vor und setze sie um.",
  },
];

const ICON_COPY =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="8.5" height="8.5" rx="2"/><path d="M11 5V3.5c0-.8-.7-1.5-1.5-1.5h-6C2.7 2 2 2.7 2 3.5v6c0 .8.7 1.5 1.5 1.5H5"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M6.5 4V2.8c0-.4.4-.8.8-.8h1.4c.4 0 .8.4.8.8V4M4 4l.7 9c.1.6.5 1 1.1 1h4.4c.6 0 1-.4 1.1-1l.7-9"/></svg>';
const ICON_SPARK =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1c.3 2.5 1 3.2 3.5 3.5-2.5.3-3.2 1-3.5 3.5-.3-2.5-1-3.2-3.5-3.5 2.5-.3 3.2-1 3.5-3.5zm6 7c.2 1.5.6 1.9 2.1 2.1-1.5.2-1.9.6-2.1 2.1-.2-1.5-.6-1.9-2.1-2.1 1.5-.2 1.9-.6 2.1-2.1zM3 10.5c.2 1.2.5 1.5 1.7 1.7-1.2.2-1.5.5-1.7 1.7-.2-1.2-.5-1.5-1.7-1.7 1.2-.2 1.5-.5 1.7-1.7z"/></svg>';
const ICON_IMG =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><circle cx="5.5" cy="6.5" r="1.3"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/></svg>';

const el = <T extends HTMLElement>(id: string): T => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`#${id} fehlt`);
  return n as T;
};

const messagesEl = el("messages");
const promptEl = el<HTMLTextAreaElement>("prompt");
const sendBtn = el<HTMLButtonElement>("send-btn");
const attachBtn = el<HTMLButtonElement>("attach-btn");
const newChatBtn = el<HTMLButtonElement>("new-chat");
const sessionsEl = el("sessions");
const sessionSearchEl = el<HTMLInputElement>("session-search");
const workspaceEl = el<HTMLInputElement>("workspace");
const workspaceBtn = el<HTMLButtonElement>("workspace-btn");
const modelEl = el<HTMLInputElement>("model");
const modelBadgeEl = el("model-badge");
const effortPillsEl = el("effort-pills");
const effortBadgeEl = el("effort-badge");
const cliStatusEl = el("cli-status");
const cliPathEl = el<HTMLInputElement>("cli-path");
const cliResetBtn = el<HTMLButtonElement>("cli-reset");
const statusDotEl = el("status-dot");
const statusPillEl = el("status-pill");
const statusTextEl = el("status-text");
const chatTitleEl = el("chat-title");
const chatSubEl = el("chat-sub");
const composerMetaEl = el("composer-meta");
const attachmentsEl = el("attachments");

const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

let sessions: Session[] = loadSessions();
let activeId: string | null = localStorage.getItem(LS_ACTIVE);
let effort: string = localStorage.getItem(LS_EFFORT) ?? "high";
if (!EFFORTS.some((e) => e.id === effort)) effort = "high";
let sessionFilter = "";
let pendingImages: { path: string; preview: string }[] = [];
let sending = false;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Session[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(): void {
  localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
  if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
}

function cliPath(): string {
  return cliPathEl.value.trim();
}

function activeSession(): Session {
  let s = sessions.find((x) => x.id === activeId) ?? null;
  if (!s) {
    s = { id: uid(), title: "Neuer Chat", createdAt: Date.now(), messages: [] };
    sessions.unshift(s);
    activeId = s.id;
    persist();
  }
  return s;
}

function effortLabel(id: string): string {
  return EFFORTS.find((e) => e.id === id)?.label ?? id;
}

function fmtWhen(ts: number | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "jetzt";
  if (diff < 3_600_000) return `vor ${Math.floor(diff / 60_000)} Min`;
  if (diff < 86_400_000) return `vor ${Math.floor(diff / 3_600_000)} Std`;
  const d = new Date(ts);
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
}

type StatusKind = "ready" | "busy" | "error";

function setStatus(kind: StatusKind, text: string, sub?: string): void {
  statusDotEl.className = "dot " + (kind === "ready" ? "idle" : kind);
  statusPillEl.className = "status-pill " + kind;
  statusTextEl.textContent = text;
  if (sub !== undefined) chatSubEl.textContent = sub;
}

/** Markdown-light: Codezäune werden zu Blöcken mit Kopf + Kopieren. */
function renderText(src: string): string {
  const esc = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const parts = esc.split(/```/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const m = parts[i].match(/^(\w+)\n/);
      const lang = m ? m[1] : "code";
      const code = m ? parts[i].slice(m[0].length) : parts[i];
      out +=
        `<div class="codeblock"><div class="codeblock-head">` +
        `<span>${lang}</span><span class="spacer"></span>` +
        `<button class="mini-btn" data-code-copy>${ICON_COPY}<span>Kopieren</span></button>` +
        `</div><pre><code>${code.replace(/\n$/, "")}</code></pre></div>`;
    } else {
      out += parts[i]
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }
  }
  return out;
}

function renderMessages(streaming = false): void {
  const s = activeSession();
  chatTitleEl.textContent = s.title;
  messagesEl.innerHTML = "";
  if (s.messages.length === 0) {
    renderEmpty();
    return;
  }
  s.messages.forEach((m, idx) => {
    const div = document.createElement("div");
    div.className = "msg " + m.role;
    if (streaming && idx === s.messages.length - 1 && m.role === "assistant") {
      div.classList.add("streaming");
    }
    if (m.role === "assistant") {
      const role = document.createElement("div");
      role.className = "role";
      const av = document.createElement("img");
      av.className = "avatar";
      av.src = "muse-mark.svg";
      av.alt = "Muse";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = "Muse";
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = fmtWhen(m.ts);
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const copy = document.createElement("button");
      copy.className = "mini-btn";
      copy.innerHTML = `${ICON_COPY}<span>Kopieren</span>`;
      copy.title = "Antwort kopieren";
      copy.onclick = () => copyText(m.text, copy);
      role.append(av, who, when, spacer, copy);
      div.appendChild(role);
    }

    if (m.images && m.images.length > 0) {
      const thumbs = document.createElement("div");
      thumbs.className = "thumbs";
      for (const p of m.images) {
        const chip = document.createElement("span");
        chip.textContent = `[Bild: ${shortName(p)}]`;
        chip.title = p;
        thumbs.appendChild(chip);
      }
      div.appendChild(thumbs);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = renderText(m.text) || "<i>…</i>";
    div.appendChild(body);

    const notes = m.toolNotes ?? [];
    if (notes.length > 0) {
      const det = document.createElement("details");
      det.className = "tools";
      const sum = document.createElement("summary");
      sum.textContent = `Tool-Aktivität (${notes.length})`;
      det.appendChild(sum);
      for (const t of notes) {
        const line = document.createElement("div");
        line.className = "tool-line";
        line.textContent = t;
        det.appendChild(line);
      }
      div.appendChild(det);
    }
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderEmpty(): void {
  const d = document.createElement("div");
  d.className = "empty";
  const img = document.createElement("img");
  img.src = "muse-mark.svg";
  img.alt = "Muse";
  const h = document.createElement("h2");
  h.textContent = "Womit soll Muse helfen?";
  const p = document.createElement("p");
  p.textContent = "Frage stellen, Screenshot pasten oder mit einem Vorschlag starten.";
  const sug = document.createElement("div");
  sug.className = "suggestions";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "suggestion";
    const icon = document.createElement("span");
    icon.className = "s-icon";
    icon.innerHTML = ICON_SPARK;
    const texts = document.createElement("span");
    texts.className = "s-texts";
    const title = document.createElement("div");
    title.className = "s-title";
    title.textContent = s.title;
    const sub = document.createElement("div");
    sub.className = "s-sub";
    sub.textContent = s.sub;
    texts.append(title, sub);
    const arrow = document.createElement("span");
    arrow.className = "s-arrow";
    arrow.textContent = "→";
    b.append(icon, texts, arrow);
    b.onclick = () => {
      promptEl.value = s.prompt;
      autogrow();
      promptEl.focus();
    };
    sug.appendChild(b);
  }
  const hint = document.createElement("div");
  hint.className = "paste-hint";
  const kbd1 = document.createElement("kbd");
  kbd1.textContent = "Strg";
  const plus = document.createTextNode("+");
  const kbd2 = document.createElement("kbd");
  kbd2.textContent = "V";
  const rest = document.createTextNode("  Bild aus der Zwischenablage als Vision-Anhang einfügen");
  hint.append(kbd1, plus, kbd2, rest);
  d.append(img, h, p, sug, hint);
  messagesEl.appendChild(d);
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const label = btn.querySelector("span");
  try {
    await navigator.clipboard.writeText(text);
    if (label) label.textContent = "Kopiert!";
    btn.classList.add("ok");
  } catch {
    if (label) label.textContent = "Fehler";
  }
  setTimeout(() => {
    if (label) label.textContent = "Kopieren";
    btn.classList.remove("ok");
  }, 1300);
}

function shortName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function renderSessions(): void {
  sessionsEl.innerHTML = "";
  const q = sessionFilter.trim().toLowerCase();
  const list = q
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.messages.some((m) => m.text.toLowerCase().includes(q))
      )
    : sessions;
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "s-empty";
    li.textContent = sessions.length === 0 ? "Noch keine Sitzungen" : "Nichts gefunden";
    sessionsEl.appendChild(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    if (s.id === activeId) li.classList.add("active");
    li.title = new Date(s.createdAt).toLocaleString("de-DE");
    const top = document.createElement("div");
    top.className = "s-top";
    const t = document.createElement("span");
    t.className = "s-title";
    t.textContent = s.title;
    const del = document.createElement("button");
    del.className = "s-del";
    del.innerHTML = ICON_TRASH;
    del.title = "Sitzung löschen";
    del.onclick = (e) => {
      e.stopPropagation();
      sessions = sessions.filter((x) => x.id !== s.id);
      if (activeId === s.id) activeId = sessions[0]?.id ?? null;
      persist();
      renderSessions();
      renderMessages();
    };
    top.append(t, del);
    const meta = document.createElement("div");
    meta.className = "s-meta";
    const n = s.messages.filter((m) => m.role === "user").length;
    meta.textContent = `${fmtWhen(s.createdAt)} · ${n} ${n === 1 ? "Anfrage" : "Anfragen"}`;
    li.append(top, meta);
    li.onclick = () => {
      activeId = s.id;
      persist();
      renderSessions();
      renderMessages();
      refreshTopbar();
    };
    sessionsEl.appendChild(li);
  }
}

function renderEffort(): void {
  effortPillsEl.innerHTML = "";
  for (const e of EFFORTS) {
    const b = document.createElement("button");
    b.className = "pill" + (e.id === effort ? " sel" : "");
    b.textContent = e.label;
    b.title = `Reasoning-Effort: ${e.id} (--reasoning-effort)`;
    b.onclick = () => {
      effort = e.id;
      localStorage.setItem(LS_EFFORT, effort);
      renderEffort();
      refreshTopbar();
    };
    effortPillsEl.appendChild(b);
  }
}

function refreshTopbar(): void {
  effortBadgeEl.textContent = effortLabel(effort);
  const model = modelEl.value.trim() || "Standard";
  modelBadgeEl.textContent = model;
  const s = activeSession();
  chatTitleEl.textContent = s.title;
}

function renderAttachments(): void {
  attachmentsEl.innerHTML = "";
  for (const img of pendingImages) {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (img.preview) {
      const im = document.createElement("img");
      im.src = img.preview;
      im.alt = shortName(img.path);
      chip.appendChild(im);
    } else {
      const ph = document.createElement("span");
      ph.className = "no-preview";
      ph.innerHTML = ICON_IMG;
      chip.appendChild(ph);
    }
    const label = document.createElement("span");
    label.textContent = shortName(img.path);
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Entfernen";
    x.onclick = () => {
      pendingImages = pendingImages.filter((p) => p.path !== img.path);
      renderAttachments();
    };
    chip.append(label, x);
    attachmentsEl.appendChild(chip);
  }
}

/** Extrahiert lesbaren Text aus einer `muse exec --json`-Eventzeile (MSP-Envelope).
 *  Streaming-Text kommt als `run.output.delta` (payload.text); der Abschlussrecord
 *  (`run.terminal.*`) wiederholt die komplette Antwort und ist als terminal
 *  markiert, damit der Aufrufer Doppelungen vermeiden kann. */
function extractEvent(line: string): { text: string; note: string; terminal: boolean } {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { text: "", note: "", terminal: false };
  }
  if (typeof obj === "string") return { text: obj, note: "", terminal: false };
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    // MSP-Envelope: payload_type/payload (z. B. "run.output.delta" mit payload.text,
    // "task.lifecycle.*" als Rauschen, Tool-Calls als Notiz).
    const ptype = typeof o.payload_type === "string" ? o.payload_type : "";
    const low = (type + " " + ptype).toLowerCase();
    const payload =
      o.payload && typeof o.payload === "object"
        ? (o.payload as Record<string, unknown>)
        : null;
    const terminal =
      ptype.startsWith("run.terminal") ||
      ptype.includes("completed") ||
      ptype.includes("final");
    if (
      low.includes("tool") ||
      low.includes("error") ||
      low.includes("approval") ||
      low.includes("side_effect_intent")
    ) {
      const kind = payload && typeof payload.kind === "string" ? payload.kind : ptype;
      const op =
        payload && typeof payload.operation === "string" ? `: ${payload.operation}` : "";
      return { text: "", note: cleanNote(String(kind) + op).slice(0, 120), terminal };
    }
    if (payload) {
      for (const key of ["text", "delta", "content", "message", "output"]) {
        const v = payload[key];
        if (typeof v === "string" && v.length > 0) return { text: v, note: "", terminal };
      }
    }
    for (const key of ["delta", "text", "content", "message", "output"]) {
      const v = o[key];
      if (typeof v === "string" && v.length > 0) return { text: v, note: "", terminal };
    }
  }
  return { text: "", note: "", terminal: false };
}

function cleanNote(s: string): string {
  return s.replace(/</g, "&lt;").slice(0, 220);
}

function autogrow(): void {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 200) + "px";
}

async function send(): Promise<void> {
  const prompt = promptEl.value.trim();
  if (!prompt || sending) return;
  const workspace = workspaceEl.value.trim();
  if (!workspace) {
    alert("Bitte zuerst einen Arbeitsordner wählen.");
    return;
  }
  const s = activeSession();
  const now = Date.now();
  const userMsg: ChatMessage = {
    role: "user",
    text: prompt,
    images: pendingImages.map((p) => p.path),
    ts: now,
  };
  s.messages.push(userMsg);
  if (s.messages.length === 1) {
    s.title = prompt.slice(0, 42) + (prompt.length > 42 ? "…" : "");
  }
  const assistantMsg: ChatMessage = { role: "assistant", text: "", toolNotes: [], ts: now };
  s.messages.push(assistantMsg);
  persist();
  renderSessions();
  renderMessages(true);
  refreshTopbar();

  promptEl.value = "";
  autogrow();
  pendingImages = [];
  renderAttachments();
  sending = true;
  sendBtn.disabled = true;
  composerMetaEl.textContent = "Muse arbeitet …";
  setStatus("busy", `Denkt nach (${effortLabel(effort)})`, workspace);

  const images = userMsg.images ?? [];
  const model = modelEl.value.trim() || "default";
  const cli = cliPath() || null;
  let runId: string | null = null;
  let unlisten: (() => void) | null = null;

  try {
    if (inTauri) {
      unlisten = await listen<MuseEventPayload>("muse-event", (ev) => {
        if (runId && ev.payload.run_id !== runId) return;
        const { text, note, terminal } = extractEvent(ev.payload.line);
        // Abschlussrecord wiederholt die Antwort: nur anhängen, wenn neu.
        if (text && !(terminal && assistantMsg.text.endsWith(text))) {
          assistantMsg.text += text;
        }
        if (note && (assistantMsg.toolNotes?.length ?? 0) < 20) {
          assistantMsg.toolNotes?.push(note);
        }
        renderMessages(true);
      });
      const id = await invoke<string>("send_prompt", {
        args: {
          prompt,
          workspace,
          images,
          model,
          reasoning_effort: effort,
          cli_path: cli,
        },
      });
      runId = id;
    } else {
      assistantMsg.text =
        "Dev-Modus ohne Tauri: Starte die App mit `tauri dev`, damit der Prompt " +
        "wirklich an die Muse-CLI geht.\n\nDein Prompt war:\n```\n" +
        prompt +
        "\n```" +
        (images.length > 0 ? `\nBilder: ${images.join(", ")}` : "") +
        `\nModell: ${model}, Denk-Tiefe: ${effort}`;
    }
    setStatus("ready", "Bereit", workspace);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assistantMsg.text += `\n\n[Fehler: ${msg}]`;
    setStatus("error", "Fehler", workspace);
  } finally {
    if (unlisten) unlisten();
    sending = false;
    sendBtn.disabled = false;
    composerMetaEl.textContent = "Strg+Enter zum Senden";
    persist();
    renderMessages();
    refreshTopbar();
  }
}

/** Bilder aus der Zwischenablage abfangen (der Vision-Hauptfall). */
async function handlePaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return;
  const files: File[] = [];
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return; // normaler Text-Paste läuft weiter
  e.preventDefault();
  for (const f of files) {
    const dataUrl = await fileToDataUrl(f);
    const base64 = dataUrl.split(",", 2)[1] ?? "";
    if (inTauri) {
      try {
        const path = await invoke<string>("save_pasted_image", {
          filename: f.name || "paste.png",
          dataBase64: base64,
        });
        pendingImages.push({ path, preview: dataUrl });
      } catch (err) {
        alert(`Bild konnte nicht gespeichert werden: ${String(err)}`);
      }
    } else {
      pendingImages.push({ path: f.name || "paste.png", preview: dataUrl });
    }
  }
  renderAttachments();
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

async function checkCli(): Promise<void> {
  if (!inTauri) {
    cliStatusEl.textContent = "Web-Vorschau (ohne CLI)";
    return;
  }
  try {
    const st = await invoke<CliStatus>("check_cli", { cliPath: cliPath() || null });
    cliStatusEl.textContent = st.ok ? st.version : "CLI-Fehler";
    cliStatusEl.className = "brand-sub " + (st.ok ? "ok" : "bad");
    cliStatusEl.title = st.path;
    if (!cliPathEl.value) cliPathEl.placeholder = st.path;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    cliStatusEl.textContent = "muse CLI nicht gefunden";
    cliStatusEl.className = "brand-sub bad";
    cliStatusEl.title = msg;
  }
}

async function init(): Promise<void> {
  workspaceEl.value = localStorage.getItem(LS_WORKSPACE) ?? "";
  workspaceEl.addEventListener("change", () =>
    localStorage.setItem(LS_WORKSPACE, workspaceEl.value.trim())
  );
  modelEl.value = localStorage.getItem(LS_MODEL) ?? "";
  const saveModel = () => {
    localStorage.setItem(LS_MODEL, modelEl.value.trim());
    refreshTopbar();
  };
  modelEl.addEventListener("change", saveModel);
  cliPathEl.value = localStorage.getItem(LS_CLI) ?? "";
  cliPathEl.addEventListener("change", () => {
    localStorage.setItem(LS_CLI, cliPathEl.value.trim());
    void checkCli();
  });
  cliResetBtn.onclick = () => {
    cliPathEl.value = "";
    localStorage.removeItem(LS_CLI);
    void checkCli();
  };

  sessionSearchEl.addEventListener("input", () => {
    sessionFilter = sessionSearchEl.value;
    renderSessions();
  });

  sendBtn.onclick = () => void send();
  promptEl.addEventListener("input", autogrow);
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
  });
  promptEl.addEventListener("paste", (e) => void handlePaste(e));

  // Codeblock-Kopieren per Delegation (Buttons entstehen dynamisch).
  messagesEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-code-copy]");
    if (!(btn instanceof HTMLButtonElement)) return;
    const block = btn.closest(".codeblock");
    const code = block?.querySelector("code");
    if (code) void copyText(code.innerText, btn);
  });

  attachBtn.onclick = async () => {
    if (!inTauri) return;
    const paths = await invoke<string[]>("pick_images");
    for (const p of paths) pendingImages.push({ path: p, preview: "" });
    renderAttachments();
  };
  workspaceBtn.onclick = async () => {
    if (!inTauri) return;
    const picked = await invoke<string | null>("pick_workspace");
    if (picked) {
      workspaceEl.value = picked;
      localStorage.setItem(LS_WORKSPACE, picked);
    }
  };
  newChatBtn.onclick = () => {
    const s: Session = { id: uid(), title: "Neuer Chat", createdAt: Date.now(), messages: [] };
    sessions.unshift(s);
    activeId = s.id;
    persist();
    renderSessions();
    renderMessages();
    refreshTopbar();
  };

  await checkCli();
  renderEffort();
  renderSessions();
  renderMessages();
  renderAttachments();
  refreshTopbar();
  setStatus("ready", "Bereit", workspaceEl.value.trim() || "Kein Ordner gewählt");
  autogrow();
}

void init();
