// Binds Tauri streaming events to the activity store + chat streaming.
// Structured `muse://task-activity` events render immediately. The legacy
// `muse-event` line stream still drives assistant text; tool-like notes are
// mirrored into the store as a fallback so the feed stays live even for
// lines the backend classifier skips. No polling.

import { listen } from "@tauri-apps/api/event";
import { taskActivityStore } from "../stores/taskActivityStore";
import { normalizeActivity, type ActivityItemData } from "../components/activity/types";

export interface StreamCallbacks {
  runId: string | null;
  onText: (text: string, terminal: boolean) => void;
  onNote: (note: string) => void;
  isOurs: (runId: string) => boolean;
  /** Live bridge: every structured backend item also feeds the execution store. */
  onItem?: (item: ActivityItemData) => void;
}

function baseOf(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Fallback: human-readable activity from a legacy tool note (no raw dump). */
export function noteToActivity(note: string):
  | { title: string; detail?: string; taskState: "Reading" | "Searching" | "Editing" | "Running" | "Thinking" | "Waiting"; type: "file" | "tool" | "command" | "status"; file?: string }
  | null {
  const low = note.toLowerCase();
  // Extract a path-like token for file details when present.
  const m = note.match(/([A-Za-z0-9_@-]+[/\\][\w\-./\\@]+(?:\.\w{1,5})?|[\w\-./]+\.(tsx?|jsx?|rs|py|json|md|toml|css|html))/);
  const path = m?.[1];
  if (/read/.test(low) && path) {
    return { title: `Reading ${baseOf(path)}`, detail: path, taskState: "Reading", type: "file", file: path };
  }
  if (/edit|writ|appl|updat/.test(low) && path) {
    return { title: `Editing ${baseOf(path)}`, detail: path, taskState: "Editing", type: "file", file: path };
  }
  if (/search|grep|glob|find/.test(low)) {
    return { title: note.length < 60 ? note : "Searching project", detail: path, taskState: "Searching", type: "tool" };
  }
  if (/inspect|struct|list/.test(low)) {
    return { title: "Inspecting project structure", taskState: "Reading", type: "status" };
  }
  if (/build/.test(low)) {
    return { title: note.toLowerCase().includes("success") ? "Build completed" : "Running build", detail: path ?? "npm run build", taskState: "Running", type: "command", file: undefined };
  }
  if (/run|exec|test|npm|cargo/.test(low)) {
    return { title: note.length < 60 ? note : "Running command", detail: path, taskState: "Running", type: "command" };
  }
  if (/plan/.test(low)) {
    return { title: "Planning next step…", taskState: "Thinking", type: "status" };
  }
  if (/wait|approv/.test(low)) {
    return { title: "Waiting for approval", taskState: "Waiting", type: "status" };
  }
  if (/fail|error/.test(low)) {
    return { title: note.length < 80 ? note : "Step reported an error", detail: path, taskState: "Running", type: "tool" };
  }
  return null;
}

export async function listenTaskActivity(cb: StreamCallbacks): Promise<() => void> {
  const unlistens: (() => void)[] = [];
  try {
    const offActivity = await listen<Record<string, unknown>>("muse://task-activity", (ev) => {
      const item = normalizeActivity(ev.payload ?? {});
      if (!item) return;
      if (item.runId && !cb.isOurs(item.runId)) return;
      const stored = taskActivityStore.push({
        id: item.id,
        type: item.type,
        title: item.title,
        detail: item.detail,
        status: item.status,
        timestamp: item.timestamp,
        taskState: item.taskState,
        file: item.file,
        operation: item.operation,
        command: item.command,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        rawKind: item.rawKind,
        runId: item.runId,
      });
      cb.onItem?.(stored);
    });
    unlistens.push(offActivity);
  } catch {
    /* Web preview without Tauri: structured events unavailable. */
  }
  return () => {
    for (const off of unlistens) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  };
}
