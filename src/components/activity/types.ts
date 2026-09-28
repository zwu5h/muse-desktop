// Shared structured activity types. Mirrors the backend ActivityEvent
// (src-tauri/src/main.rs). Titles are user-facing; raw reasoning is never
// carried in these fields.

export type TaskState =
  | "Idle"
  | "Thinking"
  | "Reading"
  | "Searching"
  | "Editing"
  | "Running"
  | "Waiting"
  | "Completed"
  | "Failed";

export type ActivityEventType = "status" | "tool" | "file" | "command" | "result";

export type ActivityStatus = "pending" | "running" | "success" | "error";

export interface ActivityItemData {
  id: string;
  type: ActivityEventType;
  title: string;
  detail?: string;
  status: ActivityStatus;
  timestamp: number;
  taskState?: TaskState;
  file?: string;
  operation?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  added?: number;
  removed?: number;
  /** Internal envelope kind — only shown under expandable "Details". */
  rawKind?: string;
  runId?: string;
}

export function isActivityItem(v: unknown): v is ActivityItemData {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    (o.type === "status" ||
      o.type === "tool" ||
      o.type === "file" ||
      o.type === "command" ||
      o.type === "result")
  );
}

export function normalizeActivity(
  raw: Record<string, unknown>,
  fallbackRunId?: string,
): ActivityItemData | null {
  if (!isActivityItem(raw)) return null;
  const type = raw.type as ActivityEventType;
  const status =
    raw.status === "pending" ||
    raw.status === "running" ||
    raw.status === "success" ||
    raw.status === "error"
      ? raw.status
      : "running";
  const validStates: TaskState[] = [
    "Idle",
    "Thinking",
    "Reading",
    "Searching",
    "Editing",
    "Running",
    "Waiting",
    "Completed",
    "Failed",
  ];
  const taskState =
    typeof raw.taskState === "string" &&
    (validStates as string[]).includes(raw.taskState)
      ? (raw.taskState as TaskState)
      : typeof raw.task_state === "string" &&
          (validStates as string[]).includes(raw.task_state as string)
        ? (raw.task_state as TaskState)
        : undefined;
  return {
    id: String(raw.id),
    type,
    title: String(raw.title).slice(0, 160),
    detail:
      typeof raw.detail === "string" ? raw.detail.slice(0, 260) : undefined,
    status,
    timestamp:
      typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : Date.now(),
    taskState,
    file: typeof raw.file === "string" ? raw.file.slice(0, 260) : undefined,
    operation:
      typeof raw.operation === "string"
        ? raw.operation.slice(0, 120)
        : undefined,
    command:
      typeof raw.command === "string"
        ? raw.command.slice(0, 260)
        : undefined,
    exitCode:
      typeof raw.exitCode === "number"
        ? raw.exitCode
        : typeof raw.exit_code === "number"
          ? (raw.exit_code as number)
          : undefined,
    durationMs:
      typeof raw.durationMs === "number"
        ? raw.durationMs
        : typeof raw.duration_ms === "number"
          ? (raw.duration_ms as number)
          : undefined,
    rawKind:
      typeof raw.rawKind === "string"
        ? raw.rawKind
        : typeof raw.raw_kind === "string"
          ? String(raw.raw_kind)
          : undefined,
    runId:
      typeof raw.runId === "string"
        ? raw.runId
        : typeof raw.run_id === "string"
          ? String(raw.run_id)
          : fallbackRunId,
  };
}
