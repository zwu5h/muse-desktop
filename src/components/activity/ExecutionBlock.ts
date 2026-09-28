// In-conversation live execution block (Codex-like density).
//
// Rendered inside the assistant message that immediately follows the user
// message — exactly where the eventual response belongs. Updates live via
// re-render from the execution store; elapsed time ticks in place without
// a re-render (see `startElapsedTicker`).
//
// Layout:
//   <status line: current activity + animated dots + elapsed>
//   <chronological tool rows>
//   <toggle: "N tool calls">
// Collapsing hides settled rows; the running row stays visible.

import { formatElapsed, type ExecSnapshot } from "./executionStore";

export type ExecView = ExecSnapshot & { streamedText?: string };

/** Rewrite only the elapsed spans (no re-render, preserves toggle state). */
export function startElapsedTicker(): void {
  if (document.querySelector("[data-exec-ticker]")) return;
  const marker = document.createElement("span");
  marker.dataset.execTicker = "1";
  marker.hidden = true;
  document.body.appendChild(marker);
  const update = () => {
    const now = Date.now();
    for (const el of document.querySelectorAll<HTMLElement>("[data-exec-elapsed]")) {
      const started = Number(el.dataset.execElapsed);
      const ended = el.dataset.execEnded ? Number(el.dataset.execEnded) : undefined;
      if (!Number.isFinite(started)) continue;
      el.textContent = formatElapsed(started, ended ?? now);
    }
  };
  update();
  setInterval(update, 500);
}

function glyphFor(status: string): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✕";
  return "›";
}

export function renderExecutionBlock(
  host: HTMLElement,
  task: ExecView,
  opts: { live: boolean; onToggle?: (collapsed: boolean) => void },
): void {
  host.innerHTML = "";
  host.className = "exec" + (opts.live ? " live" : "") + (task.collapsed ? " collapsed" : "");
  host.dataset.taskId = task.taskId;

  const running = task.state === "running";

  const status = document.createElement("div");
  status.className = "exec-status";
  const activity = document.createElement("span");
  activity.className = "exec-activity";
  activity.textContent = task.currentActivity;
  status.appendChild(activity);
  if (running) {
    const dots = document.createElement("span");
    dots.className = "exec-dots";
    dots.setAttribute("aria-hidden", "true");
    status.appendChild(dots);
  }
  const elapsed = document.createElement("span");
  elapsed.className = "exec-elapsed";
  elapsed.dataset.execElapsed = String(task.startedAt);
  if (task.endedAt !== undefined) elapsed.dataset.execEnded = String(task.endedAt);
  elapsed.title = running ? "Elapsed time" : "Total time";
  elapsed.textContent = formatElapsed(task.startedAt, task.endedAt ?? Date.now());
  status.appendChild(elapsed);
  host.appendChild(status);

  if (task.toolCalls.length > 0) {
    const list = document.createElement("ul");
    list.className = "exec-tools";
    for (const tool of task.toolCalls) {
      const li = document.createElement("li");
      const settled = tool.status !== "running";
      li.className = "exec-tool " + (settled ? tool.status : "running");
      const glyph = document.createElement("span");
      glyph.className = "t-glyph";
      glyph.textContent = glyphFor(tool.status);
      glyph.setAttribute("aria-hidden", "true");
      li.appendChild(glyph);
      const texts = document.createElement("span");
      texts.className = "t-texts";
      if (tool.status === "running") {
        const line = document.createElement("span");
        line.className = "t-line";
        line.textContent = tool.title;
        line.title = tool.detail ?? tool.title;
        texts.appendChild(line);
      } else {
        const kind = document.createElement("span");
        kind.className = "t-kind";
        kind.textContent = tool.kind;
        texts.appendChild(kind);
        if (tool.detail) {
          const detail = document.createElement("span");
          detail.className = "t-detail";
          detail.textContent = tool.detail;
          detail.title = tool.detail;
          texts.appendChild(detail);
        }
      }
      li.appendChild(texts);
      list.appendChild(li);
    }
    host.appendChild(list);

    const toggle = document.createElement("button");
    toggle.className = "exec-toggle";
    toggle.type = "button";
    const paint = () => {
      const collapsed = host.classList.contains("collapsed");
      const n = task.toolCalls.length;
      toggle.textContent = `${collapsed ? "›" : "▾"} ${n} tool ${n === 1 ? "call" : "calls"}`;
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };
    paint();
    toggle.onclick = () => {
      const next = !host.classList.contains("collapsed");
      host.classList.toggle("collapsed", next);
      paint();
      opts.onToggle?.(next);
    };
    host.appendChild(toggle);
  }
}
