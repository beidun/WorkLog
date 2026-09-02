import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { runWorkItemAgents } from "../src/agent/work-item-agent";
import { persistAgentTrace } from "../src/agent/trace-store";
import { getProjectProgress } from "../src/services";
import type { SessionDigestResult, WorklogModelProvider } from "../src/llm/provider";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-item-agent-"));
  roots.push(root);
  const db = new WorklogDatabase(join(root, "worklog.sqlite"));
  const now = "2026-09-01T08:00:00.000Z";
  db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("project-1", "demo", root, now, now, now);
  db.db.query("INSERT INTO work_items(id,project_id,title,summary,status,confidence,last_activity_at,created_at,updated_at,next_step) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("item-1", "project-1", "检查扫描器", "当前扫描器正在处理。", "in_progress", 0.8, now, now, now, "");
  db.db.query("INSERT INTO sessions(id,source,external_id,project_id,source_file,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("session-1", "codex", "external-1", "project-1", join(root, "session.jsonl"), now, now);
  db.db.query("INSERT INTO work_item_sessions(work_item_id,session_id) VALUES (?,?)").run("item-1", "session-1");
  db.db.query("INSERT INTO events(id,session_id,project_id,source,event_type,content,timestamp,source_file,source_line,raw_hash) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("event-1", "session-1", "project-1", "codex", "tool_result", "12 pass", now, join(root, "session.jsonl"), 1, "hash-1");
  db.db.query("INSERT INTO work_item_evidence(work_item_id,event_id,evidence_kind) VALUES (?,?,?)").run("item-1", "event-1", "validation");
  return db;
}

function provider(result: SessionDigestResult, calls: { count: number }): WorklogModelProvider {
  return {
    name: "fake:item-agent",
    cacheKey: "fake:item-agent-v1",
    async digestSession(): Promise<SessionDigestResult> { calls.count += 1; return result; },
  };
}

describe("work item Agent", () => {
  test("applies an evidence-backed decision and reuses its cache", async () => {
    const db = fixture();
    const calls = { count: 0 };
    const result: SessionDigestResult = {
      headline: "扫描器检查已完成", progressSummary: "扫描器检查完成，12 项测试通过。", completed: ["完成扫描器检查"],
      validations: ["12 项测试通过"], blockers: [], remaining: [], status: "verified", nextStep: "", evidenceIds: ["event-1"],
    };
    const model = provider(result, calls);
    const options = { maxWorkItems: 1, onTrace: (step: Parameters<typeof persistAgentTrace>[1]) => persistAgentTrace(db, step) };
    expect(await runWorkItemAgents(db, model, options)).toEqual({ enhanced: 1, fallback: 0, skipped: 0, deferred: 0, manual: 0 });
    expect(db.db.query("SELECT status,summary FROM work_items WHERE id='item-1'").get()).toEqual({ status: "verified", summary: "扫描器检查完成，12 项测试通过。" });
    expect(getProjectProgress(db, "project-1")?.counts).toMatchObject({ active: 0, completed: 1 });
    expect(db.db.query("SELECT status,scope,work_item_id FROM agent_runs").get()).toEqual({ status: "completed", scope: "work_item", work_item_id: "item-1" });
    expect(await runWorkItemAgents(db, model, options)).toEqual({ enhanced: 0, fallback: 0, skipped: 1, deferred: 0, manual: 0 });
    expect(calls.count).toBe(1);
    db.close();
  });

  test("keeps an overconfident completion claim at the deterministic status", async () => {
    const db = fixture();
    const calls = { count: 0 };
    const model = provider({
      headline: "扫描器已完成", progressSummary: "检查完成。", completed: [], validations: [], blockers: [], remaining: [],
      status: "verified", nextStep: "", evidenceIds: ["event-1"],
    }, calls);
    // Replace the completion-bearing tool result with ordinary progress text.
    db.db.query("UPDATE events SET event_type='assistant_message',content='正在检查扫描器，请稍候。' WHERE id='event-1'").run();
    await runWorkItemAgents(db, model, { maxWorkItems: 1 });
    expect(db.db.query("SELECT status FROM work_items WHERE id='item-1'").get()).toEqual({ status: "in_progress" });
    expect(calls.count).toBe(1);
    db.close();
  });

  test("defers items beyond the independent work-item budget", async () => {
    const db = fixture();
    const calls = { count: 0 };
    const model = provider({
      headline: "不应被调用", progressSummary: "", completed: [], validations: [], blockers: [], remaining: [],
      status: "in_progress", nextStep: "", evidenceIds: ["event-1"],
    }, calls);
    expect(await runWorkItemAgents(db, model, { maxWorkItems: 0 })).toEqual({ enhanced: 0, fallback: 0, skipped: 0, deferred: 1, manual: 0 });
    expect(calls.count).toBe(0);
    expect(db.db.query("SELECT status FROM work_items WHERE id='item-1'").get()).toEqual({ status: "in_progress" });
    db.close();
  });

  test("caches an item failure until retry is explicitly enabled", async () => {
    const db = fixture();
    let calls = 0;
    const model: WorklogModelProvider = {
      name: "fake:item-failing", cacheKey: "fake:item-failing-v1",
      async digestSession(): Promise<SessionDigestResult> { calls += 1; throw new Error("temporary gateway failure"); },
    };
    expect(await runWorkItemAgents(db, model, { maxWorkItems: 1 })).toMatchObject({ enhanced: 0, fallback: 1 });
    expect(await runWorkItemAgents(db, model, { maxWorkItems: 1 })).toMatchObject({ enhanced: 0, fallback: 0, skipped: 1 });
    expect(await runWorkItemAgents(db, model, { maxWorkItems: 1, retryFailed: true })).toMatchObject({ enhanced: 0, fallback: 1 });
    expect(calls).toBe(2);
    db.close();
  });
});
