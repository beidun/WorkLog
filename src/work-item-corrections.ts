import type { WorklogDatabase } from "./db";
import type { WorkStatus } from "./types";
import { normalizeWhitespace, stableId } from "./utils";

const WORK_STATUSES = new Set<WorkStatus>([
  "planned", "in_progress", "partially_done", "done_unverified", "verified", "blocked", "abandoned",
]);

export interface WorkItemCorrectionInput {
  title: string;
  summary: string;
  status: WorkStatus;
  nextStep: string;
}

export interface StoredWorkItemCorrection extends WorkItemCorrectionInput {
  id: string;
  anchorSessionId: string;
  sourceWorkItemId: string;
  createdAt: string;
  updatedAt: string;
}

function boundedString(value: unknown, name: string, maximum: number, required = false): string {
  if (typeof value !== "string") throw new Error(`${name}必须是文本`);
  const normalized = normalizeWhitespace(value);
  if (required && !normalized) throw new Error(`${name}不能为空`);
  if (normalized.length > maximum) throw new Error(`${name}不能超过 ${maximum} 个字符`);
  return normalized;
}

export function parseWorkItemCorrection(value: unknown): WorkItemCorrectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("纠正内容格式错误");
  const input = value as Record<string, unknown>;
  const status = input.status;
  if (typeof status !== "string" || !WORK_STATUSES.has(status as WorkStatus)) throw new Error("事项状态无效");
  return {
    title: boundedString(input.title, "事项标题", 120, true),
    summary: boundedString(input.summary, "进展摘要", 2_000),
    status: status as WorkStatus,
    nextStep: boundedString(input.nextStep, "下一步", 1_000),
  };
}

function rowCorrection(row: Record<string, unknown>): StoredWorkItemCorrection {
  return {
    id: String(row.id),
    anchorSessionId: String(row.anchor_session_id),
    sourceWorkItemId: String(row.source_work_item_id),
    title: String(row.title),
    summary: String(row.summary),
    status: row.status as WorkStatus,
    nextStep: String(row.next_step),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function loadWorkItemCorrections(database: WorklogDatabase): Map<string, StoredWorkItemCorrection> {
  const rows = database.db.query("SELECT * FROM work_item_corrections ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => {
    const correction = rowCorrection(row);
    return [correction.anchorSessionId, correction];
  }));
}

function workItemSessions(database: WorklogDatabase, workItemId: string): Array<{ id: string; started_at: string | null; ended_at: string | null; created_at: string }> {
  return database.db.query(`
    SELECT s.id,s.started_at,s.ended_at,s.created_at
    FROM work_item_sessions wis JOIN sessions s ON s.id=wis.session_id
    WHERE wis.work_item_id=?
    ORDER BY COALESCE(s.started_at,s.ended_at,s.created_at),s.id
  `).all(workItemId) as Array<{ id: string; started_at: string | null; ended_at: string | null; created_at: string }>;
}

export function getWorkItemCorrection(database: WorklogDatabase, workItemId: string): StoredWorkItemCorrection | null {
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) return null;
  const placeholders = sessions.map(() => "?").join(",");
  const row = database.db.query(`
    SELECT * FROM work_item_corrections WHERE anchor_session_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1
  `).get(...sessions.map((session) => session.id)) as Record<string, unknown> | null;
  return row ? rowCorrection(row) : null;
}

export function saveWorkItemCorrection(database: WorklogDatabase, workItemId: string, input: WorkItemCorrectionInput): StoredWorkItemCorrection {
  const item = database.db.query("SELECT id FROM work_items WHERE id=?").get(workItemId);
  if (!item) throw new Error("工作事项不存在");
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) throw new Error("工作事项没有可关联的对话");

  const sessionIds = sessions.map((session) => session.id);
  const anchorSessionId = sessionIds[0]!;
  const now = new Date().toISOString();
  const existing = getWorkItemCorrection(database, workItemId);
  const correction: StoredWorkItemCorrection = {
    id: stableId("work-item-correction", anchorSessionId),
    anchorSessionId,
    sourceWorkItemId: workItemId,
    ...input,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const placeholders = sessionIds.map(() => "?").join(",");
  database.db.transaction(() => {
    database.db.query(`DELETE FROM work_item_corrections WHERE anchor_session_id IN (${placeholders})`).run(...sessionIds);
    database.db.query(`
      INSERT INTO work_item_corrections(id,anchor_session_id,source_work_item_id,title,summary,status,next_step,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(correction.id,correction.anchorSessionId,correction.sourceWorkItemId,correction.title,correction.summary,
      correction.status,correction.nextStep,correction.createdAt,correction.updatedAt);
    database.db.query("UPDATE work_items SET title=?,summary=?,status=?,next_step=?,updated_at=? WHERE id=?")
      .run(correction.title,correction.summary,correction.status,correction.nextStep,now,workItemId);
  })();
  return correction;
}

export function clearWorkItemCorrection(database: WorklogDatabase, workItemId: string): number {
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) throw new Error("工作事项不存在");
  const sessionIds = sessions.map((session) => session.id);
  const placeholders = sessionIds.map(() => "?").join(",");
  const result = database.db.query(`DELETE FROM work_item_corrections WHERE anchor_session_id IN (${placeholders})`).run(...sessionIds);
  return Number(result.changes);
}
