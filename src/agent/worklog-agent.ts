import { AGENT_PROMPT_VERSION, type AgentRole, type SessionDigestInput, type SessionDigestResult, type WorklogModelProvider } from "../llm/provider";
import { redactSecrets, stableId, truncate } from "../utils";

export type AgentPhase = "observe" | "plan" | "reason" | "verify" | "commit";
export type AgentStepStatus = "started" | "completed" | "retrying" | "failed";
export type AgentScope = "session" | "work_item" | "project";

export interface AgentTraceStep {
  runId: string;
  sessionId?: string;
  provider: string;
  scope: AgentScope;
  projectId?: string;
  workItemId?: string;
  phase: AgentPhase;
  status: AgentStepStatus;
  attempt: number;
  at: string;
  detail: string;
}

export interface AgentRunResult {
  runId: string;
  result: SessionDigestResult;
  trace: AgentTraceStep[];
  attempts: number;
}

export interface WorklogAgentOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  onTrace?: (step: AgentTraceStep) => void;
  scope?: AgentScope;
  projectId?: string;
  workItemId?: string;
}

interface AgentPlan {
  focusEventIds: string[];
  questions: string[];
  constraints: string[];
}

function buildPlan(input: SessionDigestInput): AgentPlan {
  const events = input.events;
  const focus = new Set<string>();
  // Always retain the objective and the tail of the conversation. Tool
  // failures/results are added because they decide blocked vs verified.
  for (const event of events.slice(-8)) focus.add(event.id);
  const firstUser = events.find((event) => event.kind === "user_message");
  if (firstUser) focus.add(firstUser.id);
  for (const event of events.filter((event) => event.kind === "user_message").slice(-2)) focus.add(event.id);
  for (const event of events) {
    if (/tool_result|tool_call/.test(event.kind) && /(?:失败|error|timeout|超时|成功|通过|完成|写入|修改)/i.test(event.text)) focus.add(event.id);
  }
  const questions = input.baseline.openTurn
    ? ["当前回合是否仍有未完成动作？"]
    : ["最终证据是否已经形成明确结论？", "是否存在仍需用户或外部系统处理的事项？"];
  return {
    focusEventIds: [...focus].slice(-24),
    questions,
    constraints: [
      "只能引用 supplied events 中存在的 evidenceIds",
      "openTurn=true 时不得判定为 verified 或 abandoned",
      "没有真实待办时 nextStep 必须为空字符串",
    ],
  };
}

const COMPLETION_EVIDENCE = /(?:已完成|已经完成|完成了|已实现|已修复|已通过|测试.{0,24}通过|构建.{0,24}成功|验证.{0,24}通过|结论[:：]|已确认|全部完整|无缺口|符合预期|无需(?:继续|再|额外)|不需要(?:继续|再|额外)|\b(?:done|completed|fixed|implemented|passed)\b)/i;
const SUCCESSFUL_VALIDATION_RESULT = /(?:测试|构建|编译|类型检查|校验|验证|检查|clippy|pytest|cargo|bun test|npm test|pnpm test|tsc|vue-tsc).{0,32}(?:通过|成功|完成|无误|pass(?:ed)?\b)|(?:pass(?:ed)?\b|exit(?:ed)?\s+(?:with\s+)?code\s*0)/i;
const BLOCKER_EVIDENCE = /(?:缺少|缺乏|无法继续|不能继续|等待.{0,16}(?:授权|确认|输入)|需要用户.{0,20}(?:授权|确认|提供)|permission denied|access denied|\bblocked\b|阻塞|卡住|超时)/i;
const BLOCKER_NEGATION = /(?:无阻塞|没有阻塞|未受阻|不再阻塞|没有卡住|未卡住|无需用户|无需等待)/i;

function citedEvents(result: SessionDigestResult, input: SessionDigestInput): SessionDigestInput["events"] {
  const selected = new Set(result.evidenceIds);
  return input.events.filter((event) => selected.has(event.id));
}

function supportsCompletion(result: SessionDigestResult, input: SessionDigestInput): boolean {
  return citedEvents(result, input).some((event) => event.kind === "task_completed"
    || (event.kind === "tool_result" && event.isError !== true && SUCCESSFUL_VALIDATION_RESULT.test(event.text))
    || (event.kind === "assistant_message" && COMPLETION_EVIDENCE.test(event.text)));
}

function supportsBlocker(result: SessionDigestResult, input: SessionDigestInput): boolean {
  return citedEvents(result, input).some((event) => BLOCKER_EVIDENCE.test(event.text) && !BLOCKER_NEGATION.test(event.text));
}

const STATUS_TRANSITIONS: Record<SessionDigestResult["status"], SessionDigestResult["status"][]> = {
  planned: ["planned", "in_progress", "partially_done", "done_unverified", "verified", "blocked"],
  in_progress: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
  partially_done: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
  done_unverified: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
  verified: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
  blocked: ["blocked", "in_progress", "partially_done", "verified"],
  abandoned: ["abandoned"],
};

function verifyResult(result: SessionDigestResult, input: SessionDigestInput, plan: AgentPlan): SessionDigestResult {
  const allowed = new Set(input.events.map((event) => event.id));
  if (result.evidenceIds.some((id) => !allowed.has(id)) || result.evidenceIds.length === 0) {
    throw new Error("Agent returned an invalid evidence set");
  }
  if (result.facts?.some((fact) => !result.evidenceIds.includes(fact.eventId))) {
    throw new Error("Agent facts must cite one of its evidenceIds");
  }
  let verified = result;
  if (input.baseline.openTurn && !["in_progress", "partially_done"].includes(verified.status)) {
    verified = { ...verified, status: verified.status === "blocked" ? "partially_done" : "in_progress" };
  }
  if (verified.status === "verified" && (verified.blockers.length > 0 || verified.remaining.length > 0 || verified.nextStep)) {
    verified = { ...verified, status: "done_unverified" };
  }
  if (verified.status === "verified" && verified.facts?.some((fact) => fact.kind === "next_step")) {
    verified = { ...verified, status: "done_unverified" };
  }
  if (verified.status === "verified" && input.baseline.status !== "verified" && !supportsCompletion(verified, input)) {
    verified = { ...verified, status: input.baseline.status };
  }
  if (verified.status === "blocked" && (verified.blockers.length === 0 || !supportsBlocker(verified, input))) {
    verified = { ...verified, status: input.baseline.status === "blocked" ? "blocked" : "partially_done" };
  }
  if (!STATUS_TRANSITIONS[input.baseline.status].includes(verified.status)) {
    verified = { ...verified, status: input.baseline.status };
  }
  // A plan is advisory; a model may cite another supplied event, but retain a
  // traceable warning when it ignored every planned focus event.
  if (!verified.evidenceIds.some((id) => plan.focusEventIds.includes(id))) {
    throw new Error("Agent evidence does not overlap its observation plan");
  }
  return verified;
}

function retryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Gateways can truncate a generation or return a correctable schema mistake
  // (for example too many evidence IDs). Retry those with explicit feedback;
  // auth/configuration errors remain non-retryable.
  return /HTTP (408|409|425|429|5\d\d)|timeout|timed out|AbortError|network|fetch failed|temporar|JSON Parse error|Model (?:response|field|must|returned)/i.test(message);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The session agent is deliberately small: scanners provide observations,
 * the model reasons over them, and the provider performs the evidence-ID
 * verification. Keeping those phases explicit prevents the LLM call from
 * becoming another hidden rule in the scanner.
 */
export class WorklogAgent {
  constructor(private readonly provider: WorklogModelProvider, private readonly options: WorklogAgentOptions = {}) {}

  async run(input: SessionDigestInput): Promise<AgentRunResult> {
    const runId = stableId("agent-run", this.provider.cacheKey, input.projectName, input.objective, Date.now());
    const trace: AgentTraceStep[] = [];
    const emit = (phase: AgentPhase, status: AgentStepStatus, attempt: number, detail: string): void => {
      const step = { runId, sessionId: input.sessionId, provider: this.provider.name, scope: this.options.scope ?? "session", projectId: this.options.projectId, workItemId: this.options.workItemId, phase, status, attempt, at: new Date().toISOString(), detail };
      trace.push(step);
      this.options.onTrace?.(step);
    };
    const plan = buildPlan(input);
    emit("observe", "completed", 0, `本地证据观察：${input.events.length} 条事件，已识别目标、工具结果和对话尾部`);
    emit("plan", "completed", 0, `本地证据计划：聚焦 ${plan.focusEventIds.length} 条证据（${plan.focusEventIds.slice(0, 24).join(",")}），回答 ${plan.questions.length} 个状态问题`);
    const maxAttempts = Math.max(1, Math.min(this.options.maxAttempts ?? 1, 3));
    let result: SessionDigestResult | undefined;
    let attempts = 0;
    let lastError: unknown;
    let attemptPlan = plan;
    const role: AgentRole = this.options.scope ?? input.role ?? "session";
    const providerInput = { ...input, role };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      emit("reason", "started", attempt, `调用 ${this.provider.name} · role=${role} · prompt=${AGENT_PROMPT_VERSION}`);
      try {
        result = await this.provider.digestSession({ ...providerInput, plan: attemptPlan });
        emit("reason", "completed", attempt, "Provider 返回结构化进展");
        break;
      } catch (error) {
        lastError = error;
        const retry = attempt < maxAttempts && retryableError(error);
        const reason = truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 180) ?? "Provider 调用失败";
        emit("reason", retry ? "retrying" : "failed", attempt, retry ? `暂时性失败，准备重试：${reason}` : `Provider 调用失败：${reason}`);
        if (retry) {
          attemptPlan = {
            ...attemptPlan,
            constraints: [
              ...attemptPlan.constraints,
              "上一轮输出未通过结构化校验；本轮只返回一个紧凑 JSON 对象，headline 4-72 字、progressSummary 8-360 字、每个列表最多 6 项、evidenceIds 只返回 1-8 个且必须来自本轮实际输入。",
            ],
          };
          await wait(this.options.retryDelayMs ?? 150);
        }
      }
    }
    if (!result) throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Agent provider failed"));
    emit("verify", "started", attempts, "检查证据引用、状态和进行中会话约束");
    // digestSession is the provider boundary; this second gate also protects
    // the agent when a custom provider implementation bypasses that parser.
    try {
      result = verifyResult(result, input, plan);
      emit("verify", "completed", attempts, `${result.evidenceIds.length} 条证据引用通过一致性校验，状态=${result.status}`);
    } catch (error) {
      const reason = truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 180) ?? "Agent 校验失败";
      emit("verify", "failed", attempts, reason);
      throw error;
    }
    emit("commit", "completed", attempts, `提交 ${result.status} 摘要，保留 ${result.evidenceIds.length} 条证据引用`);
    return { runId, result, trace, attempts };
  }
}
