// Prominent current-action line: "Muse is working… / <action>".
// Updates immediately when a new operation starts; never shows reasoning.

import { taskActivityStore } from "../../stores/taskActivityStore";
import type { TaskState } from "./types";

const STATE_LABEL: Record<TaskState, string> = {
  Idle: "Idle",
  Thinking: "Thinking",
  Reading: "Reading",
  Searching: "Searching",
  Editing: "Editing",
  Running: "Running",
  Waiting: "Waiting",
  Completed: "Completed",
  Failed: "Failed",
};

export function currentActionText(isSending: boolean): { title: string; sub: string } {
  const current = taskActivityStore.getCurrent();
  const state = taskActivityStore.getState();
  if (!isSending && !current) {
    return { title: "No active task", sub: "Start a new task to begin…" };
  }
  if (current) {
    const dot = stateLabel(state);
    if (state === "Completed") return { title: "✓ Task completed", sub: current.title };
    if (state === "Failed" && current.status === "error") {
      return { title: `✕ ${current.title}`, sub: current.detail ?? "See activity for details" };
    }
    return { title: `● ${dot} — ${current.title}`, sub: current.detail ?? "Muse is working…" };
  }
  if (isSending) {
    if (state === "Thinking") return { title: "● Thinking — Planning next step…", sub: "Muse is working…" };
    return { title: `● ${stateLabel(state)}`, sub: "Muse is working…" };
  }
  return { title: "No active task", sub: "Start a new task to begin…" };
}

function stateLabel(s: TaskState): string {
  return STATE_LABEL[s] ?? s;
}

export function renderCurrentAction(
  titleEl: HTMLElement,
  subEl: HTMLElement,
  dotEl: Element | null,
  spinner: HTMLElement | null,
  isSending: boolean,
): void {
  const { title, sub } = currentActionText(isSending);
  titleEl.textContent = title;
  subEl.textContent = sub;
  if (dotEl) {
    const state = taskActivityStore.getState();
    dotEl.className =
      "task-dot " +
      (state === "Completed"
        ? "done"
        : state === "Failed"
          ? "failed"
          : state === "Waiting"
            ? "waiting"
            : state === "Idle"
              ? "idle"
              : "active");
  }
  if (spinner) spinner.hidden = !isSending;
}
