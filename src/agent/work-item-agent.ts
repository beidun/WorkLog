import type { WorklogDatabase } from "../db";
import type { WorklogModelProvider, SessionDigestResult } from "../llm/provider";
import type { ProjectProgressItem } from "../services";
import { redactSecrets, safeJson, sha256, stableId, truncate } from "../utils";
import { WorklogAgent, type AgentTraceStep } from "./worklog-agent";
import { clearAgentFailure, getAgentFailure, persistAgentFailure, recordAgentFailure } from "./trace-store";

export interface WorkItemAgentEvidence {
  id: string;
  kind: string;
  text: string;
  timestamp?: string;
  isError?: boolean;
}

export interface WorkItemAgentInput {
  workItemId: string;
  projectId: string;
  projectName: string;
  item: ProjectProgressItem;
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  evidence: WorkItemAgentEvidence[];
}

export interface WorkItemAgentDecision {
  workItemId: string;
  projectId: string;
  inputHash: string;
  title: string;
  summary: string;
  status: SessionDigestResult["status"];
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  nextStep: string;
  evidenceIds: string[];
  provider: string;
  confidence: number;
  traceSessionId?: string;
}

export function workItemAgentInputHash(input: WorkItemAgentInput): string {
  return sha256([
    "work-item-agent-v1",
    input.workItemId,
    input.projectId,
    input.projectName,
    ...input.completed,
    ...input.validations,
    ...input.blockers,
    ...input.remaining,
    ...input.evidence.map((event) => `${event.id}:${event.kind}:${event.timestamp ?? ""}:${event.isError ? "error" : "ok"}:${event.text}`),
  ].join("\n"));
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mergeLists(rows: Array<{ value: string }>): string[] {
  return [...new Set(rows.flatMap((row) => parseList(row.value)))].slice(-6);
}

function itemEvidence(database: WorklogDatabase, workItemId: string): WorkItemAgentEvidence[] {
  return database.db.query(`
    SELECT DISTINCT e.id,e.event_type AS kind,
      COALESCE(NULLIF(e.content,''),NULLIF(e.command,''),e.tool_name,e.event_type) AS text,
      e.timestamp,e.is_error
    FROM work_item_evidence wie JOIN events e ON e.id=wie.event_id
    WHERE wie.work_item_id=?
    ORDER BY e.timestamp ASC,e.source_line ASC,e.id ASC
  `).all(workItemId).map((row) => {
    const event = row as { id: string; kind: string; text: string; timestamp: string | null; is_error: number };
    return { id: event.id, kind: event.kind, text: event.text, timestamp: event.timestamp ?? undefined, isError: event.is_error === 1 };
  });
}

function segmentFacts(database: WorklogDatabase, workItemId: string): { completed: string[]; validations: string[]; blockers: string[]; remaining: string[] } {
  const rows = database.db.query(`
    SELECT ws.completed_json AS completed,ws.validations_json AS validations,ws.blockers_json AS blockers,ws.remaining_json AS remaining
    FROM work_item_segments wis JOIN work_segments ws ON ws.id=wis.segment_id
    WHERE wis.work_item_id=? ORDER BY ws.last_event_at ASC,ws.id ASC
  `).all(workItemId) as Array<{ completed: string; validations: string; blockers: string; remaining: string }>;
  return {
    completed: mergeLists(rows.map((row) => ({ value: row.completed }))),
    validations: mergeLists(rows.map((row) => ({ value: row.validations }))),
    blockers: mergeLists(rows.map((row) => ({ value: row.blockers }))),
    remaining: mergeLists(rows.map((row) => ({ value: row.remaining }))),
  };
}

export function buildWorkItemAgentInput(database: WorklogDatabase, row: ProjectProgressItem & { projectId: string; projectName: string }): WorkItemAgentInput {
  const facts = segmentFacts(database, row.id);
  return {
    workItemId: row.id,
    projectId: row.projectId,
    projectName: row.projectName,
    item: row,
    ...facts,
    evidence: itemEvidence(database, row.id),
  };
}

export class WorkItemAgent {
  constructor(private readonly provider: WorklogModelProvider, private readonly onTrace?: (step: AgentTraceStep) => void, private readonly traceSessionId?: string) {}

  async run(input: WorkItemAgentInput): Promise<WorkItemAgentDecision> {
    if (input.evidence.length === 0) throw new Error("Work Item Agent requires at least one evidence event");
    const result = await new WorklogAgent(this.provider, {
      onTrace: this.onTrace,
      scope: "work_item",
      projectId: input.projectId,
      workItemId: input.workItemId,
    }).run({
      sessionId: this.traceSessionId,
      projectName: input.projectName,
      objective: input.item.title,
      baseline: {
        headline: input.item.title,
        progressSummary: input.item.summary || "当前事项已有真实事件证据。",
        completed: input.completed,
        validations: input.validations,
        blockers: input.blockers,
        remaining: input.remaining,
        status: input.item.status as SessionDigestResult["status"],
        nextStep: input.item.nextStep,
        openTurn: false,
      },
      events: input.evidence,
    });
    const model = result.result;
    const itemConfidence = Math.max(0.4, Math.min(1, input.item.confidence));
    const evidenceCoverage = Math.min(1, model.evidenceIds.length / Math.min(8, input.evidence.length));
    return {
      workItemId: input.workItemId,
      projectId: input.projectId,
      inputHash: workItemAgentInputHash(input),
      title: model.headline,
      summary: model.progressSummary,
      status: model.status,
      completed: model.completed,
      validations: model.validations,
      blockers: model.blockers,
      remaining: model.remaining,
      nextStep: model.nextStep,
      evidenceIds: model.evidenceIds,
      provider: this.provider.name,
      confidence: Math.round(Math.min(0.96, Math.max(0.72, itemConfidence * 0.7 + evidenceCoverage * 0.2 + 0.1)) * 100) / 100,
      traceSessionId: this.traceSessionId,
    };
  }
}

export interface WorkItemAgentRunStats {
  enhanced: number;
  fallback: number;
  skipped: number;
  deferred: number;
  manual: number;
}

interface StoredDecision extends WorkItemAgentDecision { updatedAt: string }

function parseStored(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export function getWorkItemAgentDecision(database: WorklogDatabase, workItemId: string): StoredDecision | null {
  const row = database.db.query("SELECT * FROM work_item_agent_decisions WHERE work_item_id=?").get(workItemId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    workItemId: String(row.work_item_id), projectId: String(row.project_id), inputHash: String(row.input_hash),
    title: String(row.title), summary: String(row.summary), status: String(row.status) as StoredDecision["status"],
    completed: parseStored(row.completed_json), validations: parseStored(row.validations_json), blockers: parseStored(row.blockers_json), remaining: parseStored(row.remaining_json),
    nextStep: String(row.next_step ?? ""), evidenceIds: parseStored(row.evidence_ids_json), provider: String(row.provider), confidence: Number(row.confidence ?? 0),
    traceSessionId: row.trace_session_id ? String(row.trace_session_id) : undefined, updatedAt: String(row.updated_at),
  };
}

/** Return a cached decision only when its evidence and segment facts still match the current item. */
export function currentWorkItemAgentDecision(database: WorklogDatabase, workItemId: string): StoredDecision | null {
  const decision = getWorkItemAgentDecision(database, workItemId);
  if (!decision) return null;
  const current = database.db.query(`
    SELECT wi.id,wi.project_id AS projectId,p.name AS projectName,wi.title,wi.summary,wi.status,wi.next_step AS nextStep,wi.last_activity_at AS lastActivityAt,wi.confidence,
      (SELECT COUNT(*) FROM work_item_evidence wie WHERE wie.work_item_id=wi.id) AS evidenceCount
    FROM work_items wi JOIN projects p ON p.id=wi.project_id WHERE wi.id=?
  `).get(workItemId) as (ProjectProgressItem & { projectId: string; projectName: string }) | null;
  if (!current) return null;
  const input = buildWorkItemAgentInput(database, current);
  // Protect the read path as well as the write path. A manually edited or
  // partially migrated row must never make the UI render an untraceable model
  // citation, even when its input hash happens to match.
  const evidence = new Set(input.evidence.map((event) => event.id));
  if (decision.evidenceIds.some((id) => !evidence.has(id))) return null;
  return workItemAgentInputHash(input) === decision.inputHash ? decision : null;
}

function safeList(values: string[]): string[] {
  return [...new Set(values.slice(0, 6).map((value) => truncate(redactSecrets(value), 240) ?? "").filter(Boolean))];
}

export function saveWorkItemAgentDecision(database: WorklogDatabase, decision: WorkItemAgentDecision): void {
  const now = new Date().toISOString();
  database.db.query(`
    INSERT INTO work_item_agent_decisions(work_item_id,project_id,input_hash,title,summary,status,completed_json,validations_json,blockers_json,remaining_json,next_step,evidence_ids_json,provider,confidence,trace_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(work_item_id) DO UPDATE SET project_id=excluded.project_id,input_hash=excluded.input_hash,title=excluded.title,summary=excluded.summary,status=excluded.status,
      completed_json=excluded.completed_json,validations_json=excluded.validations_json,blockers_json=excluded.blockers_json,remaining_json=excluded.remaining_json,next_step=excluded.next_step,
      evidence_ids_json=excluded.evidence_ids_json,provider=excluded.provider,confidence=excluded.confidence,trace_session_id=excluded.trace_session_id,updated_at=excluded.updated_at
  `).run(decision.workItemId, decision.projectId, decision.inputHash, truncate(redactSecrets(decision.title), 180) ?? "工作事项", truncate(redactSecrets(decision.summary), 600) ?? "",
    decision.status, safeJson(safeList(decision.completed)), safeJson(safeList(decision.validations)), safeJson(safeList(decision.blockers)), safeJson(safeList(decision.remaining)),
    truncate(redactSecrets(decision.nextStep), 240) ?? "", safeJson(decision.evidenceIds.slice(0, 8)), decision.provider, decision.confidence, decision.traceSessionId ?? null, now, now);
}

export function applyWorkItemAgentDecision(database: WorklogDatabase, decision: WorkItemAgentDecision): void {
  database.db.query(`
    UPDATE work_items SET title=?,summary=?,status=?,confidence=?,next_step=?,updated_at=? WHERE id=?
  `).run(decision.title, decision.summary, decision.status, decision.confidence, decision.nextStep, new Date().toISOString(), decision.workItemId);
}

function hasManualCorrection(database: WorklogDatabase, workItemId: string): boolean {
  return Boolean(database.db.query(`SELECT 1 FROM work_item_corrections c JOIN work_item_sessions wis ON wis.session_id=c.anchor_session_id WHERE wis.work_item_id=? LIMIT 1`).get(workItemId));
}

export async function runWorkItemAgents(database: WorklogDatabase, provider: WorklogModelProvider, options: {
  maxWorkItems?: number;
  retryFailed?: boolean;
  agentMaxAttempts?: number;
  agentRetryDelayMs?: number;
  onTrace?: (step: AgentTraceStep) => void;
} = {}): Promise<WorkItemAgentRunStats> {
  const rows = database.db.query(`
    SELECT wi.id,wi.project_id AS projectId,p.name AS projectName,wi.title,wi.summary,wi.status,wi.next_step AS nextStep,wi.last_activity_at AS lastActivityAt,wi.confidence,
      (SELECT COUNT(*) FROM work_item_evidence wie WHERE wie.work_item_id=wi.id) AS evidenceCount
    FROM work_items wi JOIN projects p ON p.id=wi.project_id
    WHERE (SELECT COUNT(*) FROM work_item_evidence wie WHERE wie.work_item_id=wi.id)>0
    ORDER BY CASE wi.status WHEN 'blocked' THEN 0 WHEN 'done_unverified' THEN 1 WHEN 'partially_done' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'planned' THEN 4 ELSE 5 END,
      wi.last_activity_at DESC,wi.id
  `).all() as Array<ProjectProgressItem & { projectId: string; projectName: string }>;
  const stats: WorkItemAgentRunStats = { enhanced: 0, fallback: 0, skipped: 0, deferred: 0, manual: 0 };
  let attempts = 0;
  const maximum = options.maxWorkItems ?? Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (hasManualCorrection(database, row.id)) { stats.manual += 1; continue; }
    const input = buildWorkItemAgentInput(database, row);
    const hash = workItemAgentInputHash(input);
    const previousFailure = getAgentFailure(database, "work_item", row.id);
    if (previousFailure?.inputHash === hash && previousFailure.provider === provider.name && !options.retryFailed) {
      stats.skipped += 1;
      continue;
    }
    if (previousFailure) clearAgentFailure(database, "work_item", row.id);
    const cached = getWorkItemAgentDecision(database, row.id);
    if (cached?.inputHash === hash && cached.provider === provider.name) {
      applyWorkItemAgentDecision(database, cached);
      stats.skipped += 1;
      continue;
    }
    // Do not expose a previous model narrative after its evidence changed;
    // until the new run succeeds, the deterministic work-item row is the
    // only valid fallback.
    if (cached) database.db.query("DELETE FROM work_item_agent_decisions WHERE work_item_id=?").run(row.id);
    if (attempts >= maximum) { stats.deferred += 1; continue; }
    attempts += 1;
    const traceSessionId = database.db.query("SELECT session_id FROM work_item_sessions WHERE work_item_id=? ORDER BY session_id LIMIT 1").get(row.id) as { session_id: string } | null;
    let runId: string | undefined;
    let runAttempts = 0;
    try {
      const decision = await new WorkItemAgent(provider, (step) => {
        runId = step.runId;
        runAttempts = Math.max(runAttempts, step.attempt);
        options.onTrace?.(step);
      }, traceSessionId?.session_id).run(input);
      saveWorkItemAgentDecision(database, decision);
      clearAgentFailure(database, "work_item", row.id);
      applyWorkItemAgentDecision(database, decision);
      stats.enhanced += 1;
    } catch (error) {
      stats.fallback += 1;
      recordAgentFailure(database, {
        scope: "work_item", targetId: row.id, inputHash: hash, provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      });
      if (runId) {
        persistAgentFailure(database, runId, traceSessionId?.session_id, error, provider.name, runAttempts, "work_item", row.projectId, row.id);
        // The runtime persists the step stream; this hook lets it close a run
        // consistently with session/project Agent failures.
        options.onTrace?.({ runId, sessionId: traceSessionId?.session_id, provider: provider.name, scope: "work_item", projectId: row.projectId, workItemId: row.id, phase: "verify", status: "failed", attempt: runAttempts, at: new Date().toISOString(), detail: truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 180) ?? "Work Item Agent failed" });
      }
    }
  }
  database.db.run("DELETE FROM work_item_agent_decisions WHERE work_item_id NOT IN (SELECT id FROM work_items)");
  return stats;
}

export function reapplyCachedWorkItemAgentDecisions(database: WorklogDatabase, providerName: string): number {
  const rows = database.db.query("SELECT work_item_id FROM work_item_agent_decisions WHERE provider=?").all(providerName) as Array<{ work_item_id: string }>;
  let applied = 0;
  for (const row of rows) {
    if (hasManualCorrection(database, row.work_item_id)) continue;
    const decision = currentWorkItemAgentDecision(database, row.work_item_id);
    if (!decision) continue;
    applyWorkItemAgentDecision(database, decision);
    applied += 1;
  }
  return applied;
}
