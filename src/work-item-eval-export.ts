import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { EventType, WorkItemFeedbackType, WorkStatus } from "./types";
import type { WorklogDatabase } from "./db";
import { getWorkItemCorrection } from "./work-item-corrections";
import { getWorkItemFeedback, type StoredWorkItemFeedback } from "./work-item-feedback";
import { redactSecrets, stripInjectedContext, truncate } from "./utils";

interface WorkItemRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  summary: string;
  status: WorkStatus;
  confidence: number;
  next_step: string | null;
  last_activity_at: string | null;
}

interface ScopeRow {
  session_id: string;
  ordinal: number | null;
  start_line: number | null;
  end_line: number | null;
  objective: string | null;
}

interface EventRow {
  id: string;
  session_id: string;
  source: string;
  event_type: EventType;
  role: "user" | "assistant" | null;
  timestamp: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  content: string | null;
  command: string | null;
  file_paths_json: string;
  is_error: number;
  source_line: number;
  metadata_json: string;
}

export interface WorkItemEvalEvent {
  id: string;
  type: EventType;
  role?: "user" | "assistant";
  content?: string;
  command?: string;
  toolName?: string;
  toolCallId?: string;
  filePaths?: string[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
  source?: string;
  sourceLine?: number;
}

export interface WorkItemEvalExpected {
  title?: string;
  summary?: string;
  status?: WorkStatus;
  nextStep?: string;
  splitNeeded?: boolean;
  mergeNeeded?: boolean;
  feedbackTypes: WorkItemFeedbackType[];
}

export interface WorkItemEvalCase {
  id: string;
  project: string;
  description: string;
  reviewed: boolean;
  feedback: Array<Pick<StoredWorkItemFeedback, "type" | "note" | "updatedAt">>;
  segments: Array<{ ordinal: number; startLine: number; endLine: number; objective: string }>;
  events: WorkItemEvalEvent[];
  prediction: { title: string; summary: string; status: WorkStatus; nextStep: string; confidence: number; evidenceEventIds: string[] };
  expected: WorkItemEvalExpected;
}

export interface WorkItemEvalSuite {
  version: 1;
  generatedAt: string;
  reviewedOnly: boolean;
  cases: WorkItemEvalCase[];
}

function safeText(value: string | null | undefined, max = 6_000): string | undefined {
  if (!value) return undefined;
  const normalized = stripInjectedContext(redactSecrets(value.replaceAll(homedir(), "$HOME")));
  return truncate(normalized, max) || undefined;
}

function safeMetadata(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const phase = typeof parsed.phase === "string" ? parsed.phase : undefined;
    return phase ? { phase } : undefined;
  } catch {
    return undefined;
  }
}

function safeFilePaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string")
      .map((item) => item.replaceAll(homedir(), "$HOME"))
      .map((item) => item.startsWith("$HOME/") ? basename(item) : item)
      .map((item) => item.replaceAll("\\", "/"))
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function scopesFor(database: WorklogDatabase, workItemId: string): ScopeRow[] {
  const segments = database.db.query(`
    SELECT ws.session_id,ws.ordinal,ws.start_line,ws.end_line,ws.objective
    FROM work_item_segments wis JOIN work_segments ws ON ws.id=wis.segment_id
    WHERE wis.work_item_id=? ORDER BY ws.ordinal,ws.id
  `).all(workItemId) as ScopeRow[];
  if (segments.length > 0) return segments;
  return (database.db.query(`
    SELECT wis.session_id,NULL AS ordinal,NULL AS start_line,NULL AS end_line,NULL AS objective
    FROM work_item_sessions wis WHERE wis.work_item_id=? ORDER BY wis.session_id
  `).all(workItemId) as ScopeRow[]);
}

function eventsFor(database: WorklogDatabase, scopes: ScopeRow[]): EventRow[] {
  const events: EventRow[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const rows = database.db.query(`
      SELECT e.id,e.session_id,e.source,e.event_type,e.role,e.timestamp,e.tool_name,e.tool_call_id,e.content,e.command,
        e.file_paths_json,e.is_error,e.source_line,e.metadata_json
      FROM events e WHERE e.session_id=?
        AND (? IS NULL OR e.source_line>=?) AND (? IS NULL OR e.source_line<=?)
      ORDER BY e.source_line,e.id LIMIT 220
    `).all(scope.session_id, scope.start_line, scope.start_line, scope.end_line, scope.end_line) as EventRow[];
    for (const event of rows) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  return events.sort((left, right) => left.source_line - right.source_line || left.id.localeCompare(right.id)).slice(0, 240);
}

function feedbackExpected(database: WorklogDatabase, item: WorkItemRow, feedback: StoredWorkItemFeedback[]): WorkItemEvalExpected {
  const types = feedback.map((entry) => entry.type);
  const correction = getWorkItemCorrection(database, item.id);
  return {
    ...(types.includes("title_wrong") && correction ? { title: correction.title } : {}),
    ...(types.includes("summary_wrong") && correction ? { summary: correction.summary } : {}),
    ...(types.includes("status_wrong") && correction ? { status: correction.status } : {}),
    ...(types.includes("accurate") ? { title: item.title, summary: item.summary, status: item.status, nextStep: item.next_step ?? "" } : {}),
    ...(types.includes("split_needed") ? { splitNeeded: true } : {}),
    ...(types.includes("merge_needed") ? { mergeNeeded: true } : {}),
    feedbackTypes: types,
  };
}

export function buildWorkItemEvalSuite(database: WorklogDatabase, options: { reviewedOnly?: boolean } = {}): WorkItemEvalSuite {
  const reviewedOnly = options.reviewedOnly ?? true;
  const rows = database.db.query(`
    SELECT wi.id,wi.project_id,p.name AS project_name,wi.title,wi.summary,wi.status,wi.confidence,wi.next_step,wi.last_activity_at
    FROM work_items wi JOIN projects p ON p.id=wi.project_id
    ${reviewedOnly ? `WHERE EXISTS (
      SELECT 1 FROM work_item_sessions wis JOIN work_item_feedback f ON f.anchor_session_id=wis.session_id WHERE wis.work_item_id=wi.id
    )` : ""}
    ORDER BY wi.last_activity_at DESC,wi.id
  `).all() as WorkItemRow[];
  const cases: WorkItemEvalCase[] = [];
  for (const item of rows) {
    const feedback = getWorkItemFeedback(database, item.id);
    const scopes = scopesFor(database, item.id);
    const rawEvents = eventsFor(database, scopes);
    const eventIds = new Map(rawEvents.map((event, index) => [event.id, `event-${index + 1}`]));
    const events = rawEvents.map((event) => ({
      id: eventIds.get(event.id)!,
      type: event.event_type,
      ...(event.role ? { role: event.role } : {}),
      ...(safeText(event.content) ? { content: safeText(event.content) } : {}),
      ...(safeText(event.command) ? { command: safeText(event.command, 2_000) } : {}),
      ...(event.tool_name ? { toolName: event.tool_name } : {}),
      ...(event.tool_call_id ? { toolCallId: event.tool_call_id } : {}),
      ...(safeFilePaths(event.file_paths_json).length ? { filePaths: safeFilePaths(event.file_paths_json) } : {}),
      ...(event.is_error ? { isError: true } : {}),
      ...(safeMetadata(event.metadata_json) ? { metadata: safeMetadata(event.metadata_json) } : {}),
      source: event.source,
      sourceLine: event.source_line,
    } satisfies WorkItemEvalEvent));
    const evidenceIds = (database.db.query("SELECT event_id FROM work_item_evidence WHERE work_item_id=? ORDER BY event_id")
      .all(item.id) as Array<{ event_id: string }>).map((entry) => eventIds.get(entry.event_id)).filter((id): id is string => Boolean(id));
    cases.push({
      id: `work-item-${item.id}`,
      project: item.project_name,
      description: `${item.project_name}：${item.title}`,
      reviewed: feedback.length > 0,
      feedback: feedback.map((entry) => ({ type: entry.type, note: entry.note, updatedAt: entry.updatedAt })),
      segments: scopes.filter((scope): scope is ScopeRow & { ordinal: number; start_line: number; end_line: number; objective: string } =>
        scope.ordinal !== null && scope.start_line !== null && scope.end_line !== null && scope.objective !== null)
        .map((scope) => ({ ordinal: scope.ordinal, startLine: scope.start_line, endLine: scope.end_line, objective: scope.objective })),
      events,
      prediction: { title: item.title, summary: item.summary, status: item.status, nextStep: item.next_step ?? "", confidence: item.confidence, evidenceEventIds: evidenceIds },
      expected: feedbackExpected(database, item, feedback),
    });
  }
  return { version: 1, generatedAt: new Date().toISOString(), reviewedOnly, cases };
}

export function exportWorkItemEvalSuite(database: WorklogDatabase, outputPath: string, options: { reviewedOnly?: boolean } = {}): { path: string; caseCount: number } {
  const suite = buildWorkItemEvalSuite(database, options);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(suite, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return { path: outputPath, caseCount: suite.cases.length };
}

export function defaultWorkItemEvalPath(dataDir: string): string {
  return join(dataDir, "evals", "work-items.json");
}
