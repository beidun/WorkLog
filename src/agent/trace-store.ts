import type { WorklogDatabase } from "../db";
import { redactSecrets, stableId, truncate } from "../utils";
import type { AgentScope, AgentTraceStep } from "./worklog-agent";

export type AgentRunStatus = "running" | "completed" | "failed";

export interface AgentFailureRecord {
  scope: AgentScope;
  targetId: string;
  inputHash: string;
  provider: string;
  error: string;
  failedAt: string;
}

function runStatus(step: AgentTraceStep): AgentRunStatus {
  if (step.status === "failed") return "failed";
  return step.phase === "commit" && step.status === "completed" ? "completed" : "running";
}

export function persistAgentTrace(database: WorklogDatabase, step: AgentTraceStep): void {
  const db = database.db;
  const now = new Date().toISOString();
  const status = runStatus(step);
  db.query(`
    INSERT INTO agent_runs(id,session_id,scope,project_id,work_item_id,provider,status,attempts,started_at,ended_at,error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,project_id=excluded.project_id,work_item_id=excluded.work_item_id,status=excluded.status,attempts=MAX(agent_runs.attempts,excluded.attempts),
      ended_at=excluded.ended_at,error=excluded.error,updated_at=excluded.updated_at
  `).run(step.runId, step.sessionId ?? "", step.scope, step.projectId ?? null, step.workItemId ?? null, step.provider, status, step.attempt,
    step.at, status === "completed" || status === "failed" ? step.at : null,
    status === "failed" ? (truncate(redactSecrets(step.detail), 500) ?? "") : null, now, now);
  const ordinal = db.query("SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM agent_run_steps WHERE run_id=?").get(step.runId) as { next: number };
  db.query(`
    INSERT OR IGNORE INTO agent_run_steps(id,run_id,ordinal,phase,status,attempt,at,detail)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(stableId("agent-step", step.runId, ordinal.next), step.runId, ordinal.next, step.phase, step.status,
    step.attempt, step.at, truncate(redactSecrets(step.detail), 500) ?? "");
}

export function persistAgentFailure(database: WorklogDatabase, runId: string, sessionId: string | undefined, error: unknown, provider = "unknown", attempts = 0, scope: AgentScope = "session", projectId?: string, workItemId?: string): void {
  const now = new Date().toISOString();
  database.db.query(`
    INSERT INTO agent_runs(id,session_id,scope,project_id,work_item_id,provider,status,attempts,started_at,ended_at,error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,project_id=excluded.project_id,work_item_id=excluded.work_item_id,status='failed',attempts=MAX(agent_runs.attempts,excluded.attempts),ended_at=excluded.ended_at,error=excluded.error,updated_at=excluded.updated_at
  `).run(runId, sessionId ?? "", scope, projectId ?? null, workItemId ?? null, provider, "failed", attempts, now, now,
    truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 500) ?? "", now, now);
}

export function recordAgentFailure(database: WorklogDatabase, failure: Omit<AgentFailureRecord, "failedAt">): void {
  const failedAt = new Date().toISOString();
  database.db.query(`
    INSERT INTO agent_failures(scope,target_id,input_hash,provider,error,failed_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(scope,target_id) DO UPDATE SET input_hash=excluded.input_hash,provider=excluded.provider,error=excluded.error,failed_at=excluded.failed_at
  `).run(failure.scope, failure.targetId, failure.inputHash, failure.provider,
    truncate(redactSecrets(failure.error), 500) ?? "Agent failed", failedAt);
}

export function getAgentFailure(database: WorklogDatabase, scope: AgentScope, targetId: string): AgentFailureRecord | null {
  const row = database.db.query("SELECT scope,target_id,input_hash,provider,error,failed_at FROM agent_failures WHERE scope=? AND target_id=?").get(scope, targetId) as Record<string, unknown> | null;
  return row ? { scope: String(row.scope) as AgentScope, targetId: String(row.target_id), inputHash: String(row.input_hash), provider: String(row.provider), error: String(row.error), failedAt: String(row.failed_at) } : null;
}

export function clearAgentFailure(database: WorklogDatabase, scope: AgentScope, targetId: string): void {
  database.db.query("DELETE FROM agent_failures WHERE scope=? AND target_id=?").run(scope, targetId);
}

export function latestAgentRuns(database: WorklogDatabase, limit = 20): Array<Record<string, unknown>> {
  return database.db.query(`
    SELECT id,session_id,scope,project_id,work_item_id,provider,status,attempts,started_at,ended_at,error
    FROM agent_runs ORDER BY started_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;
}

export function agentRunDetails(database: WorklogDatabase, runId: string): { run: Record<string, unknown>; steps: Array<Record<string, unknown>> } | null {
  const run = database.db.query(`
    SELECT id,session_id,scope,project_id,work_item_id,provider,status,attempts,started_at,ended_at,error
    FROM agent_runs WHERE id=?
  `).get(runId) as Record<string, unknown> | null;
  if (!run) return null;
  const steps = database.db.query(`
    SELECT ordinal,phase,status,attempt,at,detail
    FROM agent_run_steps WHERE run_id=? ORDER BY ordinal
  `).all(runId) as Array<Record<string, unknown>>;
  return { run, steps };
}
