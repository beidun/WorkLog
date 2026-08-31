import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { getOverview, getProject, getProjectProgress } from "../src/services";
import { rebuildSessionDigests } from "../src/session-digests";
import { rebuildWorkItems } from "../src/work-items";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project service", () => {
  test("returns atomic facts with a complete evidence reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-services-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const sourceFile = join(root, "session.jsonl");
    const timestamp = "2026-08-14T01:02:03.000Z";
    const now = "2026-08-14T01:03:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("project-1", "agent-worklog", root, timestamp, now, now);
    const sessionId = db.upsertSession({
      source: "codex", externalId: "service-session", cwd: root, startedAt: timestamp, endedAt: timestamp,
      isSubagent: false, sourceFile,
    });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run("project-1", sessionId);
    db.upsertEvent({
      id: "event-request", source: "codex", sessionExternalId: "service-session", type: "user_message", role: "user",
      content: "检查事实引用", timestamp, sourceFile, sourceLine: 1, rawHash: "request-hash",
    });
    db.upsertEvent({
      id: "event-conclusion", source: "codex", sessionExternalId: "service-session", type: "assistant_message", role: "assistant",
      content: "结论：事实引用已经完整接入项目详情。", timestamp, sourceFile, sourceLine: 2,
      rawHash: "conclusion-hash", metadata: { phase: "final_answer" },
    });
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run("project-1", sessionId);

    await rebuildSessionDigests(db);
    rebuildWorkItems(db);
    const detail = getProject(db, "project-1") as any;
    const fact = detail.workItems[0].progress.facts.find((item: any) => item.id === "event-conclusion");

    expect(fact).toMatchObject({
      kind: "finding",
      text: "结论：事实引用已经完整接入项目详情。",
      confidence: 0.9,
      id: "event-conclusion",
      source: "codex",
      source_file: sourceFile,
      source_line: 2,
      event_type: "assistant_message",
      tool_name: null,
      timestamp,
      is_error: 0,
      evidence_kind: "finding",
      preview: "结论：事实引用已经完整接入项目详情。",
    });
    db.close();
  });

  test("builds a project-level progress narrative from all work-item states", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-project-progress-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const now = "2026-08-20T08:00:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("project-progress", "progress-project", root, now, now, now);
    const insert = db.db.query(`
      INSERT INTO work_items(id,project_id,title,summary,status,confidence,first_activity_at,last_activity_at,next_step,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    insert.run("item-done", "project-progress", "接入扫描", "Codex 扫描已经完成。", "verified", 0.9, now, "2026-08-18T08:00:00.000Z", "", now, now);
    insert.run("item-active", "project-progress", "完善项目汇总", "正在把多个事项汇总成项目进度。", "in_progress", 0.8, now, "2026-08-20T08:00:00.000Z", "补充项目级引用", now, now);
    insert.run("item-blocked", "project-progress", "接入远程模型", "等待本机模型服务启动。", "blocked", 0.7, now, "2026-08-19T08:00:00.000Z", "启动模型服务后重试", now, now);
    insert.run("item-unverified", "project-progress", "补充真实历史验收", "代码已完成，尚缺少真实历史验证。", "done_unverified", 0.75, now, "2026-08-17T08:00:00.000Z", "完成真实历史扫描", now, now);

    const progress = getProjectProgress(db, "project-progress");
    expect(progress).toMatchObject({
      stage: "blocked",
      stageLabel: "存在阻塞",
      headline: "当前受阻：接入远程模型",
      counts: { total: 4, planned: 0, active: 1, completed: 1, unverified: 1, blocked: 1 },
    });
    expect(progress?.summary).toContain("已完成 1 项");
    expect(progress?.summary).toContain("正在推进 1 项");
    expect(progress?.summary).toContain("受阻 1 项");
    expect(progress?.nextSteps.map((step) => step.text)).toEqual(["启动模型服务后重试", "补充项目级引用", "完成真实历史扫描"]);

    const overview = getOverview(db) as any;
    expect(overview.projects[0].current_focus).toBe(progress?.summary);
    expect(overview.projects[0].progress.stage).toBe("blocked");
    expect(overview.metrics.needsAttention).toBe(2);
    expect(overview.attention[0]).toMatchObject({
      id: "item-blocked",
      project_id: "project-progress",
      title: "接入远程模型",
      summary: "等待本机模型服务启动。",
      status: "blocked",
      next_step: "启动模型服务后重试",
      project_name: "progress-project",
    });
    db.close();
  });

  test("groups related work items into explainable workstreams and merges evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-workstreams-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const projectId = "project-workstreams";
    const now = "2026-08-20T08:00:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(projectId, "workstream-project", root, now, now, now);
    const insert = db.db.query(`
      INSERT INTO work_items(id,project_id,title,summary,status,confidence,first_activity_at,last_activity_at,next_step,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    insert.run("item-scan-a", projectId, "实现扫描器增量游标", "Codex 增量扫描已经完成。", "in_progress", 0.9, now, "2026-08-20T08:00:00.000Z", "补充扫描器测试", now, now);
    insert.run("item-scan-b", projectId, "优化扫描器增量游标", "继续完善 Codex 增量扫描的边界处理。", "verified", 0.8, now, "2026-08-19T08:00:00.000Z", "", now, now);
    insert.run("item-report", projectId, "整理日报导出", "日报导出格式已经完成。", "verified", 0.9, now, "2026-08-20T07:00:00.000Z", "", now, now);
    insert.run("item-old-scan", projectId, "修复扫描器增量游标", "扫描器增量游标的旧问题。", "verified", 0.7, now, "2026-06-01T08:00:00.000Z", "", now, now);

    const addEvidence = (itemId: string, externalId: string, eventId: string, timestamp: string, filePath: string) => {
      const sessionId = db.upsertSession({ source: "codex", externalId, cwd: root, startedAt: timestamp, endedAt: timestamp, isSubagent: false, sourceFile: join(root, `${externalId}.jsonl`) });
      db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run(projectId, sessionId);
      db.upsertEvent({ id: eventId, source: "codex", sessionExternalId: externalId, type: "assistant_message", role: "assistant", content: "扫描器增量游标证据", timestamp, sourceFile: join(root, `${externalId}.jsonl`), sourceLine: 1, rawHash: `${eventId}-hash`, filePaths: [filePath] });
      db.db.query("INSERT INTO work_item_sessions(work_item_id,session_id) VALUES (?,?)").run(itemId, sessionId);
      db.db.query("INSERT INTO work_item_evidence(work_item_id,event_id,evidence_kind) VALUES (?,?,?)").run(itemId, eventId, "finding");
    };
    addEvidence("item-scan-a", "scan-a", "event-scan-a", "2026-08-20T08:00:00.000Z", "src/scanner.ts");
    addEvidence("item-scan-b", "scan-b", "event-scan-b", "2026-08-19T08:00:00.000Z", "src/scanner.ts");

    const progress = getProjectProgress(db, projectId, true);
    expect(progress?.workstreams).toHaveLength(3);
    const scanStream = progress?.workstreams.find((stream) => stream.items.some((item) => item.id === "item-scan-a"));
    expect(scanStream).toMatchObject({
      title: "实现扫描器增量游标",
      counts: { total: 2, active: 1, completed: 1, blocked: 0 },
      evidenceIds: ["event-scan-a", "event-scan-b"],
    });
    expect(scanStream?.items.map((item) => item.id)).toEqual(["item-scan-a", "item-scan-b"]);
    expect(progress?.workstreams.find((stream) => stream.items.some((item) => item.id === "item-report"))?.items).toHaveLength(1);
    expect(progress?.workstreams.find((stream) => stream.items.some((item) => item.id === "item-old-scan"))?.items).toHaveLength(1);
    db.close();
  });

  test("does not merge generic-only or stale work items", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-workstream-boundary-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const projectId = "project-workstream-boundary";
    const now = "2026-08-20T08:00:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(projectId, "boundary-project", root, now, now, now);
    const insert = db.db.query(`INSERT INTO work_items(id,project_id,title,summary,status,confidence,first_activity_at,last_activity_at,next_step,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("generic-a", projectId, "实现项目功能", "当前项目功能已经完成。", "verified", 0.8, now, "2026-08-20T08:00:00.000Z", "", now, now);
    insert.run("generic-b", projectId, "完善项目进度", "当前项目进度已经完成。", "verified", 0.8, now, "2026-08-19T08:00:00.000Z", "", now, now);
    insert.run("stale-a", projectId, "实现缓存索引", "完成缓存索引。", "verified", 0.8, now, "2026-08-20T08:00:00.000Z", "", now, now);
    insert.run("stale-b", projectId, "优化缓存索引", "完成缓存索引。", "verified", 0.8, now, "2026-06-01T08:00:00.000Z", "", now, now);

    const progress = getProjectProgress(db, projectId);
    expect(progress?.workstreams).toHaveLength(4);
    expect(progress?.workstreams.every((stream) => stream.items.length === 1)).toBe(true);
    db.close();
  });

  test("splits one long session into separate work segments before project aggregation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-session-segments-"));
    roots.push(root);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const projectId = "project-session-segments";
    const now = "2026-08-20T08:00:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(projectId, "segments-project", root, now, now, now);
    const sourceFile = join(root, "long-session.jsonl");
    const sessionId = db.upsertSession({ source: "codex", externalId: "long-session", cwd: root, startedAt: now, endedAt: now, isSubagent: false, sourceFile });
    db.db.query("UPDATE sessions SET project_id=? WHERE id=?").run(projectId, sessionId);
    const add = (id: string, type: "user_message" | "assistant_message" | "task_completed", content: string, line: number) => {
      db.upsertEvent({ id, source: "codex", sessionExternalId: "long-session", type, role: type === "user_message" ? "user" : "assistant", content, timestamp: `2026-08-20T08:0${line}:00.000Z`, sourceFile, sourceLine: line, rawHash: `${id}-hash`, metadata: type === "assistant_message" ? { phase: "final_answer" } : undefined });
    };
    add("segment-a-request", "user_message", "梳理扫描器架构", 1);
    add("segment-a-answer", "assistant_message", "扫描器架构已经梳理完成。", 2);
    add("segment-a-complete", "task_completed", "", 3);
    add("segment-b-request", "user_message", "检查日报导出", 4);
    add("segment-b-answer", "assistant_message", "日报导出已经完成。", 5);
    add("segment-b-complete", "task_completed", "", 6);
    db.db.query("UPDATE events SET project_id=? WHERE session_id=?").run(projectId, sessionId);

    await rebuildSessionDigests(db);
    expect((db.db.query("SELECT objective FROM session_digests WHERE session_id=?").get(sessionId) as { objective: string }).objective).toContain("日报导出");
    expect(rebuildWorkItems(db)).toBe(2);
    const segments = db.db.query("SELECT ordinal,start_line,end_line,objective FROM work_segments WHERE session_id=? ORDER BY ordinal").all(sessionId) as Array<Record<string, unknown>>;
    expect(segments).toEqual([
      { ordinal: 0, start_line: 1, end_line: 3, objective: "梳理扫描器架构" },
      { ordinal: 1, start_line: 4, end_line: 6, objective: "检查日报导出" },
    ]);
    const links = db.db.query(`
      SELECT wi.title,COUNT(wis.segment_id) AS segment_count
      FROM work_items wi JOIN work_item_segments wis ON wis.work_item_id=wi.id
      GROUP BY wi.id ORDER BY wi.title
    `).all() as Array<{ title: string; segment_count: number }>;
    expect(links).toHaveLength(2);
    expect(links).toEqual(expect.arrayContaining([
      { title: "检查日报导出", segment_count: 1 },
      { title: "梳理扫描器架构", segment_count: 1 },
    ]));
    db.close();
  });
});
