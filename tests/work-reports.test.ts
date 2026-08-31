import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { getWorkReport, getWorkReportForDate, workReportPeriod } from "../src/work-reports";
import { rebuildSessionDigests } from "../src/session-digests";
import { rebuildWorkItems } from "../src/work-items";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-report-"));
  roots.push(root);
  const db = new WorklogDatabase(join(root, "worklog.sqlite"));
  const createdAt = "2026-08-13T02:00:00.000Z";

  const seed = (values: { projectId: string; projectName: string; externalId: string; timestamp: string; withEvidence?: boolean; topic?: string; summary?: string; nextStep?: string }) => {
    db.db.query("INSERT OR IGNORE INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(values.projectId, values.projectName, join(root, values.projectId), values.timestamp, createdAt, createdAt);
    const sourceFile = join(root, `${values.externalId}.jsonl`);
    const sessionId = db.upsertSession({
      source: "codex", externalId: values.externalId, cwd: root, startedAt: values.timestamp,
      endedAt: values.timestamp, isSubagent: false, sourceFile,
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run(values.projectId, sessionId);
    const eventId = `${values.externalId}-event`;
    db.upsertEvent({
      id: eventId, source: "codex", sessionExternalId: values.externalId, type: "assistant_message", role: "assistant",
      content: `${values.projectName}已有明确进展。`, timestamp: values.timestamp, sourceFile, sourceLine: 1,
      rawHash: `${eventId}-hash`,
    });
    db.db.query(`
      INSERT INTO session_digests(session_id,input_hash,objective,headline,progress_summary,completed_json,
        validations_json,blockers_json,remaining_json,status,confidence,next_step,last_event_at,provider,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sessionId, `${eventId}-hash`, `推进${values.topic ?? values.projectName}`, `${values.topic ?? values.projectName}进展`, values.summary ?? `${values.projectName}已有明确进展。`,
      "[]", "[]", "[]", '["继续实现"]', "in_progress", 0.8, values.nextStep ?? "继续实现并验证", values.timestamp, "test", createdAt, createdAt);
    if (values.withEvidence !== false) {
      db.db.query("INSERT INTO session_digest_evidence(session_id,event_id,digest_section,rank) VALUES (?,?,?,0)")
        .run(sessionId, eventId, "progress");
    }
  };
  return { db, seed };
}

describe("work report periods", () => {
  test("uses Shanghai calendar boundaries for today and yesterday", () => {
    const now = new Date("2026-08-12T16:30:00.000Z");
    expect(workReportPeriod("today", now)).toMatchObject({
      startDate: "2026-08-13", endDate: "2026-08-13",
      startAt: "2026-08-12T16:00:00.000Z", endAt: "2026-08-13T16:00:00.000Z",
    });
    expect(workReportPeriod("yesterday", now)).toMatchObject({
      startDate: "2026-08-12", endDate: "2026-08-12",
      startAt: "2026-08-11T16:00:00.000Z", endAt: "2026-08-12T16:00:00.000Z",
    });
  });

  test("starts the week on Monday in Shanghai", () => {
    expect(workReportPeriod("week", new Date("2026-08-13T02:00:00.000Z"))).toMatchObject({
      startDate: "2026-08-10", endDate: "2026-08-13",
      startAt: "2026-08-09T16:00:00.000Z", endAt: "2026-08-13T16:00:00.000Z",
    });
  });
});

describe("work reports", () => {
  test("includes only sessions active in range and gives every item a citation", () => {
    const { db, seed } = fixture();
    seed({ projectId: "today", projectName: "今日项目", externalId: "today-session", timestamp: "2026-08-12T16:00:00.000Z" });
    seed({ projectId: "yesterday", projectName: "昨日项目", externalId: "yesterday-session", timestamp: "2026-08-12T15:59:59.000Z" });
    rebuildWorkItems(db);

    const report = getWorkReport(db, "today", new Date("2026-08-13T02:00:00.000Z"));
    expect(report.projects.map((project) => project.name)).toEqual(["今日项目", "昨日项目"]);
    expect(report.itemCount).toBe(1);
    expect(report.projects[0]?.items).toHaveLength(1);
    expect(report.projects[1]?.items).toHaveLength(0);
    expect(report.projects[1]?.carryoverItems).toHaveLength(1);
    expect(report.projects.flatMap((project) => project.items).every((item) => item.evidence.length > 0)).toBe(true);
    db.close();
  });

  test("does not output an item without digest evidence", () => {
    const { db, seed } = fixture();
    seed({ projectId: "cited", projectName: "有引用", externalId: "cited-session", timestamp: "2026-08-13T01:00:00.000Z" });
    seed({ projectId: "uncited", projectName: "无引用", externalId: "uncited-session", timestamp: "2026-08-13T01:30:00.000Z", withEvidence: false });
    rebuildWorkItems(db);

    const report = getWorkReport(db, "today", new Date("2026-08-13T02:00:00.000Z"));
    expect(report.projects.map((project) => project.name)).toEqual(["有引用"]);
    expect(report.itemCount).toBe(1);
    db.close();
  });

  test("reports only the work segment that was active on the requested date", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-report-segments-"));
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
    const add = (id: string, type: "user_message" | "assistant_message" | "task_completed", content: string, timestamp: string, line: number) => {
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
    add("today-answer", "assistant_message", "日报导出正在进行，下一步补充格式验证。", todayTimestamp, 5);
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("segmented-project", sessionId);

    await rebuildSessionDigests(db);
    rebuildWorkItems(db);
    const report = getWorkReportForDate(db, "2026-08-22");
    expect(report.projects.map((project) => project.name)).toEqual(["分段项目"]);
    expect(report.projects[0]?.items).toHaveLength(1);
    expect(report.projects[0]?.todaySummary).toContain("检查日报导出");
    const item = report.projects[0]!.items[0]!;
    expect(item.title).toBe("检查日报导出");
    expect(item.evidence.map((evidence) => evidence.id)).toEqual(expect.arrayContaining(["today-request", "today-answer"]));
    expect(item.evidence.map((evidence) => evidence.id)).not.toContain("old-answer");
    db.close();
  });

  test("uses the selected segment status when one work item continues across dates", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-report-continued-segment-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const oldTimestamp = "2026-08-21T15:30:00.000Z";
    const todayTimestamp = "2026-08-21T16:30:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("continued-project", "连续项目", root, todayTimestamp, oldTimestamp, todayTimestamp);
    const sourceFile = join(root, "continued-session.jsonl");
    const sessionId = db.upsertSession({
      source: "codex", externalId: "continued-session", cwd: root, startedAt: oldTimestamp,
      endedAt: todayTimestamp, isSubagent: false, sourceFile,
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("continued-project", sessionId);
    const add = (id: string, type: "user_message" | "assistant_message" | "task_started" | "task_completed", content: string, timestamp: string, line: number) => {
      db.upsertEvent({
        id, source: "codex", sessionExternalId: "continued-session", type,
        role: type === "user_message" ? "user" : "assistant", content, timestamp, sourceFile,
        sourceLine: line, rawHash: `${id}-hash`, metadata: type === "assistant_message" ? { phase: "final_answer" } : undefined,
      });
    };
    add("old-request", "user_message", "完善扫描器", oldTimestamp, 1);
    add("old-answer", "assistant_message", "扫描器已经完成。", oldTimestamp, 2);
    add("old-complete", "task_completed", "", oldTimestamp, 3);
    add("today-request", "user_message", "完善扫描器", todayTimestamp, 4);
    add("today-start", "task_started", "", todayTimestamp, 5);
    add("today-answer", "assistant_message", "扫描器正在继续完善，下一步补充验证。", todayTimestamp, 6);
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("continued-project", sessionId);

    await rebuildSessionDigests(db);
    expect(rebuildWorkItems(db)).toBe(1);
    const oldReport = getWorkReportForDate(db, "2026-08-21");
    const todayReport = getWorkReportForDate(db, "2026-08-22");
    expect(oldReport.projects[0]?.items[0]).toMatchObject({ category: "completed", status: "verified" });
    expect(todayReport.projects[0]?.items[0]).toMatchObject({ category: "active", status: "in_progress" });
    expect(todayReport.projects[0]?.items[0]?.summary).toContain("继续完善");
    db.close();
  });

  test("separates current-period activity from historical carryover state", () => {
    const { db, seed } = fixture();
    seed({ projectId: "same-project", projectName: "同一项目", externalId: "old-session", timestamp: "2026-08-12T15:00:00.000Z", topic: "旧接口联调" });
    seed({ projectId: "same-project", projectName: "同一项目", externalId: "today-session", timestamp: "2026-08-12T16:00:00.000Z", topic: "日报导出" });
    rebuildWorkItems(db);

    const report = getWorkReportForDate(db, "2026-08-13");
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.items).toHaveLength(1);
    expect(report.projects[0]?.todaySummary).toContain("日报导出进展");
    expect(report.projects[0]?.items[0]).toMatchObject({ activityKind: "today" });
    expect(report.projects[0]?.carryoverItems).toHaveLength(1);
    expect(report.projects[0]?.carryoverItems[0]).toMatchObject({ activityKind: "carryover" });
    expect(report.projects[0]?.carryoverItems[0]?.changeSummary[0]).toContain("没有新的对话活动");
    expect(report.metrics).toMatchObject({ changedItems: 1, changedProjects: 1, carryoverItems: 1 });
    db.close();
  });

  test("keeps a project visible when the requested period has only carryover work", () => {
    const { db, seed } = fixture();
    seed({ projectId: "carryover-only", projectName: "仅延续项目", externalId: "old-only-session", timestamp: "2026-08-12T15:00:00.000Z", topic: "历史接口联调" });
    rebuildWorkItems(db);

    const report = getWorkReportForDate(db, "2026-08-13");
    expect(report.projectCount).toBe(1);
    expect(report.itemCount).toBe(0);
    expect(report.projects[0]).toMatchObject({
      name: "仅延续项目",
      todaySummary: "本时段没有新的对话活动",
      currentSummary: "1 项正在推进",
    });
    expect(report.projects[0]?.items).toHaveLength(0);
    expect(report.projects[0]?.carryoverItems).toHaveLength(1);
    expect(report.metrics).toMatchObject({ changedItems: 0, changedProjects: 0, carryoverItems: 1 });
    db.close();
  });

  test("explains a changed digest summary instead of only reporting activity count", () => {
    const { db, seed } = fixture();
    seed({ projectId: "changed-summary", projectName: "摘要变化项目", externalId: "old-summary-session", timestamp: "2026-08-12T15:00:00.000Z", topic: "接口联调", summary: "接口联调完成主体开发。", nextStep: "补充异常处理" });
    seed({ projectId: "changed-summary", projectName: "摘要变化项目", externalId: "new-summary-session", timestamp: "2026-08-12T16:00:00.000Z", topic: "接口联调", summary: "接口联调补充了异常重试。", nextStep: "补充格式验证" });
    rebuildWorkItems(db);

    const report = getWorkReportForDate(db, "2026-08-13");
    const item = report.projects[0]?.items[0];
    expect(item).toBeDefined();
    expect(item?.changeSummary.some((value) => value.includes("接口联调补充了异常重试"))).toBe(true);
    expect(item?.changeSummary.some((value) => value.includes("本时段有 2 段"))).toBe(false);
    expect(report.projects[0]?.todaySummary).toContain("接口联调补充了异常重试");
    db.close();
  });
});
