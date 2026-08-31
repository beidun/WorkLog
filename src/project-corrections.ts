import type { WorklogDatabase } from "./db";
import { normalizeWhitespace, stableId } from "./utils";

export interface StoredProjectCorrection {
  id: string;
  anchorSessionId: string;
  sourceWorkItemId: string;
  sourceProjectId: string;
  targetProjectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCorrectionInput {
  projectId: string;
}

function rowCorrection(row: Record<string, unknown>): StoredProjectCorrection {
  return {
    id: String(row.id),
    anchorSessionId: String(row.anchor_session_id),
    sourceWorkItemId: String(row.source_work_item_id),
    sourceProjectId: String(row.source_project_id),
    targetProjectId: String(row.target_project_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseProjectCorrection(value: unknown): ProjectCorrectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目归属纠正格式错误");
  const projectId = (value as Record<string, unknown>).projectId;
  if (typeof projectId !== "string" || !normalizeWhitespace(projectId)) throw new Error("目标项目无效");
  if (projectId.length > 200) throw new Error("目标项目无效");
  return { projectId: normalizeWhitespace(projectId) };
}

export function loadProjectCorrections(database: WorklogDatabase): Map<string, StoredProjectCorrection> {
  const rows = database.db.query("SELECT * FROM project_corrections ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => {
    const correction = rowCorrection(row);
    return [correction.anchorSessionId, correction];
  }));
}

function workItemSessions(database: WorklogDatabase, workItemId: string): Array<{ id: string; project_id: string }> {
  return database.db.query(`
    SELECT s.id,s.project_id
    FROM work_item_sessions wis JOIN sessions s ON s.id=wis.session_id
    WHERE wis.work_item_id=? AND s.is_subagent=0
    ORDER BY COALESCE(s.started_at,s.ended_at,s.created_at),s.id
  `).all(workItemId) as Array<{ id: string; project_id: string }>;
}

export function getProjectCorrection(database: WorklogDatabase, workItemId: string): StoredProjectCorrection | null {
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) return null;
  const placeholders = sessions.map(() => "?").join(",");
  const row = database.db.query(`
    SELECT * FROM project_corrections
    WHERE anchor_session_id IN (${placeholders})
    ORDER BY updated_at DESC LIMIT 1
  `).get(...sessions.map((session) => session.id)) as Record<string, unknown> | null;
  return row ? rowCorrection(row) : null;
}

export function saveProjectCorrection(database: WorklogDatabase, workItemId: string, input: ProjectCorrectionInput): StoredProjectCorrection {
  const item = database.db.query("SELECT id,project_id FROM work_items WHERE id=?").get(workItemId) as { id: string; project_id: string } | null;
  if (!item) throw new Error("工作事项不存在");
  const target = database.db.query("SELECT id FROM projects WHERE id=?").get(input.projectId) as { id: string } | null;
  if (!target) throw new Error("目标项目不存在");
  if (target.id === item.project_id) throw new Error("目标项目与当前项目相同");
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) throw new Error("工作事项没有可关联的对话");

  const anchorSessionId = sessions[0]!.id;
  const now = new Date().toISOString();
  const existing = getProjectCorrection(database, workItemId);
  const correction: StoredProjectCorrection = {
    id: stableId("work-item-project-correction", anchorSessionId),
    anchorSessionId,
    sourceWorkItemId: workItemId,
    sourceProjectId: existing?.sourceProjectId ?? item.project_id,
    targetProjectId: target.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const placeholders = sessions.map(() => "?").join(",");
  database.db.transaction(() => {
    database.db.query(`DELETE FROM project_corrections WHERE anchor_session_id IN (${placeholders})`).run(...sessions.map((session) => session.id));
    database.db.query(`
      INSERT INTO project_corrections(id,anchor_session_id,source_work_item_id,source_project_id,target_project_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(correction.id, correction.anchorSessionId, correction.sourceWorkItemId, correction.sourceProjectId,
      correction.targetProjectId, correction.createdAt, correction.updatedAt);
    database.db.query("UPDATE work_items SET project_id=?,updated_at=? WHERE id=?").run(target.id, now, workItemId);
  })();
  return correction;
}

export function clearProjectCorrection(database: WorklogDatabase, workItemId: string): number {
  const sessions = workItemSessions(database, workItemId);
  if (sessions.length === 0) throw new Error("工作事项不存在");
  const placeholders = sessions.map(() => "?").join(",");
  const result = database.db.query(`DELETE FROM project_corrections WHERE anchor_session_id IN (${placeholders})`)
    .run(...sessions.map((session) => session.id));
  return Number(result.changes);
}
