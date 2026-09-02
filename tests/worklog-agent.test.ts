import { describe, expect, test } from "bun:test";
import { WorklogAgent } from "../src/agent/worklog-agent";
import type { SessionDigestInput, SessionDigestResult, WorklogModelProvider } from "../src/llm/provider";

const input: SessionDigestInput = {
  projectName: "demo",
  objective: "实现功能",
  baseline: { headline: "实现功能", progressSummary: "处理中", completed: [], validations: [], blockers: [], remaining: [], status: "in_progress", nextStep: "", openTurn: true },
  events: [{ id: "e1", kind: "assistant_message", text: "已完成" }],
};

function provider(result: SessionDigestResult): WorklogModelProvider {
  return { name: "fake", cacheKey: "fake", digestSession: async () => result };
}

describe("WorklogAgent", () => {
  test("keeps an open turn from being marked verified", async () => {
    const result = await new WorklogAgent(provider({
      headline: "实现功能", progressSummary: "已完成", completed: [], validations: [], blockers: [], remaining: [],
      status: "verified", nextStep: "", evidenceIds: ["e1"],
    })).run(input);
    expect(result.result.status).toBe("in_progress");
    expect(result.trace.map((step) => step.phase)).toEqual(["observe", "plan", "reason", "reason", "verify", "verify", "commit"]);
    expect(result.attempts).toBe(1);
  });

  test("retries a transient provider failure when policy allows it", async () => {
    let calls = 0;
    const flaky = provider({ headline: "实现功能", progressSummary: "当前等待补充验证。", completed: [], validations: [], blockers: [], remaining: ["补充验证"], status: "in_progress", nextStep: "运行测试。", evidenceIds: ["e1"] });
    const wrapped: WorklogModelProvider = { ...flaky, digestSession: async (value) => { calls += 1; if (calls === 1) throw new Error("HTTP 503"); return flaky.digestSession(value); } };
    const result = await new WorklogAgent(wrapped, { maxAttempts: 2, retryDelayMs: 0 }).run(input);
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(result.trace.some((step) => step.status === "retrying")).toBe(true);
  });

  test("forwards the layer scope as the provider role", async () => {
    let receivedRole: string | undefined;
    const wrapped: WorklogModelProvider = {
      ...provider({ headline: "事项", progressSummary: "事项仍在推进。", completed: [], validations: [], blockers: [], remaining: [], status: "in_progress", nextStep: "", evidenceIds: ["e1"] }),
      digestSession: async (value) => { receivedRole = value.role; return { headline: "事项", progressSummary: "事项仍在推进。", completed: [], validations: [], blockers: [], remaining: [], status: "in_progress", nextStep: "", evidenceIds: ["e1"] }; },
    };
    await new WorklogAgent(wrapped, { scope: "work_item" }).run({ ...input, baseline: { ...input.baseline, openTurn: false } });
    expect(receivedRole).toBe("work_item");
  });

  test("retries a correctable model schema failure with explicit constraints", async () => {
    let calls = 0;
    let retryConstraints: string[] = [];
    const wrapped: WorklogModelProvider = {
      ...provider({ headline: "实现功能", progressSummary: "当前完成。", completed: [], validations: [], blockers: [], remaining: [], status: "in_progress", nextStep: "", evidenceIds: ["e1"] }),
      digestSession: async (value) => {
        calls += 1;
        if (calls === 1) throw new Error("Model must return 1 to 8 evidence IDs");
        retryConstraints = value.plan?.constraints ?? [];
        return { headline: "实现功能", progressSummary: "当前继续处理。", completed: [], validations: [], blockers: [], remaining: [], status: "in_progress", nextStep: "", evidenceIds: ["e1"] };
      },
    };
    const result = await new WorklogAgent(wrapped, { maxAttempts: 2, retryDelayMs: 0 }).run(input);
    expect(calls).toBe(2);
    expect(retryConstraints.some((constraint) => constraint.includes("上一轮输出未通过结构化校验"))).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test("retries an explicitly truncated JSON response", async () => {
    let calls = 0;
    const wrapped: WorklogModelProvider = {
      ...provider({ headline: "实现功能", progressSummary: "已完成验证。", completed: [], validations: [], blockers: [], remaining: [], status: "verified", nextStep: "", evidenceIds: ["e1"] }),
      digestSession: async () => {
        calls += 1;
        if (calls === 1) throw new Error("JSON Parse error: Unexpected EOF");
        return { headline: "实现功能", progressSummary: "已完成验证。", completed: [], validations: [], blockers: [], remaining: [], status: "verified", nextStep: "", evidenceIds: ["e1"] };
      },
    };
    const result = await new WorklogAgent(wrapped, { maxAttempts: 2, retryDelayMs: 0 }).run({ ...input, baseline: { ...input.baseline, openTurn: false } });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("emits a verify failure before rejecting an invalid evidence set", async () => {
    await expect(new WorklogAgent(provider({
      headline: "实现功能", progressSummary: "返回了不存在的引用。", completed: [], validations: [], blockers: [], remaining: [],
      status: "in_progress", nextStep: "", evidenceIds: ["missing-event"],
    })).run(input)).rejects.toThrow("invalid evidence");
    const trace: string[] = [];
    const agent = new WorklogAgent(provider({
      headline: "实现功能", progressSummary: "返回了不存在的引用。", completed: [], validations: [], blockers: [], remaining: [],
      status: "in_progress", nextStep: "", evidenceIds: ["missing-event"],
    }), { onTrace: (step) => trace.push(`${step.phase}:${step.status}`) });
    await agent.run(input).catch(() => undefined);
    expect(trace).toContain("verify:failed");
  });

  test("builds an evidence plan and rejects inconsistent completion claims", async () => {
    let receivedPlan: SessionDigestInput["plan"];
    const wrapped: WorklogModelProvider = {
      ...provider({
        headline: "实现功能", progressSummary: "主体已完成，但还需补充验证。", completed: [], validations: [], blockers: [],
        remaining: ["补充验证"], status: "verified", nextStep: "补充验证", evidenceIds: ["e1"],
      }),
      digestSession: async (value) => {
        receivedPlan = value.plan;
        return {
          headline: "实现功能", progressSummary: "主体已完成，但还需补充验证。", completed: [], validations: [], blockers: [],
          remaining: ["补充验证"], status: "verified", nextStep: "补充验证", evidenceIds: ["e1"],
        };
      },
    };
    const result = await new WorklogAgent(wrapped).run({ ...input, baseline: { ...input.baseline, openTurn: false } });
    expect(receivedPlan?.focusEventIds).toContain("e1");
    expect(receivedPlan?.questions.length).toBeGreaterThan(0);
    expect(result.result.status).toBe("done_unverified");
  });

  test("does not treat an arbitrary successful tool result as completion evidence", async () => {
    const result = await new WorklogAgent(provider({
      headline: "实现功能", progressSummary: "读取了一个文件。", completed: [], validations: [], blockers: [], remaining: [],
      status: "verified", nextStep: "", evidenceIds: ["tool-ok"],
    })).run({
      ...input,
      baseline: { ...input.baseline, openTurn: false },
      events: [{ id: "tool-ok", kind: "tool_result", text: "读取文件成功，内容已返回。", isError: false }],
    });
    expect(result.result.status).toBe("in_progress");
  });

  test("does not allow an active item to jump to abandoned without a local transition", async () => {
    const result = await new WorklogAgent(provider({
      headline: "实现功能", progressSummary: "任务已放弃。", completed: [], validations: [], blockers: [], remaining: [],
      status: "abandoned", nextStep: "", evidenceIds: ["e1"],
    })).run({ ...input, baseline: { ...input.baseline, openTurn: false } });
    expect(result.result.status).toBe("in_progress");
  });
});
