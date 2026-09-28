// Compact live activity feed bound to the right inspector panel.
// Subscribes to the store (batched via rAF in the store) and only touches
// inspector DOM — the chat list is never re-rendered per progress event.

import { taskActivityStore } from "../../stores/taskActivityStore";
import { renderActivityItem } from "./ActivityItem";
import { renderCurrentAction } from "./CurrentAction";

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 1.5h7l3 3V14.5H3z"/><path d="M10 1.5v3h3"/></svg>';
const CODE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3L2.5 8 6 13M10 3l3.5 5L10 13"/></svg>';

function shortName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function mountTaskActivity(opts: { isSending: () => boolean }): () => void {
  const titleEl = document.getElementById("current-task-title");
  const subEl = document.getElementById("current-task-sub");
  const logEl = document.getElementById("run-log");
  const filesEl = document.getElementById("files-list");
  if (!titleEl || !subEl || !logEl || !filesEl) return () => {};

  const render = () => {
    const sending = opts.isSending();
    const dot = document.querySelector(".task-dot");
    const spinner = document.getElementById("task-spinner");
    renderCurrentAction(titleEl, subEl, dot, spinner, sending);

    // History stays until the task ends (store cleared on next send).
    const items = taskActivityStore.getItems();
    logEl.innerHTML = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "log-empty";
      li.textContent = sending ? "Starting…" : "Nothing yet";
      logEl.appendChild(li);
    } else {
      for (const it of items.slice(-12)) {
        const li = document.createElement("li");
        li.className = "act-slot";
        renderActivityItem(li, it);
        logEl.appendChild(li);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }

    // Files changed (from structured events) + pending image attachments.
    const changed = taskActivityStore.getChangedFiles();
    const seenFiles = new Set(changed);
    for (const chip of document.querySelectorAll("#attachments .chip span")) {
      const t = chip.textContent?.trim();
      if (t && !seenFiles.has(t)) {
        seenFiles.add(t);
        changed.push(t);
      }
    }
    filesEl.innerHTML = "";
    if (changed.length === 0) {
      const li = document.createElement("li");
      li.className = "log-empty";
      li.textContent = "No changes yet";
      filesEl.appendChild(li);
    } else {
      for (const f of changed.slice(-12)) {
        const li = document.createElement("li");
        const icon = document.createElement("span");
        icon.className = "f-icon";
        const name = shortName(f);
        const isCode = /\.(tsx?|jsx?|rs|py|json|md|toml|css|html)$/i.test(name);
        icon.innerHTML = isCode ? CODE_ICON : FILE_ICON;
        const label = document.createElement("span");
        label.textContent = name;
        label.title = f;
        li.append(icon, label);
        filesEl.appendChild(li);
      }
    }
  };

  const unsub = taskActivityStore.subscribe(render);
  render();
  return unsub;
}
