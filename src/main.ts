// Muse Desktop — Frontend: Chat + Paste/Vision gegen das Tauri-Backend.
// Backend-Kommandos (src-tauri/src/main.rs): check_cli, send_prompt,
// save_pasted_image, pick_workspace, pick_images. Events: "muse-event".

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { taskActivityStore } from "./stores/taskActivityStore";
import { mountTaskActivity } from "./components/activity/TaskActivity";
import { renderCurrentAction } from "./components/activity/CurrentAction";
import { executionStore, type ExecSnapshot } from "./components/activity/executionStore";
import { renderExecutionBlock, startElapsedTicker } from "./components/activity/ExecutionBlock";
import { listenTaskActivity, noteToActivity } from "./hooks/useTaskActivity";
import { applyTheme, getThemeChoice } from "./stores/theme";

type Role = "user" | "assistant";

interface ChatMessage {
  role: Role;
  text: string;
  images?: string[];
  toolNotes?: string[];
  /** Live execution snapshot — rendered as the in-conversation exec block. */
  exec?: ExecSnapshot;
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
const LS_APPROVAL = "muse-desktop.approval.v1";
const LS_DISABLE_APPROVAL = "muse-desktop.disable-approval.v1";

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

const SUGGESTIONS: { title: string; sub: string; prompt: string; icon: string }[] = [
  {
    title: "Build a feature",
    sub: "Create and iterate on code.",
    prompt: "Suggest a small, useful improvement for this project and implement it.",
    icon: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3L2.5 8 6 13M10 3l3.5 5L10 13"/></svg>',
  },
  {
    title: "Fix a bug",
    sub: "Refactor, fix, or add features.",
    prompt: "Look at the workspace and tell me the three biggest bugs or risks you find.",
    icon: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  },
  {
    title: "Explain this codebase",
    sub: "Understand structure and entry points.",
    prompt: "Explain the structure of this project to me: which folders and files are the most important entry points?",
    icon: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 1.5h7l3 3V14.5H3z"/><path d="M10 1.5v3h3M5.5 8h5M5.5 10.8h5"/></svg>',
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
const approvalEl = el<HTMLSelectElement>("approval");
const disableApprovalEl = el<HTMLInputElement>("disable-approval");
const effortPillsEl = el("effort-pills");
const effortBadgeEl = el("effort-badge");
const cliStatusEl = el("cli-status");
const cliPathEl = el<HTMLInputElement>("cli-path");
const cliResetBtn = el<HTMLButtonElement>("cli-reset");
const statusDotEl = el("status-dot");
const statusPillEl = el("status-pill");
const statusTextEl = el("status-text");
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement | null;
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
let streamingQueued = false;
let writingNotedForRun = false;

function updateStopBtn(): void {
  if (stopBtn) stopBtn.hidden = !sending;
}

/**
 * Single entry point for backend progress: the inspector store owns the
 * side-panel feed, the execution store owns the in-conversation exec block.
 * Both only ever carry real backend titles — never invented reasoning.
 */
function pushActivity(raw: Parameters<typeof taskActivityStore.push>[0]): void {
  const stored = taskActivityStore.push(raw);
  executionStore.handleActivityItem(stored);
}

function queueStreamingRender(): void {
  if (streamingQueued) return;
  streamingQueued = true;
  const flush = () => {
    streamingQueued = false;
    renderMessages(true);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

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
    s = { id: uid(), title: "New Task", createdAt: Date.now(), messages: [] };
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
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const d = new Date(ts);
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
}

type StatusKind = "ready" | "busy" | "error";

function setStatus(kind: StatusKind, text: string, sub?: string): void {
  statusDotEl.className = "dot " + (kind === "ready" ? "idle" : kind);
  statusPillEl.className = "status-pill " + kind;
  statusTextEl.textContent = text;
  const readyText = document.querySelector(".ready-text");
  if (readyText) {
    readyText.textContent =
      kind === "busy" ? "Working…" : kind === "error" ? "Issue" : "Ready";
  }
  if (sub !== undefined) chatSubEl.textContent = sub;
  renderInspector();
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
        `<button class="mini-btn" data-code-copy>${ICON_COPY}<span>Copy</span></button>` +
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
    renderInspector();
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
      copy.innerHTML = `${ICON_COPY}<span>Copy</span>`;
      copy.title = "Copy response";
      copy.onclick = () => copyText(m.text, copy);
      role.append(av, who, when, spacer);
      if (m.text.includes("[Fehler:") || m.text.includes("[Error:")) {
        const retry = document.createElement("button");
        retry.className = "mini-btn show";
        retry.textContent = "Retry";
        retry.title = "Resend last request";
        retry.onclick = () => {
          const sess = activeSession();
          let lastUser = "";
          for (let i = 0; i <= idx && i < sess.messages.length; i++) {
            if (sess.messages[i].role === "user") lastUser = sess.messages[i].text;
          }
          // Fehler-Antwort (und alles danach) verwerfen, Anfrage wiederholen.
          sess.messages = sess.messages.slice(0, idx);
          persist();
          renderMessages();
          refreshTopbar();
          if (lastUser) void send(lastUser);
        };
        role.appendChild(retry);
      }
      role.appendChild(copy);
      div.appendChild(role);
    }

    // Live execution block: sits inside this assistant message, immediately
    // after the user message — exactly where the final response belongs.
    if (m.role === "assistant" && m.exec) {
      const stored = executionStore.getTask(m.exec.taskId);
      const liveView = stored !== null && stored.state === "running" ? stored : null;
      const host = document.createElement("div");
      renderExecutionBlock(host, liveView ?? m.exec, {
        live: liveView !== null,
        onToggle: (collapsed) => {
          const t = executionStore.getTask(m.exec!.taskId);
          if (t) executionStore.setCollapsed(t.taskId, collapsed);
          else {
            m.exec!.collapsed = collapsed;
            persist();
          }
        },
      });
      div.appendChild(host);
    }

    if (m.role === "user") {
      const label = document.createElement("div");
      label.className = "user-label";
      label.textContent = "You";
      div.appendChild(label);
    }

    if (m.images && m.images.length > 0) {
      const thumbs = document.createElement("div");
      thumbs.className = "thumbs";
      for (const p of m.images) {
        const chip = document.createElement("span");
        chip.textContent = `[Image: ${shortName(p)}]`;
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
      sum.textContent = `${notes.length} tool ${notes.length === 1 ? "call" : "calls"}`;
      det.appendChild(sum);
      for (const t of notes) {
        const line = document.createElement("div");
        line.className = "tool-line done";
        line.textContent = `› ${t}`;
        det.appendChild(line);
      }
      div.appendChild(det);
    }
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderInspector();
}

function renderEmpty(): void {
  const d = document.createElement("div");
  d.className = "hero";
  const img = document.createElement("img");
  img.src = "muse-mark.svg";
  img.alt = "Muse";
  const h = document.createElement("h1");
  h.textContent = "What do you want to build?";
  const p = document.createElement("p");
  p.textContent = "Ask Muse to code, search, or edit this workspace.";
  const cards = document.createElement("div");
  cards.className = "hero-cards";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "hero-card";
    const icon = document.createElement("div");
    icon.className = "h-icon";
    icon.innerHTML = s.icon;
    const title = document.createElement("div");
    title.className = "h-title";
    title.textContent = s.title;
    const sub = document.createElement("div");
    sub.className = "h-sub";
    sub.textContent = s.sub;
    b.append(icon, title, sub);
    b.onclick = () => {
      promptEl.value = s.prompt;
      autogrow();
      promptEl.focus();
    };
    cards.appendChild(b);
  }
  d.append(img, h, p, cards);
  messagesEl.appendChild(d);
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const label = btn.querySelector("span");
  try {
    await navigator.clipboard.writeText(text);
    if (label) label.textContent = "Copied";
    btn.classList.add("ok");
  } catch {
    if (label) label.textContent = "Error";
  }
  setTimeout(() => {
    if (label) label.textContent = "Copy";
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
    li.textContent = sessions.length === 0 ? "No tasks yet" : "No matches";
    sessionsEl.appendChild(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    if (s.id === activeId) li.classList.add("active");
    li.title = new Date(s.createdAt).toLocaleString("en-US");
    const top = document.createElement("div");
    top.className = "s-top";
    const t = document.createElement("span");
    t.className = "s-title";
    t.textContent = s.title;
    const del = document.createElement("button");
    del.className = "s-del";
    del.innerHTML = ICON_TRASH;
    del.title = "Delete task";
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
    meta.textContent = fmtWhen(s.createdAt);
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
    b.title = `Reasoning effort: ${e.id}`;
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
  const model = modelEl.value.trim() || "Default";
  modelBadgeEl.textContent = model;
  const s = activeSession();
  chatTitleEl.textContent = s.title;
  chatSubEl.textContent = workspaceEl.value.trim() || "No folder selected";
  renderInspector();
}

function fmtClock(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 1.5h7l3 3V14.5H3z"/><path d="M10 1.5v3h3"/></svg>';
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.5 4.5c0-.8.7-1.5 1.5-1.5h3l1.2 1.5h5.3c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5v-6z"/></svg>';
const CODE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3L2.5 8 6 13M10 3l3.5 5L10 13"/></svg>';

let runLogClearedAt = 0;

function renderInspector(): void {
  const titleEl = document.getElementById("current-task-title");
  const subEl = document.getElementById("current-task-sub");
  if (!titleEl || !subEl) return;
  // Live header: while work is in flight (or history exists) the prominent
  // current action owns this card. #run-log / #files-list are rendered by
  // the TaskActivity subscription (localized, batched) — never here, so
  // progress events don't re-render the chat.
  if (sending || taskActivityStore.getItems().length > 0) {
    const dot = document.querySelector(".task-dot");
    const spinner = document.getElementById("task-spinner");
    renderCurrentAction(titleEl, subEl, dot, spinner, sending);
  } else {
    const s = activeSession();
    if (s.messages.length === 0) {
      titleEl.textContent = "No active task";
      subEl.textContent = "Start a new task to begin…";
    } else {
      titleEl.textContent =
        s.title === "Neuer Chat" || s.title === "New Task" ? "Working on request" : s.title;
      const last = s.messages[s.messages.length - 1];
      const preview = last.text.trim().slice(0, 80) || "…";
      subEl.textContent = preview;
    }
    const dot = document.querySelector(".task-dot");
    if (dot) dot.className = "task-dot idle";
    const spinner = document.getElementById("task-spinner");
    if (spinner) spinner.hidden = true;
  }
  updateStopBtn();
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
    x.title = "Remove";
    x.onclick = () => {
      pendingImages = pendingImages.filter((p) => p.path !== img.path);
      renderAttachments();
    };
    chip.append(label, x);
    attachmentsEl.appendChild(chip);
  }
  renderInspector();
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
    if (low.includes("lifecycle") || low.includes("internal") || low.includes("tool_result")) {
      return { text: "", note: "", terminal };
    }
    if (
      low.includes("tool") ||
      low.includes("error") ||
      low.includes("approval") ||
      low.includes("side_effect_intent")
    ) {
      const kind = payload && typeof payload.kind === "string" ? payload.kind : ptype;
      const op =
        payload && typeof payload.operation === "string" ? ` ${payload.operation}` : "";
      const target =
        payload && typeof payload.path === "string"
          ? ` ${payload.path}`
          : payload && typeof payload.file === "string"
            ? ` ${payload.file}`
            : "";
      return { text: "", note: humanizeNote(`${kind}${op}${target}`).slice(0, 140), terminal };
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

function humanizeNote(raw: string): string {
  const s = cleanNote(raw).trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low.includes("completed") || low.includes("success")) return "Build successful";
  if (low.includes("build")) return low.includes("start") || low.includes("run") ? "Running build" : "Running build";
  if (low.includes("read")) return s.length > 40 ? s : `Reading ${s}`;
  if (low.includes("edit") || low.includes("write") || low.includes("apply")) return s.length > 40 ? s : `Editing ${s}`;
  if (low.includes("search") || low.includes("grep") || low.includes("glob")) return "Searching project";
  if (low.includes("list") || low.includes("ls")) return "Reading project structure";
  if (low.includes("approval")) return "Waiting for approval";
  if (low.includes("error") || low.includes("fail")) return s;
  return s;
}

function autogrow(): void {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 200) + "px";
}

async function send(preset?: string): Promise<void> {
  const prompt = (preset ?? promptEl.value).trim();
  if (!prompt || sending) return;
  const workspace = workspaceEl.value.trim();
  if (!workspace) {
    alert("Please choose a workspace folder first.");
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
  // Fresh live feed for this task; the exec block renders inside the new
  // assistant message immediately — no composer status needed.
  taskActivityStore.startRun();
  assistantMsg.exec = executionStore.task_started();
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
  // The composer stays clean: live progress owns the in-conversation exec
  // block. Only a generic topbar state changes here — no activity, elapsed
  // time, or tool status underneath the input box.
  writingNotedForRun = false;
  updateStopBtn();
  renderInspector();
  setStatus("busy", "Working…", workspace);
  const t0 = Date.now();

  const images = userMsg.images ?? [];
  const model = modelEl.value.trim() || "default";
  const cli = cliPath() || null;
  let runId: string | null = null;
  let unlisten: (() => void) | null = null;
  let unActivity: (() => void) | null = null;

  try {
    if (inTauri) {
      // Structured progress first: renders live, never waits for completion.
      unActivity = await listenTaskActivity({
        runId: null,
        onText: () => {},
        onNote: () => {},
        isOurs: (rid) => !runId || rid === runId,
        onItem: (item) => executionStore.handleActivityItem(item),
      });
      unlisten = await listen<MuseEventPayload>("muse-event", (ev) => {
        if (runId && ev.payload.run_id !== runId) return;
        const { text, note, terminal } = extractEvent(ev.payload.line);
        // Abschlussrecord wiederholt die Antwort: nur anhängen, wenn neu.
        if (text && !(terminal && assistantMsg.text.endsWith(text))) {
          assistantMsg.text += text;
          executionStore.assistant_delta(text);
          if (!writingNotedForRun) {
            writingNotedForRun = true;
            pushActivity({
              type: "status",
              title: "Writing response…",
              status: "running",
              taskState: "Running",
            });
          }
        }
        if (note && (assistantMsg.toolNotes?.length ?? 0) < 20) {
          assistantMsg.toolNotes?.push(note);
          // Fallback feed for lines the backend classifier skips.
          // The store dedups bursts with identical titles.
          const fb = noteToActivity(note);
          if (fb) {
            pushActivity({
              type: fb.type,
              title: fb.title,
              detail: fb.detail,
              status: "running",
              taskState: fb.taskState,
              file: fb.file,
            });
          }
        }
        // Batched: assistant text may stream token-fast; the store
        // batches activity separately via rAF.
        queueStreamingRender();
      });
      const id = await invoke<string>("send_prompt", {
        args: {
          prompt,
          workspace,
          images,
          model,
          reasoning_effort: effort,
          approval_mode: approvalEl.value,
          disable_approval: disableApprovalEl.checked,
          cli_path: cli,
        },
      });
      runId = id;
      // Backend emits "Task completed" itself; only fill the gap for
      // older backends or empty feeds.
      const items = taskActivityStore.getItems();
      const last = items[items.length - 1];
      if (!last || last.taskState !== "Completed") {
        pushActivity({
          type: "result",
          title: "Task completed",
          status: "success",
          taskState: "Completed",
          durationMs: Date.now() - t0,
        });
      } else {
        taskActivityStore.settleRunningAs("success");
        executionStore.task_completed();
      }
    } else {
      pushActivity({
        type: "status",
        title: "Analyzing request",
        status: "running",
        taskState: "Thinking",
      });
      assistantMsg.text =
        "Dev mode without Tauri: run `tauri dev` so the prompt reaches the Muse CLI.\n\nYour prompt was:\n```\n" +
        prompt +
        "\n```" +
        (images.length > 0 ? `\nImages: ${images.join(", ")}` : "") +
        `\nModel: ${model}, reasoning: ${effort}`;
      pushActivity({
        type: "result",
        title: "Task completed",
        status: "success",
        taskState: "Completed",
      });
    }
    setStatus("ready", "Ready", workspace);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assistantMsg.text += `\n\n[Error: ${msg}]`;
    const items = taskActivityStore.getItems();
    const last = items[items.length - 1];
    const alreadyTerminal =
      last &&
      (last.title === "Task stopped" ||
        last.title === "Task failed" ||
        last.title === "Task completed");
    if (!alreadyTerminal) {
      pushActivity({
        type: "result",
        title: msg.toLowerCase().includes("abbrechen") || msg.toLowerCase().includes("stop")
          ? "Task stopped"
          : "Task failed",
        detail: msg.slice(0, 200),
        status: "error",
        taskState: "Failed",
      });
    }
    setStatus("error", "Error", workspace);
  } finally {
    if (unlisten) unlisten();
    if (unActivity) unActivity();
    sending = false;
    sendBtn.disabled = false;
    composerMetaEl.textContent = "Ctrl+Enter to send";
    // Freeze a persistable copy (drops the live streamed-text mirror).
    const snap = executionStore.snapshot();
    if (snap) assistantMsg.exec = snap;
    persist();
    renderMessages();
    refreshTopbar();
    updateStopBtn();
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
        alert(`Could not save image: ${String(err)}`);
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
    cliStatusEl.textContent = "Web preview (no CLI)";
    return;
  }
  try {
    const st = await invoke<CliStatus>("check_cli", { cliPath: cliPath() || null });
    cliStatusEl.textContent = st.ok ? st.version : "CLI error";
    cliStatusEl.className = "brand-sub " + (st.ok ? "ok" : "bad");
    cliStatusEl.title = st.path;
    if (!cliPathEl.value) cliPathEl.placeholder = st.path;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    cliStatusEl.textContent = "muse CLI not found";
    cliStatusEl.className = "brand-sub bad";
    cliStatusEl.title = msg;
  }
}

const LS_PANEL = "muse-desktop.context-collapsed.v1";

function setPanelCollapsed(collapsed: boolean): void {
  document.getElementById("app")?.classList.toggle("context-collapsed", collapsed);
  try {
    localStorage.setItem(LS_PANEL, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

function openSettings(pane = "general"): void {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  for (const p of overlay.querySelectorAll<HTMLElement>(".set-pane")) {
    p.hidden = p.dataset.pane !== pane;
  }
  for (const b of overlay.querySelectorAll<HTMLElement>(".settings-nav")) {
    b.classList.toggle("sel", b.dataset.pane === pane);
  }
}

function closeSettings(): void {
  const overlay = document.getElementById("settings-overlay");
  if (overlay) overlay.hidden = true;
}

async function init(): Promise<void> {
  workspaceEl.value = localStorage.getItem(LS_WORKSPACE) ?? "";
  workspaceEl.addEventListener("change", () => {
    localStorage.setItem(LS_WORKSPACE, workspaceEl.value.trim());
    refreshTopbar();
  });
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
  function newChat(): void {
    const s: Session = { id: uid(), title: "New Task", createdAt: Date.now(), messages: [] };
    sessions.unshift(s);
    activeId = s.id;
    // A new task starts with an empty live feed.
    taskActivityStore.clear();
    persist();
    renderSessions();
    renderMessages();
    refreshTopbar();
    promptEl.focus();
  }
  newChatBtn.onclick = newChat;
  newChatBtn.title = "New Task (Ctrl+K)";
  const navProjects = document.getElementById("nav-projects");
  const navHistory = document.getElementById("nav-history");
  const navSettings = document.getElementById("nav-settings");
  const markNav = (active: HTMLElement | null) => {
    for (const b of [navProjects, navHistory, navSettings]) b?.classList.remove("active");
    active?.classList.add("active");
  };
  navProjects?.addEventListener("click", () => {
    markNav(navProjects as HTMLElement);
    openSettings("workspace");
  });
  navHistory?.addEventListener("click", () => {
    markNav(navHistory as HTMLElement);
    sessionSearchEl.focus();
  });
  navSettings?.addEventListener("click", () => {
    markNav(navSettings as HTMLElement);
    openSettings("general");
  });
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.getElementById("settings-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "settings-overlay") closeSettings();
  });
  document.querySelectorAll<HTMLElement>(".settings-nav").forEach((b) => {
    b.addEventListener("click", () => openSettings(b.dataset.pane ?? "general"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });
  const togglePanel = () => {
    const collapsed = !document.getElementById("app")?.classList.contains("context-collapsed");
    setPanelCollapsed(collapsed);
  };
  document.getElementById("context-toggle")?.addEventListener("click", togglePanel);
  document.getElementById("context-collapse")?.addEventListener("click", () => setPanelCollapsed(true));
  try {
    if (localStorage.getItem(LS_PANEL) === "1") setPanelCollapsed(true);
  } catch { /* ignore */ }
  modelBadgeEl.addEventListener("click", () => openSettings("models"));
  effortBadgeEl.addEventListener("click", () => openSettings("models"));
  const overflowBtn = document.getElementById("overflow-btn");
  const overflowMenu = document.getElementById("overflow-menu");
  overflowBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!overflowMenu) return;
    overflowMenu.hidden = !overflowMenu.hidden;
    overflowBtn.setAttribute("aria-expanded", String(!overflowMenu.hidden));
  });
  document.addEventListener("click", () => {
    if (overflowMenu && !overflowMenu.hidden) {
      overflowMenu.hidden = true;
      overflowBtn?.setAttribute("aria-expanded", "false");
    }
  });
  overflowMenu?.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((b) => {
    b.addEventListener("click", () => {
      const a = b.dataset.action;
      if (a === "new") newChat();
      else if (a === "panel") togglePanel();
      else if (a === "settings") openSettings("general");
    });
  });
  document.getElementById("run-log-clear")?.addEventListener("click", () => {
    taskActivityStore.clear();
    renderInspector();
  });
  stopBtn?.addEventListener("click", () => {
    if (!sending) return;
    stopBtn.disabled = true;
    pushActivity({
      type: "status",
      title: "Stopping task…",
      status: "running",
      taskState: "Waiting",
    });
    void (async () => {
      try {
        if (inTauri) await invoke<boolean>("cancel_run");
      } catch {
        /* run_exec reports the failure itself */
      } finally {
        // Re-enable so a stuck kill can be retried while the run winds down.
        if (stopBtn) stopBtn.disabled = false;
      }
    })();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (!sending) newChat();
    }
  });

  const savedApproval = localStorage.getItem(LS_APPROVAL);
  if (savedApproval && [...approvalEl.options].some((o) => o.value === savedApproval)) {
    approvalEl.value = savedApproval;
  }
  approvalEl.addEventListener("change", () =>
    localStorage.setItem(LS_APPROVAL, approvalEl.value)
  );
  disableApprovalEl.checked = localStorage.getItem(LS_DISABLE_APPROVAL) === "1";
  disableApprovalEl.addEventListener("change", () =>
    localStorage.setItem(LS_DISABLE_APPROVAL, disableApprovalEl.checked ? "1" : "0")
  );

  // Appearance: theme radio reflects the stored choice.
  const initialTheme = getThemeChoice();
  applyTheme(initialTheme);
  document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((r) => {
    r.checked = r.value === initialTheme;
    r.addEventListener("change", () => {
      if (r.checked) {
        applyTheme(r.value as "light" | "dark" | "system");
        // Persisted inside applyTheme; keep radios in sync across panes.
        document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((o) => {
          o.checked = o.value === r.value;
        });
      }
    });
  });
  // Live activity owns #run-log / #files-list; header falls back to the
  // session when idle (renderInspector). Localized + rAF-batched.
  mountTaskActivity({ isSending: () => sending });
  // Execution events patch the in-conversation exec block (rAF-batched via
  // queueStreamingRender); elapsed time ticks in place, never re-rendering.
  executionStore.subscribe(() => queueStreamingRender());
  startElapsedTicker();

  await checkCli();
  renderEffort();
  renderSessions();
  renderMessages();
  renderAttachments();
  refreshTopbar();
  setStatus("ready", "Ready", workspaceEl.value.trim() || "No folder selected");
  updateStopBtn();
  autogrow();
}

void init();
