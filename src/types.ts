export type AgentSource = "codex" | "claude_code";

export type EventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "task_started"
  | "task_completed"
  | "task_aborted";

export type WorkStatus =
  | "planned"
  | "in_progress"
  | "partially_done"
  | "done_unverified"
  | "verified"
  | "blocked"
  | "abandoned";

export interface SessionSeed {
  source: AgentSource;
  externalId: string;
  parentExternalId?: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  gitCommit?: string;
  gitRemote?: string;
  startedAt?: string;
  endedAt?: string;
  isSubagent: boolean;
  sourceFile: string;
}

export interface CanonicalEvent {
  id: string;
  source: AgentSource;
  sessionExternalId: string;
  type: EventType;
  role?: "user" | "assistant";
  timestamp?: string;
  toolName?: string;
  toolCallId?: string;
  content?: string;
  command?: string;
  cwd?: string;
  filePaths?: string[];
  isError?: boolean;
  sourceFile: string;
  sourceLine: number;
  rawHash: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedRecord {
  session?: SessionSeed;
  event?: CanonicalEvent;
  title?: { source: AgentSource; sessionExternalId: string; title: string };
}

export interface ScanStats {
  filesDiscovered: number;
  filesScanned: number;
  filesSkipped: number;
  sessionsUpserted: number;
  eventsUpserted: number;
  eventsFiltered: number;
  errors: number;
  startedAt: string;
  finishedAt?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  git_remote: string | null;
  last_activity_at: string | null;
}
