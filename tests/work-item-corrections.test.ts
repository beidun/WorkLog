import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { getOverview, getProject } from "../src/services";
import { clearWorkItemCorrection, parseWorkItemCorrection, saveWorkItemCorrection } from "../src/work-item-corrections";
import { clearProjectCorrection, parseProjectCorrection, saveProjectCorrection } from "../src/project-corrections";
import { rebuildWorkItems } from "../src/work-items";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-corrections-"));
  roots.push(root);
  const database = new WorklogDatabase(join(root, "worklog.sqlite"));
  const projectId = "project-1";
  const now = "2026-08-18T01:00:00.000Z";
  database.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(projectId, "agent-worklog", root, now, now, now);

  const seed = (externalId: string, minute: number, summary: string, status = "in_progress", nextStep = "继续自动处理") => {
    const timestamp = `2026-08-18T01:${String(minute).padStart(2, "0")}:00.000Z`;
    const sessionId = database.upsertSession({
      source: "codex", externalId, cwd: root, startedAt: timestamp, endedAt: timestamp,
      isSubagent: false, sourceFile: join(root, `${externalId}.jsonl`),
    });
    database.db.query("UPDATE sessions SET project_id=? WHERE id=?").run(projectId, sessionId);
    database.db.query(`
      INSERT INTO session_digests(session_id,input_hash,objective,headline,progress_summary,completed_json,
        validations_json,blockers_json,remaining_json,status,confidence,next_step,last_event_at,provider,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sessionId,`${externalId}-hash`,"完善人工纠正功能","完善人工纠正功能",summary,"[]","[]","[]",
      '["继续自动处理"]',status,0.82,nextStep,timestamp,"test",now,now);
    return sessionId;
  };
  return { database, projectId, root, seed };
}

describe("work item corrections", () => {
  test("survives automatic rebuilding and a merged work-item id change", () => {
    const { database, projectId, seed } = fixture();
    const firstSessionId = seed("session-1", 0, "自动摘要一");
    rebuildWorkItems(database);
    const original = database.db.query("SELECT id FROM work_items").get() as { id: string };

    const input = parseWorkItemCorrection({
      title: "人工确认后的事项",
      summary: "已经核实主要功能，等待页面验收。",
      status: "done_unverified",
      nextStep: "完成桌面与移动端验收",
    });
    const correction = saveWorkItemCorrection(database, original.id, input);
    expect(correction.anchorSessionId).toBe(firstSessionId);
    expect((getProject(database, projectId) as any).workItems[0]).toMatchObject({
      title: input.title,
      summary: input.summary,
      status: input.status,
      next_step: input.nextStep,
      correction: { anchorSessionId: firstSessionId },
    });

    seed("session-2", 5, "新的自动摘要应该被人工值覆盖", "verified", "");
    rebuildWorkItems(database);
    const merged = database.db.query("SELECT id,title,summary,status,next_step FROM work_items").get() as Record<string, unknown>;
    expect(merged.id).not.toBe(original.id);
    expect(merged).toMatchObject({ title: input.title, summary: input.summary, status: input.status, next_step: input.nextStep });

    expect(clearWorkItemCorrection(database, String(merged.id))).toBe(1);
    rebuildWorkItems(database);
    expect(database.db.query("SELECT title,summary,status,next_step FROM work_items").get()).toEqual({
      title: "完善人工纠正功能",
      summary: "新的自动摘要应该被人工值覆盖",
      status: "verified",
      next_step: "",
    });
    database.close();
  });

  test("rejects invalid correction input", () => {
    expect(() => parseWorkItemCorrection({ title: "", summary: "摘要", status: "verified", nextStep: "" }))
      .toThrow("事项标题不能为空");
    expect(() => parseWorkItemCorrection({ title: "标题", summary: "摘要", status: "finished", nextStep: "" }))
      .toThrow("事项状态无效");
  });

  test("keeps a project reassignment across rebuilding and restores automatic ownership", () => {
    const { database, projectId, root, seed } = fixture();
    const now = "2026-08-18T01:00:00.000Z";
    database.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("project-2", "另一个项目", "/tmp/another-project", now, now, now);
    seed("session-project", 0, "需要调整项目归属");
    database.upsertEvent({
      id: "event-project", source: "codex", sessionExternalId: "session-project", type: "assistant_message", role: "assistant",
      content: "项目归属已确认。", timestamp: now, sourceFile: join(root, "session-project.jsonl"), sourceLine: 1, rawHash: "event-project-hash",
    });
    database.db.query("UPDATE events SET project_id=? WHERE id=?").run(projectId, "event-project");
    rebuildWorkItems(database);
    const original = database.db.query("SELECT id FROM work_items").get() as { id: string };

    const correction = saveProjectCorrection(database, original.id, parseProjectCorrection({ projectId: "project-2" }));
    expect(correction.sourceProjectId).toBe(projectId);
    expect((database.db.query("SELECT project_id FROM work_items").get() as { project_id: string }).project_id).toBe("project-2");
    expect((getProject(database, "project-2") as any).workItems).toHaveLength(1);
    expect((getProject(database, "project-2") as any).workItems[0].projectCorrection.targetProjectId).toBe("project-2");
    expect((getProject(database, "project-2") as any).timeline.map((event: any) => event.id)).toEqual(["event-project"]);
    expect((getProject(database, projectId) as any).timeline).toHaveLength(0);
    expect((getOverview(database) as any).projects.find((project: any) => project.id === "project-2").sources).toBe("codex");

    seed("session-project-merged", 5, "同一事项继续推进");
    rebuildWorkItems(database);
    expect((database.db.query("SELECT project_id FROM work_items").get() as { project_id: string }).project_id).toBe("project-2");

    expect(clearProjectCorrection(database, String((database.db.query("SELECT id FROM work_items").get() as { id: string }).id))).toBe(1);
    rebuildWorkItems(database);
    expect((database.db.query("SELECT project_id FROM work_items").get() as { project_id: string }).project_id).toBe(projectId);
    database.close();
  });
});
