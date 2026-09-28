// Live execution state for the in-conversation assistant execution block.
//
// Event-sourced model. The backend (src-tauri/src/main.rs) streams
// structured `muse://task-activity` items; this store normalizes them into
// explicit execution events — no derived or invented reasoning text:
//
//   task_started      a new assistant turn begins execution
//   status_changed    latest active action changed (real backend title)
//   tool_started      a tool/file/command step began (chronological row)
//   tool_completed    a step finished successfully
//   tool_failed       a step reported an error (run continues)
//   assistant_delta   streamed assistant text appended
//   task_completed    terminal success
//   task_failed       terminal failure / stop
//
// Only observable backend titles become `currentActivity` or tool rows.
// Elapsed time is derived from `startedAt` (see `formatElapsed`).

import type { ActivityItemData } from "./types";

export type ExecutionLifecycle = "running" | "completed" | "failed";
export type ToolCallStatus = "running" | "completed" | "error";

export interface ToolCall {
  id: string;
  /** Action type: "Read" | "Edit" | "Search" | "Run" | ... */
  kind: string;
  /** Short description (backend title, e.g. "Reading App.tsx"). */
  title: string;
  /** Filename / command. */
  detail?: string;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
}

/** Persistable per-message execution snapshot (stored on ChatMessage.exec). */
export interface ExecSnapshot {
  taskId: string;
  status: string;
  currentActivity: string;
  startedAt: number;
  endedAt?: number;
  toolCalls: ToolCall[];
  state: ExecutionLifecycle;
  collapsed: boolean;
  error?: string;
}

export interface ActiveTask extends ExecSnapshot {
  streamedText: string;
}

type Listener = () => void;

const MAX_TOOLS = 80;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** "3s", "1m 04s", "2h 03m" — derived from startedAt, no stored clock. */
export function formatElapsed(startedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Action type for a tool row, derived from the structured item only. */
export function toolKindFor(item: ActivityItemData): string {
  const op = (item.operation ?? "").trim();
  if (item.type === "file") {
    if (item.taskState === "Editing") return "Edit";
    if (item.taskState === "Reading") return "Read";
    return "File";
  }
  if (item.type === "command") return "Run";
  if (op) return op.charAt(0).toUpperCase() + op.slice(1);
  return "Tool";
}

function toolDetailFor(item: ActivityItemData): string | undefined {
  return item.file ?? item.command ?? item.detail;
}

function isTerminalTitle(title: string): "completed" | "failed" | null {
  const t = title.toLowerCase();
  if (t.includes("task completed")) return "completed";
  if (t.includes("task failed") || t.includes("task stopped") || t.includes("cancelled")) {
    return "failed";
  }
  return null;
}

class ExecutionStore {
  private tasks = new Map<string, ActiveTask>();
  private activeId: string | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* listener errors must not break the live feed */
      }
    }
  }

  /** task_started — begins a new live execution. */
  task_started(taskId?: string): ActiveTask {
    const task: ActiveTask = {
      taskId: taskId ?? uid(),
      status: "Thinking",
      currentActivity: "Analyzing request",
      startedAt: Date.now(),
      toolCalls: [],
      streamedText: "",
      state: "running",
      collapsed: false,
    };
    this.tasks.set(task.taskId, task);
    this.activeId = task.taskId;
    // Finished messages hold detached snapshots, so settled tasks can go —
    // always keep running ones (a previous run may still stream).
    const settled = [...this.tasks.values()]
      .filter((t) => t.state !== "running" && t.taskId !== task.taskId)
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const old of settled.slice(20)) this.tasks.delete(old.taskId);
    this.notify();
    return task;
  }

  getTask(taskId: string): ActiveTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  getActive(): ActiveTask | null {
    return this.activeId ? (this.tasks.get(this.activeId) ?? null) : null;
  }

  /** status_changed — latest active action (must be a real backend title). */
  status_changed(activity: string, status?: string): void {
    const task = this.getActive();
    if (!task || task.state !== "running") return;
    const next = activity.trim().slice(0, 160);
    if (!next) return;
    if (task.currentActivity !== next) task.currentActivity = next;
    if (status) task.status = status;
    this.notify();
  }

  /** tool_started — appends a chronological tool row. */
  tool_started(input: {
    id?: string;
    kind: string;
    title: string;
    detail?: string;
  }): ToolCall {
    const task = this.getActive();
    const now = Date.now();
    const tool: ToolCall = {
      id: input.id ?? uid(),
      kind: input.kind.slice(0, 40),
      title: input.title.slice(0, 160),
      detail: input.detail?.slice(0, 260),
      status: "running",
      startedAt: now,
    };
    if (!task || task.state !== "running") return tool;
    const tail = task.toolCalls[task.toolCalls.length - 1];
    if (
      tail &&
      tail.status === "running" &&
      tail.title === tool.title &&
      (tail.detail ?? "") === (tool.detail ?? "") &&
      now - tail.startedAt < 1500
    ) {
      return tail;
    }
    task.toolCalls.push(tool);
    if (task.toolCalls.length > MAX_TOOLS) {
      task.toolCalls.splice(0, task.toolCalls.length - MAX_TOOLS);
    }
    this.notify();
    return tool;
  }

  private settleTools(status: ToolCallStatus, id?: string): void {
    const task = this.getActive();
    if (!task) return;
    const now = Date.now();
    if (id) {
      const tool = task.toolCalls.find((t) => t.id === id);
      if (tool && tool.status === "running") {
        tool.status = status;
        tool.endedAt = now;
      }
      return;
    }
    for (const t of task.toolCalls) {
      if (t.status === "running") {
        t.status = status;
        t.endedAt = now;
      }
    }
  }

  /** tool_completed — marks one (or all running) step(s) done. */
  tool_completed(id?: string): void {
    this.settleTools("completed", id);
    this.notify();
  }

  /** tool_failed — marks a step errored; the run itself continues. */
  tool_failed(id?: string): void {
    this.settleTools("error", id);
    this.notify();
  }

  /** assistant_delta — mirrors streamed assistant text into the task. */
  assistant_delta(text: string): void {
    const task = this.getActive();
    if (!task || task.state !== "running" || !text) return;
    task.streamedText += text;
    this.notify();
  }

  /** task_completed — terminal success; freezes activity + elapsed. */
  task_completed(): void {
    const task = this.getActive();
    if (!task || task.state !== "running") return;
    this.settleTools("completed");
    task.state = "completed";
    task.status = "Completed";
    task.endedAt = Date.now();
    this.notify();
  }

  /** task_failed — terminal failure / stop; freezes activity + elapsed. */
  task_failed(error?: string): void {
    const task = this.getActive();
    if (!task || task.state !== "running") return;
    this.settleTools("error");
    task.state = "failed";
    task.status = "Failed";
    task.endedAt = Date.now();
    if (error) task.error = error.slice(0, 260);
    this.notify();
  }

  /**
   * Bridge: folds one structured backend ActivityEvent into execution
   * events. `status`-type items only move the current activity line;
   * `tool`/`file`/`command` items additionally open a tool row;
   * `result`-type items settle tools and close the task on terminal
   * titles only — mid-run error results become error rows, never a
   * task failure.
   */
  handleActivityItem(item: ActivityItemData): void {
    const task = this.getActive();
    if (!task || task.state !== "running") return;
    if (item.type === "result") {
      const terminal = isTerminalTitle(item.title);
      if (terminal === "completed") {
        this.task_completed();
        return;
      }
      if (terminal === "failed") {
        this.task_failed(item.detail);
        return;
      }
      if (item.status === "error") {
        // The in-flight step did not demonstrably succeed: fail it, then
        // record the reported error as its own row. The run continues.
        this.settleTools("error");
        this.tool_started({
          id: item.id,
          kind: "Step",
          title: item.title,
          detail: toolDetailFor(item),
        });
        this.tool_failed(item.id);
      } else {
        this.settleTools("completed");
        this.notify();
      }
      return;
    }
    this.status_changed(item.title, item.taskState);
    if (item.type === "tool" || item.type === "file" || item.type === "command") {
      // The newly started step supersedes the previous running row.
      this.settleTools("completed");
      this.tool_started({
        id: item.id,
        kind: toolKindFor(item),
        title: item.title,
        detail: toolDetailFor(item),
      });
    }
  }

  setCollapsed(taskId: string, collapsed: boolean): void {
    const task = this.tasks.get(taskId);
    if (!task || task.collapsed === collapsed) return;
    task.collapsed = collapsed;
    this.notify();
  }

  /** Plain persistable copy for ChatMessage.exec (drops streamedText). */
  snapshot(taskId?: string): ExecSnapshot | null {
    const task = taskId ? this.tasks.get(taskId) : this.getActive();
    if (!task) return null;
    return {
      taskId: task.taskId,
      status: task.status,
      currentActivity: task.currentActivity,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      toolCalls: task.toolCalls.map((t) => ({ ...t })),
      state: task.state,
      collapsed: task.collapsed,
      error: task.error,
    };
  }

  clear(): void {
    this.tasks.clear();
    this.activeId = null;
    this.notify();
  }
}

export const executionStore = new ExecutionStore();
