// Localized activity store. Keeps TaskActivity state out of the global
// chat render path so frequent progress events only touch the inspector.

import type { ActivityItemData, TaskState } from "../components/activity/types";

type Listener = () => void;

const MAX_ITEMS = 80;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

class TaskActivityStore {
  private items: ActivityItemData[] = [];
  private taskState: TaskState = "Idle";
  private runId: string | null = null;
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const flush = () => {
      this.scheduled = false;
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch {
          /* listener errors must not break the feed */
        }
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  }

  /** Start a new run: clears history so the feed is live from this task. */
  startRun(runId?: string): void {
    this.items = [];
    this.taskState = "Thinking";
    this.runId = runId ?? uid();
    this.notify();
  }

  clear(): void {
    this.items = [];
    this.taskState = "Idle";
    this.runId = null;
    this.notify();
  }

  getRunId(): string | null {
    return this.runId;
  }

  getItems(): ActivityItemData[] {
    return this.items;
  }

  getState(): TaskState {
    return this.taskState;
  }

  /** Most recent running item, else the last item. Drives CurrentAction. */
  getCurrent(): ActivityItemData | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].status === "running") return this.items[i];
    }
    return this.items.length > 0 ? this.items[this.items.length - 1] : null;
  }

  getChangedFiles(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of this.items) {
      const cand = it.file ?? it.detail;
      if (!cand) continue;
      // Only file-like details (has an extension or a path separator).
      if (!/[./\\]/.test(cand)) continue;
      if (/^(npm|npx|cargo|node|python|exit|build|running|searching|planning|analyzing|inspecting|waiting)/i.test(cand.trim())) {
        continue;
      }
      if (!seen.has(cand)) {
        seen.add(cand);
        out.push(cand);
      }
    }
    return out.slice(-12);
  }

  push(raw: Omit<ActivityItemData, "id" | "timestamp"> & { id?: string; timestamp?: number }): ActivityItemData {
    const item: ActivityItemData = {
      ...raw,
      id: raw.id ?? uid(),
      timestamp: raw.timestamp ?? Date.now(),
    };
    // Dedup: same title+detail as the tail within 1.5s is one live update.
    const tail = this.items[this.items.length - 1];
    if (
      tail &&
      tail.title === item.title &&
      (tail.detail ?? "") === (item.detail ?? "") &&
      Math.abs(item.timestamp - tail.timestamp) < 1500
    ) {
      return tail;
    }
    // The newly started operation supersedes the previous running one.
    if (item.status === "running") {
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i].status === "running") {
          this.items[i] = { ...this.items[i], status: "success" };
          break;
        }
      }
    }
    // Terminal items settle any still-running predecessor.
    if (item.status === "success" || item.status === "error") {
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i].status === "running") {
          this.items[i] = { ...this.items[i], status: "success" };
        }
      }
    }
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) {
      this.items.splice(0, this.items.length - MAX_ITEMS);
    }
    if (item.taskState) this.taskState = item.taskState;
    else if (item.status === "error") this.taskState = "Running";
    this.notify();
    return item;
  }

  setState(s: TaskState): void {
    if (this.taskState === s) return;
    this.taskState = s;
    this.notify();
  }

  /** Mark every running item with a terminal status (e.g. on completion). */
  settleRunningAs(status: ActivityItemData["status"]): void {
    let changed = false;
    this.items = this.items.map((it) => {
      if (it.status === "running") {
        changed = true;
        return { ...it, status };
      }
      return it;
    });
    if (changed) this.notify();
  }
}

export const taskActivityStore = new TaskActivityStore();
