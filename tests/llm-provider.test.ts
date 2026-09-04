import { describe, expect, test } from "bun:test";
import type { LlmConfig } from "../src/config";
import { AGENT_PROMPT_VERSION, agentSystemPrompt, OpenAICompatibleProvider } from "../src/llm/provider";

function config(values: Partial<LlmConfig> = {}): LlmConfig {
  return {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "worklog-test",
    allowRemote: false,
    timeoutMs: 5_000,
    maxInputChars: 8_000,
    maxSessionsPerScan: 20,
    maxWorkItemsPerScan: 20,
    maxProjectsPerScan: 10,
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
      progressSummary: "扫描器正在修复，password=baseline-secret。",
      completed: [],
      validations: [],
      blockers: [],
      remaining: ["待验证"],
      status: "in_progress" as const,
      nextStep: "继续验证 password=baseline-secret。",
      openTurn: false,
    },
    events: [
      { id: "event-user", kind: "user_message", text: "修复扫描器，password=private-value" },
      { id: "event-progress", kind: "assistant_message", text: "扫描器逻辑已调整，仍需测试。" },
    ],
  };
}

describe("OpenAI-compatible digest provider", () => {
  test("exposes distinct inspectable prompts for the three Agent layers", () => {
    expect(AGENT_PROMPT_VERSION).toBe("worklog-digest-v4-semantic-facts");
    const session = agentSystemPrompt("session");
    const workItem = agentSystemPrompt("work_item");
    const project = agentSystemPrompt("project");
    expect(session).toContain("Session Agent");
    expect(session).toContain("原子语义事实");
    expect(session).toContain("读取成功、列目录、查询返回数据");
    expect(session).toContain("facts");
    expect(workItem).toContain("Work Item Agent");
    expect(project).toContain("Project Agent");
    expect(new Set([session, workItem, project]).size).toBe(3);
  });

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
    expect(requestBody).not.toContain("baseline-secret");
    expect(requestBody).toContain('"max_tokens":8192');
    expect(result.status).toBe("done_unverified");
    expect(result.evidenceIds).toEqual(["event-progress"]);
  });

  test("accepts source-linked semantic facts from the session Agent", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        headline: "修复增量扫描器",
        progressSummary: "扫描器已修复，但仍需回归验证。",
        completed: ["修复扫描器状态判断"], validations: [], blockers: [], remaining: ["运行回归测试"],
        status: "done_unverified", nextStep: "运行回归测试。", evidenceIds: ["event-progress"],
        facts: [
          { kind: "change", text: "扫描器状态判断已修复", eventId: "event-progress" },
          { kind: "next_step", text: "仍需运行回归测试", eventId: "event-progress" },
        ],
      }) } }] }));
    const result = await provider.digestSession(input());
    expect(result.facts).toEqual([
      { kind: "change", text: "扫描器状态判断已修复", eventId: "event-progress" },
      { kind: "next_step", text: "仍需运行回归测试", eventId: "event-progress" },
    ]);
  });

  test("normalizes common Chinese fact kinds and wire aliases", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      headline: "文档审核", progressSummary: "文档审核已完成。", completed: [], validations: [], blockers: [], remaining: [],
      status: "verified", nextStep: "", evidenceIds: ["event-progress"], facts: [
        { type: "验证", text: "文档格式校验通过。", event_id: "event-progress" },
        { kind: "风险", text: "没有发现发布阻塞。", evidenceId: "event-progress" },
      ],
    }) } }] }));
    const result = await provider.digestSession(input());
    expect(result.facts?.map((fact) => fact.kind)).toEqual(["validation", "risk"]);
  });

  test("rejects a semantic fact whose event is not in evidenceIds", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        headline: "修复增量扫描器", progressSummary: "仍需验证。", completed: [], validations: [], blockers: [], remaining: ["验证"],
        status: "in_progress", nextStep: "运行测试。", evidenceIds: ["event-progress"],
        facts: [{ kind: "finding", text: "用户目标是修复扫描器", eventId: "event-user" }],
      }) } }] }));
    await expect(provider.digestSession(input())).rejects.toThrow("facts must cite");
  });

  test("sends the explicit Agent role so each layer receives its own prompt", async () => {
    let requestBody = "";
    const provider = new OpenAICompatibleProvider(config(), async (_url, init) => {
      requestBody = String(init?.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        headline: "项目进度", progressSummary: "项目当前仍在持续推进。", completed: [], validations: [], blockers: [], remaining: [],
        status: "in_progress", nextStep: "", evidenceIds: ["event-progress"],
      }) } }] });
    });
    await provider.digestSession({ ...input(), role: "project" });
    expect(requestBody).toContain("Project Agent");
    expect(requestBody).toContain("多个工作事项");
    const payload = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    expect(JSON.parse(payload.messages[1]!.content).role).toBe("project");
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

  test("does not accept citations for events removed by the input bound", async () => {
    const provider = new OpenAICompatibleProvider(config({ maxInputChars: 2_000 }), async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const bounded = JSON.parse(body.messages[1]!.content) as { events: Array<{ id: string }> };
      expect(bounded.events.map((event) => event.id)).toEqual(["event-progress"]);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        headline: "修复增量扫描器", progressSummary: "模型试图引用未发送的历史事件。", completed: [], validations: [], blockers: [], remaining: [],
        status: "in_progress", nextStep: "", evidenceIds: ["event-user"],
      }) } }] });
    });
    const large = { ...input(), events: [
      { id: "event-user", kind: "user_message", text: "修复扫描器 " + "x".repeat(5_000) },
      { id: "event-progress", kind: "assistant_message", text: "仍需测试 " + "y".repeat(5_000) },
    ] };
    await expect(provider.digestSession(large)).rejects.toThrow("unknown evidence ID");
  });

  test("supports the Responses wire API used by ccswitch Codex providers", async () => {
    let requestUrl = "";
    let requestBody = "";
    const provider = new OpenAICompatibleProvider(config({ mode: "remote", protocol: "responses", baseUrl: "https://models.example/v1", allowRemote: true }), async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      return Response.json({ output_text: JSON.stringify({
        headline: "修复增量扫描器",
        progressSummary: "扫描器逻辑已调整，等待补充测试。",
        completed: ["已调整扫描逻辑"], validations: [], blockers: [], remaining: ["补充扫描测试"],
        status: "done_unverified", nextStep: "运行扫描测试。", evidenceIds: ["event-progress"],
      }) });
    });
    const result = await provider.digestSession(input());
    expect(requestUrl).toBe("https://models.example/v1/responses");
    expect(requestBody).toContain('"input"');
    expect(requestBody).toContain('"max_output_tokens":8192');
    expect(result.status).toBe("done_unverified");
  });

  test("supports the Anthropic Messages wire API used by ccswitch Claude providers", async () => {
    let requestUrl = "";
    let requestBody = "";
    const provider = new OpenAICompatibleProvider(config({ mode: "remote", protocol: "anthropic_messages", baseUrl: "https://models.example", model: "deepseek-v4-flash", allowRemote: true }), async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      return Response.json({ content: [{ type: "text", text: JSON.stringify({
        headline: "修复增量扫描器", progressSummary: "当前等待补充测试。", completed: [], validations: [], blockers: [], remaining: ["补充测试"],
        status: "in_progress", nextStep: "运行测试。", evidenceIds: ["event-progress"],
      }) }] });
    });
    const result = await provider.digestSession(input());
    expect(requestUrl).toBe("https://models.example/v1/messages");
    expect(requestBody).toContain('"max_tokens"');
    expect(requestBody).toContain('"max_tokens":8192');
    expect(requestBody).toContain('"thinking":{"type":"disabled"}');
    expect(result.status).toBe("in_progress");
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
