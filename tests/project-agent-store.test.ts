import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { saveProjectAgentDecision, getProjectAgentDecision } from "../src/agent/project-agent-store";

describe("project agent decision store", () => {
  test("upserts a redacted, source-linked project decision", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-worklog-project-decision-"));
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const now = "2026-09-01T00:00:00.000Z";
    db.db.query("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)").run("p1", "demo", root, now, now);
    saveProjectAgentDecision(db, {
      projectId: "p1", inputHash: "hash", headline: "项目已完成", summary: "密码 sk-abcdefghijklmnop 已被忽略", completed: ["修改已完成"], validations: ["测试通过"], blockers: [], remaining: [], stage: "completed",
      evidenceIds: ["event-1"], nextSteps: [{ text: "继续检查 sk-abcdefghijklmnop", workItemId: "item-1" }], provider: "fake:model", confidence: 0.86,
    });
    const decision = getProjectAgentDecision(db, "p1");
    expect(decision).toMatchObject({ projectId: "p1", headline: "项目已完成", summary: "密码 [REDACTED_API_KEY] 已被忽略", evidenceIds: ["event-1"], provider: "fake:model" });
    expect(decision?.completed).toEqual(["修改已完成"]);
    expect(decision?.validations).toEqual(["测试通过"]);
    expect(decision?.nextSteps[0]?.text).toBe("继续检查 [REDACTED_API_KEY]");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
