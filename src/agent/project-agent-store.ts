import type { WorklogDatabase } from "../db";
import type { ProjectAgentDecision } from "./project-agent";
import { safeJson, redactSecrets, truncate } from "../utils";

export function saveProjectAgentDecision(database: WorklogDatabase, decision: ProjectAgentDecision): void {
  const now = new Date().toISOString();
  const safeList = (values: string[]): string[] => [...new Set(
    values.slice(0, 6).map((value) => truncate(redactSecrets(value), 240) ?? "").filter(Boolean),
  )];
  const nextSteps = decision.nextSteps.slice(0, 5).map((step) => ({
    text: truncate(redactSecrets(step.text), 240) ?? "",
    ...(step.workItemId ? { workItemId: step.workItemId } : {}),
  })).filter((step) => step.text.length > 0);
  database.db.query(`
    INSERT INTO project_agent_decisions(project_id,input_hash,headline,summary,stage,completed_json,validations_json,blockers_json,remaining_json,evidence_ids_json,next_steps_json,provider,confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET input_hash=excluded.input_hash,headline=excluded.headline,summary=excluded.summary,
      stage=excluded.stage,completed_json=excluded.completed_json,validations_json=excluded.validations_json,
      blockers_json=excluded.blockers_json,remaining_json=excluded.remaining_json,evidence_ids_json=excluded.evidence_ids_json,next_steps_json=excluded.next_steps_json,
      provider=excluded.provider,confidence=excluded.confidence,updated_at=excluded.updated_at
  `).run(decision.projectId, decision.inputHash,
    truncate(redactSecrets(decision.headline), 180) ?? "项目进度",
    truncate(redactSecrets(decision.summary), 600) ?? "",
    decision.stage, safeJson(safeList(decision.completed)), safeJson(safeList(decision.validations)), safeJson(safeList(decision.blockers)), safeJson(safeList(decision.remaining)),
    safeJson(decision.evidenceIds.slice(0, 8)), safeJson(nextSteps),
    decision.provider, decision.confidence, now, now);
}

export function getProjectAgentDecision(database: WorklogDatabase, projectId: string): (ProjectAgentDecision & { updatedAt: string }) | null {
  const row = database.db.query(`
    SELECT project_id,input_hash,headline,summary,stage,completed_json,validations_json,blockers_json,remaining_json,evidence_ids_json,next_steps_json,provider,confidence,updated_at
    FROM project_agent_decisions WHERE project_id=?
  `).get(projectId) as Record<string, unknown> | null;
  if (!row) return null;
  const parse = (value: unknown): unknown[] => { try { return JSON.parse(String(value ?? "[]")) as unknown[]; } catch { return []; } };
  return {
    projectId: String(row.project_id), inputHash: String(row.input_hash), headline: String(row.headline), summary: String(row.summary),
    completed: parse(row.completed_json).filter((item): item is string => typeof item === "string"),
    validations: parse(row.validations_json).filter((item): item is string => typeof item === "string"),
    blockers: parse(row.blockers_json).filter((item): item is string => typeof item === "string"),
    remaining: parse(row.remaining_json).filter((item): item is string => typeof item === "string"),
    stage: String(row.stage) as ProjectAgentDecision["stage"], evidenceIds: parse(row.evidence_ids_json).filter((id): id is string => typeof id === "string"),
    nextSteps: parse(row.next_steps_json).filter((item): item is { text: string; workItemId?: string } => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string")),
    provider: String(row.provider), confidence: Number(row.confidence ?? 0), updatedAt: String(row.updated_at),
  };
}

/**
 * Read-side guard for project narratives. The runtime invalidates decisions
 * during scans, but evidence can also change through a correction or a
 * recovery/import path. Never expose a decision that cites an event outside
 * the project or predates the project's latest activity.
 */
export function currentProjectAgentDecision(database: WorklogDatabase, projectId: string): (ProjectAgentDecision & { updatedAt: string }) | null {
  const decision = getProjectAgentDecision(database, projectId);
  if (!decision || decision.evidenceIds.length === 0) return null;
  const placeholders = decision.evidenceIds.map(() => "?").join(",");
  const linked = database.db.query(`
    SELECT COUNT(DISTINCT e.id) AS count
    FROM events e JOIN work_item_evidence wie ON wie.event_id=e.id
    JOIN work_items wi ON wi.id=wie.work_item_id
    WHERE wi.project_id=? AND e.id IN (${placeholders})
  `).get(projectId, ...decision.evidenceIds) as { count: number };
  if (Number(linked?.count ?? 0) !== new Set(decision.evidenceIds).size) return null;
  const latest = database.db.query("SELECT MAX(last_activity_at) AS latest FROM work_items WHERE project_id=?").get(projectId) as { latest: string | null };
  if (latest?.latest && Date.parse(decision.updatedAt) < Date.parse(latest.latest)) return null;
  return decision;
}
