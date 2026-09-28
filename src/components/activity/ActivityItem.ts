// Renders one activity entry as a collapsible row.
// Collapsed: icon + title. Expanded (<details>): file/operation/command,
// exit code, duration, and the internal envelope kind under "Details".

import type { ActivityItemData } from "./types";

function statusGlyph(status: ActivityItemData["status"]): string {
  if (status === "success") return "✓";
  if (status === "error") return "✕";
  if (status === "pending") return "○";
  return "●";
}

function fmtDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderActivityItem(li: HTMLLIElement, item: ActivityItemData): void {
  li.className = "act-item " + item.status;
  li.dataset.id = item.id;
  li.innerHTML = "";

  const details = document.createElement("details");
  details.className = "act-details";

  const summary = document.createElement("summary");
  summary.className = "act-summary";

  const glyph = document.createElement("span");
  glyph.className = "act-glyph " + item.status;
  glyph.textContent = statusGlyph(item.status);
  glyph.setAttribute("aria-hidden", "true");

  const texts = document.createElement("span");
  texts.className = "act-texts";
  const title = document.createElement("span");
  title.className = "act-title";
  title.textContent = item.title;
  texts.appendChild(title);
  if (item.detail) {
    const detail = document.createElement("span");
    detail.className = "act-detail";
    detail.textContent = item.detail;
    detail.title = item.detail;
    texts.appendChild(detail);
  }

  const time = document.createElement("time");
  time.className = "log-time";
  time.dateTime = new Date(item.timestamp).toISOString();
  time.textContent = new Date(item.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  summary.append(glyph, texts, time);
  details.appendChild(summary);

  if (item.file || item.operation || item.command || item.exitCode !== undefined || item.durationMs !== undefined || item.rawKind) {
    const body = document.createElement("div");
    body.className = "act-body";
    const rows: [string, string][] = [];
    if (item.file) rows.push(["File", item.file]);
    if (item.operation) rows.push(["Operation", item.operation]);
    if (item.command) rows.push(["Command", item.command]);
    if (item.added !== undefined || item.removed !== undefined) {
      const changes = `+${item.added ?? 0} −${item.removed ?? 0}`;
      rows.push(["Changes", changes]);
    }
    if (item.exitCode !== undefined) rows.push(["Exit code", String(item.exitCode)]);
    const dur = fmtDuration(item.durationMs);
    if (dur) rows.push(["Duration", dur]);
    // Raw envelope kind lives here only — never as a title.
    if (item.rawKind) rows.push(["Details", item.rawKind]);
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.className = "act-row";
      const kk = document.createElement("span");
      kk.className = "act-k";
      kk.textContent = k;
      const vv = document.createElement("span");
      vv.className = "act-v";
      vv.textContent = v;
      vv.title = v;
      row.append(kk, vv);
      body.appendChild(row);
    }
    details.appendChild(body);
  }

  li.appendChild(details);
}
