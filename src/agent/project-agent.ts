import type { WorklogModelProvider, SessionDigestResult } from "../llm/provider";
import type { ProjectProgressStage, ProjectProgressItem } from "../services";
import { WorklogAgent, type AgentTraceStep } from "./worklog-agent";
import { stableId } from "../utils";

export interface ProjectAgentInput {
  projectId: string;
  projectName: string;
  items: Array<ProjectProgressItem & { evidenceIds: string[] }>;
  evidence: Array<{ id: string; text: string; kind?: string; timestamp?: string; isError?: boolean }>;
  deterministicStage: ProjectProgressStage;
  traceSessionId?: string;
}

export interface ProjectAgentDecision {
  projectId: string;
  inputHash: string;
  headline: string;
  summary: string;
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  stage: ProjectProgressStage;
  evidenceIds: string[];
  nextSteps: Array<{ text: string; workItemId?: string }>;
  provider: string;
  confidence: number;
  traceSessionId?: string;
}

export interface ProjectAgentOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

function stageForStatus(status: SessionDigestResult["status"]): ProjectProgressStage {
  if (status === "blocked") return "blocked";
  if (status === "verified") return "completed";
  if (status === "done_unverified") return "validation";
  if (status === "planned") return "planning";
  return "implementation";
}

function guardedStage(input: ProjectAgentInput, status: SessionDigestResult["status"]): ProjectProgressStage {
  if (input.deterministicStage === "blocked") return "blocked";
  const hasActive = input.items.some((item) => ["in_progress", "partially_done"].includes(item.status));
  const hasUnverified = input.items.some((item) => item.status === "done_unverified");
  const hasPlanned = input.items.some((item) => item.status === "planned");
  const modelStage = stageForStatus(status);
  if (modelStage === "completed" && hasActive) return "implementation";
  if (modelStage === "completed" && hasUnverified) return "validation";
  // A project with no open work cannot be reopened by a vague model status.
  // Keep the deterministic aggregate as a safety floor while still allowing
  // the model to provide the narrative and cited facts.
  if (input.deterministicStage === "completed" && !hasActive && !hasUnverified && !hasPlanned) return "completed";
  return modelStage;
}

export function projectAgentInputHash(input: ProjectAgentInput): string {
  return stableId("project-agent-input", input.projectId, input.deterministicStage,
    ...input.items.map((item) => `${item.id}:${item.status}:${item.lastActivityAt ?? ""}:${item.summary}:${item.nextStep}:${item.confidence}:${item.evidenceCount}:${item.evidenceIds.slice().sort().join(",")}`).sort(),
    ...input.evidence.map((event) => `${event.id}:${event.kind ?? ""}:${event.timestamp ?? ""}:${event.text}`).sort());
}

/**
 * Project orchestration is intentionally built on the same evidence-gated
 * session agent. Each event is a real event ID from the database, so a
 * project-level conclusion remains inspectable instead of citing synthetic
 * summaries that cannot be opened by the UI.
 */
export class ProjectAgent {
  constructor(private readonly provider: WorklogModelProvider, private readonly onTrace?: (step: AgentTraceStep) => void, private readonly options: ProjectAgentOptions = {}) {}

  async run(input: ProjectAgentInput): Promise<ProjectAgentDecision> {
    const itemByEvidence = new Map<string, ProjectProgressItem>();
    for (const item of input.items) for (const evidenceId of item.evidenceIds) itemByEvidence.set(evidenceId, item);
    const events = input.evidence.slice(-80).map((event) => {
      const item = itemByEvidence.get(event.id);
      const context = item ? `事项「${item.title}」[${item.status}]：${item.summary}${item.nextStep ? `；已有下一步：${item.nextStep}` : ""}；` : "";
      return { id: event.id, kind: event.kind ?? "assistant_message", text: `${context}${event.text}`, timestamp: event.timestamp, isError: event.isError };
    });
    if (events.length === 0) throw new Error("Project Agent requires at least one evidence event");
    const baseline = {
      headline: `${input.projectName} 项目进度`,
      progressSummary: `项目包含 ${input.items.length} 个事项，当前确定性阶段为 ${input.deterministicStage}。`,
      completed: input.items.filter((item) => item.status === "verified").slice(0, 6).map((item) => item.summary),
      validations: input.items.filter((item) => item.status === "done_unverified").slice(0, 6).map((item) => item.summary),
      blockers: input.items.filter((item) => item.status === "blocked").slice(0, 6).map((item) => item.summary),
      remaining: input.items.filter((item) => ["in_progress", "partially_done", "planned"].includes(item.status)).slice(0, 6).map((item) => item.summary),
      status: "in_progress" as const,
      nextStep: "",
      openTurn: false,
    };
    const result = await new WorklogAgent(this.provider, {
      onTrace: this.onTrace,
      scope: "project",
      projectId: input.projectId,
      maxAttempts: this.options.maxAttempts,
      retryDelayMs: this.options.retryDelayMs,
    }).run({
      sessionId: input.traceSessionId,
      projectName: input.projectName,
      objective: `汇总项目 ${input.projectName} 的真实工作进展，并识别当前主线与下一步。`,
      baseline,
      events,
    });
    const nextSteps = result.result.nextStep ? [{
      text: result.result.nextStep,
      workItemId: result.result.evidenceIds.map((eventId) => itemByEvidence.get(eventId)?.id).find(Boolean),
    }] : [];
    const itemConfidence = input.items.length > 0
      ? input.items.reduce((sum, item) => sum + item.confidence, 0) / input.items.length
      : 0.7;
    const evidenceCoverage = Math.min(1, result.result.evidenceIds.length / Math.min(8, events.length));
    const confidence = Math.round(Math.min(0.96, Math.max(0.72, itemConfidence * 0.7 + evidenceCoverage * 0.2 + 0.1)) * 100) / 100;
    return {
      projectId: input.projectId,
      inputHash: projectAgentInputHash(input),
      headline: result.result.headline,
      summary: result.result.progressSummary,
      completed: result.result.completed,
      validations: result.result.validations,
      blockers: result.result.blockers,
      remaining: result.result.remaining,
      stage: guardedStage(input, result.result.status),
      evidenceIds: result.result.evidenceIds,
      nextSteps,
      provider: this.provider.name,
      confidence,
      traceSessionId: input.traceSessionId,
    };
  }
}
