import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { getProject } from "../src/services";
import { rebuildSessionDigests } from "../src/session-digests";
import { rebuildWorkItems } from "../src/work-items";
import { buildWorkItemEvalSuite, exportWorkItemEvalSuite } from "../src/work-item-eval-export";
import { clearWorkItemFeedback, getReviewQueue, getWorkItemFeedback, parseWorkItemFeedback, saveWorkItemFeedback } from "../src/work-item-feedback";
import { parseWorkItemCorrection, saveWorkItemCorrection } from "../src/work-item-corrections";
import { scoreWorkItemEval } from "../src/work-item-eval-score";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-feedback-"));
  roots.push(root);
  const db = new WorklogDatabase(join(root, "worklog.sqlite"));
  const timestamp = "2026-08-22T03:00:00.000Z";
  db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("project-feedback", "反馈项目", root, timestamp, timestamp, timestamp);
  const sourceFile = join(root, "feedback-session.jsonl");
  const sessionId = db.upsertSession({ source: "codex", externalId: "feedback-session", cwd: root, startedAt: timestamp, endedAt: timestamp, isSubagent: false, sourceFile });
  db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("project-feedback", sessionId);
  db.upsertEvent({ id: "feedback-request", source: "codex", sessionExternalId: "feedback-session", type: "user_message", role: "user", content: "完善日报导出", timestamp, sourceFile, sourceLine: 1, rawHash: "feedback-request" });
  db.upsertEvent({ id: "feedback-answer", source: "codex", sessionExternalId: "feedback-session", type: "assistant_message", role: "assistant", content: "日报导出已经完成，但还需要补充格式验证。password=should-hide", timestamp, sourceFile, sourceLine: 2, rawHash: "feedback-answer", metadata: { phase: "final_answer" } });
  db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("project-feedback", sessionId);
  await rebuildSessionDigests(db);
  rebuildWorkItems(db);
  const item = db.db.query("SELECT id FROM work_items WHERE project_id=?").get("project-feedback") as { id: string };
  return { db, root, itemId: item.id };
}

describe("work item feedback", () => {
  test("migrates legacy work-item feedback to a stable session anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-feedback-migration-"));
    roots.push(root);
    const path = join(root, "worklog.sqlite");
    const legacy = new Database(path, { create: true, strict: true });
    const timestamp = "2026-08-21T03:00:00.000Z";
    legacy.run(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, last_activity_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, parent_external_id TEXT,
        parent_session_id TEXT, project_id TEXT, title TEXT, cwd TEXT, git_branch TEXT, git_commit TEXT,
        git_remote TEXT, started_at TEXT, ended_at TEXT, is_subagent INTEGER NOT NULL DEFAULT 0,
        source_file TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, external_id)
      );
      CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, first_activity_at TEXT, last_activity_at TEXT, next_step TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE work_item_sessions (work_item_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(work_item_id, session_id));
      CREATE TABLE work_item_feedback (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, feedback_type TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(work_item_id, feedback_type));
      CREATE INDEX idx_work_item_feedback_updated ON work_item_feedback(updated_at DESC);
    `);
    legacy.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("legacy-project", "旧项目", root, timestamp, timestamp, timestamp);
    legacy.query("INSERT INTO sessions(id,source,external_id,project_id,started_at,ended_at,source_file,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("legacy-session", "codex", "legacy-session", "legacy-project", timestamp, timestamp, join(root, "legacy.jsonl"), timestamp, timestamp);
    legacy.query("INSERT INTO work_items(id,project_id,title,summary,status,confidence,first_activity_at,last_activity_at,next_step,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("legacy-item", "legacy-project", "旧事项", "迁移前事项", "in_progress", 0.8, timestamp, timestamp, "继续验证", timestamp, timestamp);
    legacy.query("INSERT INTO work_item_sessions(work_item_id,session_id) VALUES (?,?)").run("legacy-item", "legacy-session");
    legacy.query("INSERT INTO work_item_feedback(id,work_item_id,feedback_type,note,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("legacy-feedback", "legacy-item", "title_wrong", "标题需要更具体", timestamp, timestamp);
    legacy.close();

    const db = new WorklogDatabase(path);
    expect(db.db.query("PRAGMA table_info(work_item_feedback)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "anchor_session_id" }),
      expect.objectContaining({ name: "source_work_item_id" }),
    ]));
    expect(getWorkItemFeedback(db, "legacy-item")).toEqual([
      expect.objectContaining({
        id: "legacy-feedback",
        anchorSessionId: "legacy-session",
        sourceWorkItemId: "legacy-item",
        type: "title_wrong",
        note: "标题需要更具体",
      }),
    ]);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_work_item_feedback_updated'").get()).toBeTruthy();
    db.close();
  });

  test("validates and persists one feedback label per type", async () => {
    const { db, itemId } = await fixture();
    db.db.query(`
      INSERT INTO work_items(id,project_id,title,summary,status,confidence,first_activity_at,last_activity_at,next_step,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run("unreviewed-item", "project-feedback", "另一个事项", "尚未标注", "in_progress", 0.7, "2026-08-22T04:00:00.000Z", "2026-08-22T04:00:00.000Z", "", "2026-08-22T04:00:00.000Z", "2026-08-22T04:00:00.000Z");
    expect(getReviewQueue(db)).toHaveLength(2);
    expect(parseWorkItemFeedback({ type: "title_wrong", note: "标题应体现日报导出" })).toEqual({ type: "title_wrong", note: "标题应体现日报导出" });
    const saved = saveWorkItemFeedback(db, itemId, parseWorkItemFeedback({ type: "title_wrong", note: "标题应体现日报导出" }));
    expect(saved.workItemId).toBe(itemId);
    expect(getReviewQueue(db).find((item) => item.id === itemId)?.feedback).toHaveLength(1);
    const detail = getProject(db, "project-feedback") as any;
    expect(detail.workItems.find((item: { id: string }) => item.id === itemId)?.feedback[0]).toMatchObject({ type: "title_wrong", note: "标题应体现日报导出" });
    saveWorkItemFeedback(db, itemId, { type: "accurate", note: "" });
    expect(getReviewQueue(db).find((item) => item.id === itemId)?.feedback.map((item) => item.type)).toEqual(["accurate"]);
    expect(clearWorkItemFeedback(db, itemId, "title_wrong")).toBe(0);
    expect(scoreWorkItemEval(db)).toMatchObject({ totalItems: 2, reviewedItems: 1, unreviewedItems: 1, confirmedAccurate: 1, coverage: 0.5 });
    expect(scoreWorkItemEval(db).errorCounts.title_wrong).toBe(0);
    saveWorkItemFeedback(db, itemId, { type: "status_wrong", note: "状态应为待验证" });
    expect(getReviewQueue(db).find((item) => item.id === itemId)?.feedback.map((item) => item.type)).toEqual(["status_wrong"]);
    expect(scoreWorkItemEval(db)).toMatchObject({ confirmedAccurate: 0, errorCounts: { status_wrong: 1 } });
    expect(() => parseWorkItemFeedback({ type: "unknown" })).toThrow();
    db.close();
  });

  test("resolves historical cross-session conflicts by the latest feedback action", async () => {
    const { db, root, itemId } = await fixture();
    const firstSession = db.db.query("SELECT session_id FROM work_item_sessions WHERE work_item_id=?").get(itemId) as { session_id: string };
    const timestamp = "2026-08-22T04:00:00.000Z";
    const secondSession = db.upsertSession({
      source: "codex",
      externalId: "feedback-conflict-session",
      cwd: root,
      startedAt: timestamp,
      endedAt: timestamp,
      isSubagent: false,
      sourceFile: join(root, "feedback-conflict-session.jsonl"),
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("project-feedback", secondSession);
    db.db.query("INSERT INTO work_item_sessions(work_item_id,session_id) VALUES (?,?)").run(itemId, secondSession);
    db.db.query(`
      INSERT INTO work_item_feedback(id,anchor_session_id,source_work_item_id,feedback_type,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)
    `).run(
      "historical-accurate", firstSession.session_id, itemId, "accurate", "", "2026-08-22T03:00:00.000Z", "2026-08-22T03:00:00.000Z",
      "historical-status", secondSession, itemId, "status_wrong", "状态判断过早", timestamp, timestamp,
    );
    expect(getWorkItemFeedback(db, itemId).map((item) => item.type)).toEqual(["status_wrong"]);

    db.db.query("UPDATE work_item_feedback SET updated_at=? WHERE id=?").run("2026-08-22T05:00:00.000Z", "historical-accurate");
    expect(getWorkItemFeedback(db, itemId).map((item) => item.type)).toEqual(["accurate"]);
    db.close();
  });

  test("keeps feedback after automatic rebuilding changes the work-item id", async () => {
    const { db, root, itemId } = await fixture();
    const saved = saveWorkItemFeedback(db, itemId, { type: "title_wrong", note: "标题应该更简洁" });
    expect(saved.anchorSessionId).toBeTruthy();

    const timestamp = "2026-08-22T03:05:00.000Z";
    const sourceFile = join(root, "feedback-session-continued.jsonl");
    const sessionId = db.upsertSession({ source: "codex", externalId: "feedback-session-continued", cwd: root, startedAt: timestamp, endedAt: timestamp, isSubagent: false, sourceFile });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("project-feedback", sessionId);
    db.upsertEvent({ id: "feedback-request-continued", source: "codex", sessionExternalId: "feedback-session-continued", type: "user_message", role: "user", content: "完善日报导出", timestamp, sourceFile, sourceLine: 1, rawHash: "feedback-request-continued" });
    db.upsertEvent({ id: "feedback-answer-continued", source: "codex", sessionExternalId: "feedback-session-continued", type: "assistant_message", role: "assistant", content: "日报导出格式验证已经完成。", timestamp, sourceFile, sourceLine: 2, rawHash: "feedback-answer-continued", metadata: { phase: "final_answer" } });
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("project-feedback", sessionId);
    await rebuildSessionDigests(db);
    rebuildWorkItems(db);

    const rebuilt = db.db.query("SELECT id FROM work_items WHERE project_id=?").get("project-feedback") as { id: string };
    expect(rebuilt.id).not.toBe(itemId);
    expect(getWorkItemFeedback(db, rebuilt.id)).toHaveLength(1);
    expect(getWorkItemFeedback(db, rebuilt.id)[0]).toMatchObject({ type: "title_wrong", note: "标题应该更简洁", sourceWorkItemId: itemId });
    expect(buildWorkItemEvalSuite(db).cases).toHaveLength(1);
    db.close();
  });

  test("exports reviewed events with redaction and corrected expectations", async () => {
    const { db, root, itemId } = await fixture();
    saveWorkItemFeedback(db, itemId, { type: "title_wrong", note: "标题要更具体" });
    saveWorkItemFeedback(db, itemId, { type: "status_wrong", note: "已经完成验证" });
    saveWorkItemCorrection(db, itemId, parseWorkItemCorrection({ title: "检查日报导出格式", summary: "日报导出已经完成。", status: "verified", nextStep: "", }));

    const suite = buildWorkItemEvalSuite(db);
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]?.reviewed).toBe(true);
    expect(suite.cases[0]?.expected).toMatchObject({ title: "检查日报导出格式", status: "verified" });
    expect(suite.cases[0]?.expected.feedbackTypes).toEqual(expect.arrayContaining(["status_wrong", "title_wrong"]));
    const answer = suite.cases[0]!.events.find((event) => event.id === "event-2");
    expect(answer?.content).not.toContain("should-hide");
    expect(answer?.sourceLine).toBe(2);
    expect(JSON.stringify(suite)).not.toContain("source_file");

    const outputPath = join(root, "evals", "work-items.json");
    expect(exportWorkItemEvalSuite(db, outputPath)).toMatchObject({ caseCount: 1, path: outputPath });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).cases).toHaveLength(1);
    db.close();
  });
});
