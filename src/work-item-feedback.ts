import type { WorkItemFeedbackType } from "./types";
import type { WorklogDatabase } from "./db";
import { normalizeWhitespace, stableId } from "./utils";

export const WORK_ITEM_FEEDBACK_TYPES: readonly WorkItemFeedbackType[] = [
  "accurate",
  "title_wrong",
  "split_needed",
  "merge_needed",
  "status_wrong",
  "summary_wrong",
  "citation_wrong",
];

export interface WorkItemFeedbackInput {
  type: WorkItemFeedbackType;
  note: string;
}

export interface StoredWorkItemFeedback extends WorkItemFeedbackInput {
  id: string;
  workItemId: string;
  anchorSessionId: string;
  sourceWorkItemId: string;
  createdAt: string;
  updatedAt: string;
}

function isFeedbackType(value: unknown): value is WorkItemFeedbackType {
  return typeof value === "string" && (WORK_ITEM_FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function parseWorkItemFeedback(value: unknown): WorkItemFeedbackInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("反馈内容格式错误");
  const input = value as Record<string, unknown>;
  if (!isFeedbackType(input.type)) throw new Error("反馈类型无效");
  if (input.note !== undefined && typeof input.note !== "string") throw new Error("反馈备注必须是文本");
  const note = normalizeWhitespace(String(input.note ?? ""));
  if (note.length > 1_000) throw new Error("反馈备注不能超过 1000 个字符");
  return { type: input.type, note };
}

function rowFeedback(row: Record<string, unknown>, workItemId: string): StoredWorkItemFeedback {
  return {
    id: String(row.id),
    workItemId,
    anchorSessionId: String(row.anchor_session_id),
    sourceWorkItemId: String(row.source_work_item_id),
    type: row.feedback_type as WorkItemFeedbackType,
    note: String(row.note ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function workItemSessionIds(database: WorklogDatabase, workItemId: string): string[] {
  return (database.db.query(`
    SELECT s.id FROM work_item_sessions wis JOIN sessions s ON s.id=wis.session_id
    WHERE wis.work_item_id=? ORDER BY COALESCE(s.started_at,s.ended_at,s.created_at),s.id
  `).all(workItemId) as Array<{ id: string }>).map((row) => row.id);
}

export function getWorkItemFeedback(database: WorklogDatabase, workItemId: string): StoredWorkItemFeedback[] {
  const sessionIds = workItemSessionIds(database, workItemId);
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = database.db.query(`
    SELECT * FROM work_item_feedback WHERE anchor_session_id IN (${placeholders}) ORDER BY updated_at DESC,feedback_type
  `).all(...sessionIds) as Array<Record<string, unknown>>;
  const seen = new Set<WorkItemFeedbackType>();
  const feedback = rows.filter((row) => {
    const type = row.feedback_type as WorkItemFeedbackType;
    if (seen.has(type)) return false;
    seen.add(type);
    return true;
  }).map((row) => rowFeedback(row, workItemId));
  if (feedback[0]?.type === "accurate") return feedback.slice(0, 1);
  return feedback.filter((entry) => entry.type !== "accurate");
}

export function saveWorkItemFeedback(database: WorklogDatabase, workItemId: string, input: WorkItemFeedbackInput): StoredWorkItemFeedback {
  if (!database.db.query("SELECT id FROM work_items WHERE id=?").get(workItemId)) throw new Error("工作事项不存在");
  const sessionIds = workItemSessionIds(database, workItemId);
  if (sessionIds.length === 0) throw new Error("工作事项没有可关联的对话");
  const placeholders = sessionIds.map(() => "?").join(",");
  const anchorSessionId = sessionIds[0]!;
  const now = new Date().toISOString();
  const existing = database.db.query(`
    SELECT * FROM work_item_feedback WHERE anchor_session_id IN (${placeholders}) AND feedback_type=? ORDER BY updated_at DESC LIMIT 1
  `).get(...sessionIds, input.type) as Record<string, unknown> | null;
  const feedback: StoredWorkItemFeedback = {
    id: stableId("work-item-feedback", anchorSessionId, input.type),
    workItemId,
    anchorSessionId,
    sourceWorkItemId: workItemId,
    ...input,
    createdAt: existing ? String(existing.created_at) : now,
    updatedAt: now,
  };
  database.db.transaction(() => {
    database.db.query(`DELETE FROM work_item_feedback WHERE anchor_session_id IN (${placeholders}) AND feedback_type=?`)
      .run(...sessionIds, input.type);
    const conflictingTypes = input.type === "accurate" ? WORK_ITEM_FEEDBACK_TYPES.filter((type) => type !== "accurate") : ["accurate"];
    const conflicts = conflictingTypes.map(() => "?").join(",");
    database.db.query(`DELETE FROM work_item_feedback WHERE anchor_session_id IN (${placeholders}) AND feedback_type IN (${conflicts})`)
      .run(...sessionIds, ...conflictingTypes);
    database.db.query(`
      INSERT INTO work_item_feedback(id,anchor_session_id,source_work_item_id,feedback_type,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(feedback.id, feedback.anchorSessionId, feedback.sourceWorkItemId, input.type, input.note, feedback.createdAt, feedback.updatedAt);
  })();
  return feedback;
}

export function clearWorkItemFeedback(database: WorklogDatabase, workItemId: string, type: WorkItemFeedbackType): number {
  const sessionIds = workItemSessionIds(database, workItemId);
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => "?").join(",");
  return database.db.query(`DELETE FROM work_item_feedback WHERE anchor_session_id IN (${placeholders}) AND feedback_type=?`)
    .run(...sessionIds, type).changes;
}

export interface ReviewQueueItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  summary: string;
  status: string;
  confidence: number;
  lastActivityAt: string | null;
  feedback: StoredWorkItemFeedback[];
}

export function getReviewQueue(database: WorklogDatabase, limit?: number): ReviewQueueItem[] {
  const query = `
    SELECT wi.id,wi.project_id,p.name AS project_name,wi.title,wi.summary,wi.status,wi.confidence,wi.last_activity_at
    FROM work_items wi JOIN projects p ON p.id=wi.project_id
    ORDER BY CASE WHEN EXISTS (
      SELECT 1 FROM work_item_sessions wis JOIN work_item_feedback f ON f.anchor_session_id=wis.session_id WHERE wis.work_item_id=wi.id
    ) THEN 1 ELSE 0 END,
      wi.last_activity_at DESC,wi.id${limit === undefined ? "" : " LIMIT ?"}
  `;
  const rows = (limit === undefined ? database.db.query(query).all() : database.db.query(query).all(limit)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    title: String(row.title),
    summary: String(row.summary),
    status: String(row.status),
    confidence: Number(row.confidence ?? 0),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
    feedback: getWorkItemFeedback(database, String(row.id)),
  }));
}
