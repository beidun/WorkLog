import { describe, expect, test } from "bun:test";
import { ProjectAgent, projectAgentInputHash } from "../src/agent/project-agent";
import type { SessionDigestResult, WorklogModelProvider } from "../src/llm/provider";

const result: SessionDigestResult = {
  headline: "ETF 爬虫已完成历史补数",
  progressSummary: "核心缺口已经补齐，当前只需保持每日增量任务运行。",
  completed: ["补齐历史缺口"], validations: ["完成数据核对"], blockers: [], remaining: [],
  status: "verified", nextStep: "", evidenceIds: ["event-2"],
};

describe("ProjectAgent", () => {
  test("summarizes project evidence through the same gated agent flow", async () => {
    let received: any;
    const trace: any[] = [];
    const provider: WorklogModelProvider = {
      name: "fake:project", cacheKey: "fake-project-v1",
      async digestSession(input) { received = input; return result; },
    };
    const decision = await new ProjectAgent(provider, (step) => trace.push(step)).run({
      projectId: "project-1", projectName: "base-data-spiders", deterministicStage: "mixed",
      items: [{ id: "item-1", title: "补数", summary: "补齐缺口", status: "in_progress", nextStep: "核对", lastActivityAt: "2026-08-31T00:00:00Z", confidence: 0.8, evidenceCount: 1, evidenceIds: ["event-1"] }],
      evidence: [{ id: "event-1", kind: "user_message", text: "正在补齐历史缺口" }, { id: "event-2", kind: "tool_result", text: "历史缺口已经补齐，数据核对通过" }],
    });
    expect(received.objective).toContain("base-data-spiders");
    expect(received.events.map((event: any) => event.id)).toEqual(["event-1", "event-2"]);
    expect(received.events.map((event: any) => event.kind)).toEqual(["user_message", "tool_result"]);
    expect(received.events[0].text).toContain("已有下一步：核对");
    expect(received.plan.focusEventIds).toContain("event-1");
    expect(trace[0]).toMatchObject({ scope: "project", projectId: "project-1" });
    expect(decision).toMatchObject({ projectId: "project-1", headline: result.headline, stage: "implementation", evidenceIds: ["event-2"], nextSteps: [] });
  });

  test("binds the model next step to a cited work item and invalidates cache when evidence changes", async () => {
    const provider: WorklogModelProvider = {
      name: "fake:project-next", cacheKey: "fake-project-next-v1",
      async digestSession() { return { ...result, nextStep: "核对增量结果" }; },
    };
    const input = {
      projectId: "project-2", projectName: "项目", deterministicStage: "implementation" as const,
      items: [{ id: "item-2", title: "增量", summary: "增量抓取", status: "in_progress", nextStep: "", lastActivityAt: "2026-08-31T00:00:00Z", confidence: 0.8, evidenceCount: 1, evidenceIds: ["event-2"] }],
      evidence: [{ id: "event-2", kind: "tool_result", text: "增量结果已生成" }],
    };
    const decision = await new ProjectAgent(provider).run(input);
    expect(decision.nextSteps).toEqual([{ text: "核对增量结果", workItemId: "item-2" }]);
    expect(decision.confidence).toBeGreaterThan(0.7);
    const changed = { ...input, items: [{ ...input.items[0], evidenceIds: ["event-other"] }] };
    expect(projectAgentInputHash(input)).not.toBe(projectAgentInputHash(changed));
    const retimed = { ...input, evidence: [{ ...input.evidence[0], timestamp: "2026-09-01T01:00:00Z" }] };
    expect(projectAgentInputHash(input)).not.toBe(projectAgentInputHash(retimed));
  });

  test("keeps a completed deterministic project from being reopened by a vague model status", async () => {
    const provider: WorklogModelProvider = {
      name: "fake:project-completed", cacheKey: "fake-project-completed-v1",
      async digestSession() {
        return { ...result, status: "in_progress", progressSummary: "当前没有新的开放事项。", evidenceIds: ["event-completed"] };
      },
    };
    const decision = await new ProjectAgent(provider).run({
      projectId: "project-completed", projectName: "完成项目", deterministicStage: "completed",
      items: [{ id: "item-completed", title: "已完成事项", summary: "事项已验证", status: "verified", nextStep: "", lastActivityAt: "2026-08-31T00:00:00Z", confidence: 0.9, evidenceCount: 1, evidenceIds: ["event-completed"] }],
      evidence: [{ id: "event-completed", kind: "assistant_message", text: "验证通过，事项已完成。" }],
    });
    expect(decision.stage).toBe("completed");
  });
});
