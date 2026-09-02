import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { agentRunDetails, latestAgentRuns, persistAgentFailure, persistAgentTrace } from "../src/agent/trace-store";
import type { AgentTraceStep } from "../src/agent/worklog-agent";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-trace-"));
  roots.push(root);
  const database = new WorklogDatabase(join(root, "worklog.sqlite"));
  const sessionId = database.upsertSession({ source: "codex", externalId: "trace-session", cwd: root, isSubagent: false, sourceFile: join(root, "session.jsonl") });
  return { database, sessionId };
}

function step(overrides: Partial<AgentTraceStep> = {}): AgentTraceStep {
  return {
    runId: "run-1", sessionId: "session-1", provider: "openai-compatible:test", scope: "session", phase: "observe",
    status: "started", attempt: 1, at: "2026-08-31T00:00:00.000Z", detail: "safe detail",
    ...overrides,
  };
}

describe("agent trace store", () => {
  test("persists ordered steps and closes a completed run", () => {
    const { database, sessionId } = fixture();
    persistAgentTrace(database, step({ sessionId, phase: "observe", status: "completed" }));
    persistAgentTrace(database, step({ sessionId, phase: "commit", status: "completed", attempt: 2, detail: "token=sk-abcdefghijklmnopqrstuvwxyz" }));
    expect(database.db.query("SELECT status, attempts, session_id, scope, project_id, provider FROM agent_runs WHERE id='run-1'").get()).toEqual({
      status: "completed", attempts: 2, session_id: sessionId, scope: "session", project_id: null, provider: "openai-compatible:test",
    });
    const rows = database.db.query("SELECT ordinal,phase,status,attempt,detail FROM agent_run_steps WHERE run_id='run-1' ORDER BY ordinal").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[1].detail).toContain("token=[REDACTED]");
    expect(agentRunDetails(database, "run-1")?.steps).toHaveLength(2);
    expect(agentRunDetails(database, "missing")).toBeNull();
    database.close();
  });

  test("records failure without leaking the provider secret", () => {
    const { database, sessionId } = fixture();
    persistAgentFailure(database, "run-failed", sessionId, new Error("Authorization: Bearer abcdefghijklmnop-secret"), "deepseek", 2);
    expect(latestAgentRuns(database, 1)[0]).toMatchObject({ id: "run-failed", status: "failed", provider: "deepseek", attempts: 2 });
    expect((latestAgentRuns(database, 1)[0].error as string)).toContain("[REDACTED]");
    database.close();
  });

  test("preserves the Agent scope when closing a project failure", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-trace-scope-"));
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const now = new Date().toISOString();
    db.db.query("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)").run("project-1", "demo", root, now, now);
    db.db.query("INSERT INTO sessions(id,source,external_id,project_id,source_file,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("session-1", "codex", "external-1", "project-1", join(root, "session.jsonl"), now, now);
    persistAgentFailure(db, "run-project-failed", "session-1", new Error("gateway timeout"), "deepseek", 2, "project", "project-1");
    expect(db.db.query("SELECT scope,project_id,work_item_id,status,attempts FROM agent_runs WHERE id=?").get("run-project-failed")).toEqual({ scope: "project", project_id: "project-1", work_item_id: null, status: "failed", attempts: 2 });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
