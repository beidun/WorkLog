import { describe, expect, test } from "bun:test";
import type { LlmConfig } from "../src/config";
import { OpenAICompatibleProvider } from "../src/llm/provider";

function config(values: Partial<LlmConfig> = {}): LlmConfig {
  return {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "worklog-test",
    allowRemote: false,
    timeoutMs: 5_000,
    maxInputChars: 8_000,
    maxSessionsPerScan: 20,
    retryFailed: false,
    ...values,
  };
}

function input() {
  return {
    projectName: "agent-worklog",
    objective: "修复 /Users/private-name/project 的扫描器",
    baseline: {
      headline: "修复扫描器",
      progressSummary: "扫描器正在修复。",
      completed: [],
      validations: [],
      blockers: [],
      remaining: ["待验证"],
      status: "in_progress" as const,
      nextStep: "继续验证。",
      openTurn: false,
    },
    events: [
      { id: "event-user", kind: "user_message", text: "修复扫描器，password=private-value" },
      { id: "event-progress", kind: "assistant_message", text: "扫描器逻辑已调整，仍需测试。" },
    ],
  };
}

describe("OpenAI-compatible digest provider", () => {
  test("sends a redacted bounded request and validates cited JSON output", async () => {
    let requestUrl = "";
    let requestBody = "";
    const provider = new OpenAICompatibleProvider(config(), async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        headline: "修复增量扫描器",
        progressSummary: "扫描器逻辑已调整，等待补充测试。",
        completed: ["已调整扫描逻辑"],
        validations: [],
        blockers: [],
        remaining: ["补充扫描测试"],
        status: "done_unverified",
        nextStep: "运行扫描测试并核对增量缓存。",
        evidenceIds: ["event-progress"],
      }) } }] });
    });

    const result = await provider.digestSession(input());
    expect(requestUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(requestBody).not.toContain("private-name");
    expect(requestBody).not.toContain("private-value");
    expect(requestBody).toContain("[REDACTED]");
    expect(result.status).toBe("done_unverified");
    expect(result.evidenceIds).toEqual(["event-progress"]);
  });

  test("rejects unknown evidence IDs", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        headline: "修复增量扫描器",
        progressSummary: "扫描器已经处理完成。",
        completed: [], validations: [], blockers: [], remaining: [],
        status: "done_unverified", nextStep: "运行测试确认结果。", evidenceIds: ["invented-event"],
      }) } }],
    }));
    await expect(provider.digestSession(input())).rejects.toThrow("unknown evidence ID");
  });

  test("tests connectivity with a fixed synthetic probe instead of conversation history", async () => {
    let requestBody = "";
    const provider = new OpenAICompatibleProvider(config(), async (_url, init) => {
      requestBody = String(init?.body);
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          headline: "Provider 连接正常",
          progressSummary: "固定合成事件已成功生成结构化工作摘要。",
          completed: ["完成连接测试"],
          validations: ["响应结构校验通过"],
          blockers: [],
          remaining: [],
          status: "verified",
          nextStep: "保存配置并在下次扫描中使用。",
          evidenceIds: ["connection-test-event"],
        }) } }],
      });
    });

    const result = await provider.testConnection();
    expect(result.ok).toBe(true);
    expect(requestBody).toContain("connection-test-event");
    expect(requestBody).toContain("synthetic event");
    expect(requestBody).not.toContain("agent-worklog");
    expect(requestBody).not.toContain("private-value");
  });

  test("returns a safe connection failure without response details", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => new Response("secret upstream response", { status: 401 }));
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).not.toContain("secret upstream response");
  });

  test("requires an explicit remote privacy opt-in", () => {
    expect(() => new OpenAICompatibleProvider(config({ mode: "remote", baseUrl: "https://models.example/v1" })))
      .toThrow("WORKLOG_LLM_ALLOW_REMOTE=1");
    expect(() => new OpenAICompatibleProvider(config({ baseUrl: "https://models.example/v1" })))
      .toThrow("Local LLM mode only allows");
    expect(() => new OpenAICompatibleProvider(config({ mode: "remote", baseUrl: "http://models.example/v1", allowRemote: true })))
      .toThrow("requires an https endpoint");
    expect(() => new OpenAICompatibleProvider(config({ baseUrl: "http://user:pass@127.0.0.1:11434/v1" })))
      .toThrow("must not contain credentials");
  });
});
