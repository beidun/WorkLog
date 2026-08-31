import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { captureProgressSnapshot } from "../src/progress-snapshots";
import { rebuildSessionDigests } from "../src/session-digests";
import { rebuildWorkItems } from "../src/work-items";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-progress-"));
  roots.push(root);
  const db = new WorklogDatabase(join(root, "worklog.sqlite"));
  const now = "2026-08-13T01:00:00.000Z";
  db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("project-1", "agent-worklog", root, now, now, now);

  const seed = (externalId: string, objective: string, headline: string, minute: number) => {
    const timestamp = `2026-08-13T01:${String(minute).padStart(2, "0")}:00.000Z`;
    const sourceFile = join(root, `${externalId}.jsonl`);
    const sessionId = db.upsertSession({
      source: "codex", externalId, cwd: root, startedAt: timestamp, endedAt: timestamp,
      isSubagent: false, sourceFile,
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("project-1", sessionId);
    const eventId = `${externalId}-progress`;
    db.upsertEvent({
      id: eventId, source: "codex", sessionExternalId: externalId, type: "assistant_message", role: "assistant",
      content: `${headline}正在推进。`, timestamp, sourceFile, sourceLine: 1, rawHash: `${eventId}-hash`,
    });
    db.db.query(`
      INSERT INTO session_digests(session_id,input_hash,objective,headline,progress_summary,completed_json,
        validations_json,blockers_json,remaining_json,status,confidence,next_step,last_event_at,provider,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sessionId, `${externalId}-hash`, objective, headline, `${headline}正在推进。`, "[]", "[]", "[]",
      '["继续推进"]', "in_progress", 0.8, "继续推进", timestamp, "test", now, now);
    db.db.query("INSERT INTO session_digest_evidence(session_id,event_id,digest_section,rank) VALUES (?,?,?,0)")
      .run(sessionId, eventId, "progress");
    return { sessionId, externalId, sourceFile };
  };
  return { db, seed };
}

describe("progress snapshots", () => {
  test("cleans conversational prefixes and execution constraints from work-item titles", () => {
    const { db, seed } = fixture();
    seed("session-title", "查询港股指数差异", "梳理你给我查一下，港股指数有哪些差异；不要提交 commit，不要修改文件", 0);

    rebuildWorkItems(db);
    expect((db.db.query("SELECT title FROM work_items").get() as { title: string }).title)
      .toBe("核查港股指数有哪些差异");
    db.close();
  });

  test("builds a concise work-item summary from cited file changes and validations", () => {
    const { db, seed } = fixture();
    const session = seed("session-summary", "完善扫描器", "完善历史扫描器", 0);
    const eventId = "session-summary-progress";
    db.db.query("UPDATE session_digests SET progress_summary=?,status='verified',remaining_json='[]',next_step='' WHERE session_id=?")
      .run("已修改文件：/workspace/src/scanner.ts", session.sessionId);
    db.db.query("INSERT INTO session_facts(id,session_id,event_id,fact_kind,text,confidence,rank,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("fact-change", session.sessionId, eventId, "change", "已修改文件：/workspace/src/scanner.ts", 0.98, 0, "2026-08-13T01:00:00.000Z");
    db.db.query("INSERT INTO session_facts(id,session_id,event_id,fact_kind,text,confidence,rank,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("fact-validation", session.sessionId, eventId, "validation", "验证通过：bun test 2>&1 | tail -25", 0.99, 1, "2026-08-13T01:00:00.000Z");

    rebuildWorkItems(db);
    expect((db.db.query("SELECT summary FROM work_items").get() as { summary: string }).summary)
      .toBe("scanner.ts 已修改，并通过 bun test 验证。");
    db.close();
  });

  test("prefers a cited conclusion over a generic digest summary", () => {
    const { db, seed } = fixture();
    const session = seed("session-finding", "完善扫描器", "完善历史扫描器", 0);
    const eventId = "session-finding-progress";
    db.db.query("UPDATE session_digests SET progress_summary=? WHERE session_id=?")
      .run("当前任务正在处理，尚未形成最终结论。", session.sessionId);
    db.db.query("INSERT INTO session_facts(id,session_id,event_id,fact_kind,text,confidence,rank,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("fact-finding", session.sessionId, eventId, "finding", "结论：增量扫描已恢复稳定。", 0.9, 0, "2026-08-13T01:00:00.000Z");

    rebuildWorkItems(db);
    expect((db.db.query("SELECT summary FROM work_items").get() as { summary: string }).summary)
      .toBe("结论：增量扫描已恢复稳定。");
    db.close();
  });

  test("uses the first snapshot as a baseline, then detects completion and validation", () => {
    const { db, seed } = fixture();
    const session = seed("session-1", "完善扫描器", "完善历史扫描器", 0);
    rebuildWorkItems(db);
    const baseline = captureProgressSnapshot(db, {}, "2026-08-13T01:01:00.000Z");
    expect(baseline.baseline).toBe(true);
    expect(baseline.changes).toEqual([]);

    const validationId = "session-1-validation";
    db.upsertEvent({
      id: validationId, source: "codex", sessionExternalId: session.externalId, type: "tool_result",
      content: "24 tests passed", timestamp: "2026-08-13T01:02:00.000Z", sourceFile: session.sourceFile,
      sourceLine: 2, rawHash: `${validationId}-hash`,
    });
    db.db.query(`UPDATE session_digests SET progress_summary=?,completed_json=?,validations_json=?,remaining_json='[]',
      status='verified',next_step='',last_event_at=? WHERE session_id=?`)
      .run("扫描器已完成并通过测试。", '["完成扫描器"]', '["24 tests passed"]', "2026-08-13T01:02:00.000Z", session.sessionId);
    db.db.query("INSERT INTO session_digest_evidence(session_id,event_id,digest_section,rank) VALUES (?,?,?,0)")
      .run(session.sessionId, validationId, "validation");
    rebuildWorkItems(db);

    const next = captureProgressSnapshot(db, {}, "2026-08-13T01:03:00.000Z");
    expect(next.baseline).toBe(false);
    expect(next.changes.map((change) => change.changeType)).toEqual(expect.arrayContaining(["completed", "validation_added"]));
    expect(next.changes.every((change) => change.evidenceIds.length > 0)).toBe(true);
    db.close();
  });

  test("detects a blocker appearing and later being resolved", () => {
    const { db, seed } = fixture();
    const session = seed("session-blocked", "部署服务", "部署本地服务", 0);
    rebuildWorkItems(db);
    captureProgressSnapshot(db, {}, "2026-08-13T01:01:00.000Z");

    db.db.query("UPDATE session_digests SET blockers_json=?,status='blocked',next_step=? WHERE session_id=?")
      .run('["缺少端口权限"]', "取得端口权限", session.sessionId);
    rebuildWorkItems(db);
    const blocked = captureProgressSnapshot(db, {}, "2026-08-13T01:02:00.000Z");
    expect(blocked.changes.map((change) => change.changeType)).toContain("blocker_added");

    db.db.query("UPDATE session_digests SET blockers_json='[]',status='in_progress',next_step=? WHERE session_id=?")
      .run("继续启动服务", session.sessionId);
    rebuildWorkItems(db);
    const resolved = captureProgressSnapshot(db, {}, "2026-08-13T01:03:00.000Z");
    expect(resolved.changes.map((change) => change.changeType)).toContain("blocker_resolved");
    db.close();
  });

  test("detects new cited activity even when the digest wording is unchanged", () => {
    const { db, seed } = fixture();
    const session = seed("session-activity", "继续实现报告", "实现工作总结", 0);
    rebuildWorkItems(db);
    captureProgressSnapshot(db, {}, "2026-08-13T01:01:00.000Z");

    const eventId = "session-activity-next";
    db.upsertEvent({
      id: eventId, source: "codex", sessionExternalId: session.externalId, type: "assistant_message", role: "assistant",
      content: "继续实现工作总结。", timestamp: "2026-08-13T01:02:00.000Z", sourceFile: session.sourceFile,
      sourceLine: 2, rawHash: `${eventId}-hash`,
    });
    db.db.query("UPDATE session_digests SET last_event_at=? WHERE session_id=?")
      .run("2026-08-13T01:02:00.000Z", session.sessionId);
    db.db.query("INSERT INTO session_digest_evidence(session_id,event_id,digest_section,rank) VALUES (?,?,?,1)")
      .run(session.sessionId, eventId, "progress");
    rebuildWorkItems(db);

    const result = captureProgressSnapshot(db, {}, "2026-08-13T01:03:00.000Z");
    expect(result.changes.map((change) => change.changeType)).toContain("progress_updated");
    db.close();
  });

  test("does not turn a correction to old activity time into new progress", () => {
    const { db, seed } = fixture();
    const session = seed("session-correction", "整理旧记录", "整理旧记录", 0);
    rebuildWorkItems(db);
    captureProgressSnapshot(db, {}, "2026-08-13T01:01:00.000Z");

    db.db.query("UPDATE session_digests SET last_event_at=? WHERE session_id=?")
      .run("2026-08-13T01:00:30.000Z", session.sessionId);
    rebuildWorkItems(db);
    const result = captureProgressSnapshot(db, {}, "2026-08-13T01:02:00.000Z");
    expect(result.changes).toEqual([]);
    db.close();
  });

  test("matches an item by overlapping sessions after automatic merging changes its id", () => {
    const { db, seed } = fixture();
    seed("session-a", "实现扫描器", "实现扫描器", 0);
    const second = seed("session-b", "整理总结页面", "整理总结页面", 2);
    expect(rebuildWorkItems(db)).toBe(2);
    captureProgressSnapshot(db, {}, "2026-08-13T01:03:00.000Z");

    db.db.query("UPDATE session_digests SET objective=?,headline=?,progress_summary=? WHERE session_id=?")
      .run("实现扫描器", "实现扫描器", "实现扫描器正在推进。", second.sessionId);
    expect(rebuildWorkItems(db)).toBe(1);
    const merged = captureProgressSnapshot(db, {}, "2026-08-13T01:04:00.000Z");
    expect(merged.itemCount).toBe(1);
    expect(merged.changes.some((change) => change.changeType === "started")).toBe(false);
    db.close();
  });

  test("keeps statuses and evidence isolated when one session crosses calendar dates", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-progress-segments-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const oldTimestamp = "2026-08-21T15:30:00.000Z";
    const todayTimestamp = "2026-08-21T16:30:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("segmented-project", "分段项目", root, todayTimestamp, oldTimestamp, todayTimestamp);
    const sourceFile = join(root, "segmented-session.jsonl");
    const sessionId = db.upsertSession({
      source: "codex", externalId: "segmented-session", cwd: root, startedAt: oldTimestamp,
      endedAt: todayTimestamp, isSubagent: false, sourceFile,
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("segmented-project", sessionId);
    const add = (id: string, type: "user_message" | "assistant_message" | "task_started" | "task_completed", content: string, timestamp: string, line: number) => {
      db.upsertEvent({
        id, source: "codex", sessionExternalId: "segmented-session", type,
        role: type === "user_message" ? "user" : "assistant", content, timestamp, sourceFile,
        sourceLine: line, rawHash: `${id}-hash`, metadata: type === "assistant_message" ? { phase: "final_answer" } : undefined,
      });
    };
    add("old-request", "user_message", "梳理扫描器架构", oldTimestamp, 1);
    add("old-answer", "assistant_message", "扫描器架构已经梳理完成。", oldTimestamp, 2);
    add("old-complete", "task_completed", "", oldTimestamp, 3);
    add("today-request", "user_message", "检查日报导出", todayTimestamp, 4);
    add("today-start", "task_started", "", todayTimestamp, 5);
    add("today-answer", "assistant_message", "日报导出正在进行，下一步补充格式验证。", todayTimestamp, 6);
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("segmented-project", sessionId);

    await rebuildSessionDigests(db);
    rebuildWorkItems(db);
    const baseline = captureProgressSnapshot(db, {}, "2026-08-22T00:00:00.000Z");
    expect(baseline.itemCount).toBe(2);
    const rows = db.db.query("SELECT title,status,evidence_ids_json FROM work_item_snapshots WHERE snapshot_id=? ORDER BY title")
      .all(baseline.snapshotId) as Array<{ title: string; status: string; evidence_ids_json: string }>;
    expect(rows).toHaveLength(2);
    const oldItem = rows.find((row) => row.title === "梳理扫描器架构");
    const todayItem = rows.find((row) => row.title === "检查日报导出");
    expect(oldItem?.status).toBe("verified");
    expect(todayItem?.status).toBe("in_progress");
    expect(JSON.parse(oldItem!.evidence_ids_json) as string[]).toContain("old-answer");
    expect(JSON.parse(oldItem!.evidence_ids_json) as string[]).not.toContain("today-answer");
    expect(JSON.parse(todayItem!.evidence_ids_json) as string[]).toContain("today-answer");
    expect(JSON.parse(todayItem!.evidence_ids_json) as string[]).not.toContain("old-answer");
    db.close();
  });
});
