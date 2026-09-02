export interface ProjectSummary {
  id: string;
  name: string;
  root_path: string;
  git_remote: string | null;
  last_activity_at: string | null;
  work_count: number;
  verified_count: number;
  active_count: number;
  unverified_count: number;
  blocked_count: number;
  current_focus: string | null;
  sources: string | null;
  progress: ProjectProgress | null;
}

export type ProjectProgressStage = "planning" | "implementation" | "validation" | "blocked" | "completed" | "mixed";

export interface ProjectProgressItem {
  id: string;
  title: string;
  summary: string;
  status: string;
  nextStep: string;
  lastActivityAt: string | null;
  confidence: number;
  evidenceCount: number;
  evidenceIds: string[];
  agentProvider?: string;
  agentUpdatedAt?: string;
  agentEvidenceIds?: string[];
}

export interface ProjectWorkstream {
  id: string;
  title: string;
  stage: ProjectProgressStage;
  stageLabel: string;
  summary: string;
  items: ProjectProgressItem[];
  counts: { total: number; planned: number; active: number; completed: number; unverified: number; blocked: number };
  evidenceIds: string[];
  confidence: number;
}

export interface ProjectProgress {
  stage: ProjectProgressStage;
  stageLabel: string;
  agentStage?: ProjectProgressStage;
  agentStageLabel?: string;
  headline: string;
  summary: string;
  counts: { total: number; planned: number; active: number; completed: number; unverified: number; blocked: number };
  active: ProjectProgressItem[];
  completed: ProjectProgressItem[];
  blocked: ProjectProgressItem[];
  workstreams: ProjectWorkstream[];
  nextSteps: Array<{ text: string; workItemId: string; evidenceIds: string[] }>;
  evidence: EvidenceRef[];
  confidence: number;
  agent?: { headline: string; summary: string; stage: ProjectProgressStage; stageLabel: string; completed: string[]; validations: string[]; blockers: string[]; remaining: string[]; provider: string; updatedAt: string; evidenceIds: string[]; nextSteps: Array<{ text: string; workItemId?: string }> };
}

export type WorkStatus = "planned" | "in_progress" | "partially_done" | "done_unverified" | "verified" | "blocked" | "abandoned";

export interface WorkItemCorrectionPayload {
  title: string;
  summary: string;
  status: WorkStatus;
  nextStep: string;
}

export type WorkItemFeedbackType = "accurate" | "title_wrong" | "split_needed" | "merge_needed" | "status_wrong" | "summary_wrong" | "citation_wrong";

export interface WorkItemFeedback {
  id: string;
  workItemId: string;
  type: WorkItemFeedbackType;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCorrectionPayload {
  projectId: string;
}

export interface AttentionItem {
  id: string;
  project_id: string;
  title: string;
  summary: string;
  status: string;
  next_step: string;
  last_activity_at: string;
  project_name: string;
}

export interface Overview {
  generatedAt: string;
  metrics: { projects: number; active: number; verifiedToday: number; needsAttention: number };
  agentCoverage: {
    provider?: string;
    sessions: { total: number; enhanced: number };
    workItems: { total: number; enhanced: number };
    projects: { total: number; enhanced: number };
  };
  projects: ProjectSummary[];
  attention: AttentionItem[];
  sourceCounts: Array<{ source: string; count: number }>;
  scan: Array<{ source: string; files: number; errors: number; last_scan: string }>;
  recentChanges: ProgressChangeSummary[];
  statusLabels: Record<string, string>;
  llmProvider?: { enabled: boolean; mode: "off" | "local" | "remote"; name?: string; model?: string; endpoint?: string; protocol?: string };
}

export interface AgentRun {
  id: string;
  session_id: string;
  scope: "session" | "work_item" | "project";
  project_id: string | null;
  work_item_id: string | null;
  provider: string;
  status: "running" | "completed" | "failed";
  attempts: number;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

export interface AgentRunStep {
  ordinal: number;
  phase: "observe" | "plan" | "reason" | "verify" | "commit";
  status: "started" | "completed" | "retrying" | "failed";
  attempt: number;
  at: string;
  detail: string;
}

export interface AgentRunDetails {
  run: AgentRun;
  steps: AgentRunStep[];
}

export interface ProgressChangeSummary {
  id: string;
  projectId: string;
  projectName: string;
  workItemId: string;
  changeType: "started" | "progress_updated" | "completed" | "validation_added" | "blocker_added" | "blocker_resolved";
  title: string;
  detectedAt: string;
  evidenceIds: string[];
}

export type WorkReportRange = "today" | "yesterday" | "week";
export type WorkReportCategory = "active" | "completed" | "unverified" | "blocked";
export type WorkReportActivityKind = "today" | "carryover";

export interface WorkReportEvidence extends EvidenceRef {}

export interface WorkReportItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  summary: string;
  status: string;
  category: WorkReportCategory;
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  nextStep: string;
  lastActivityAt: string;
  evidence: WorkReportEvidence[];
  activityKind: WorkReportActivityKind;
  changeSummary: string[];
}

export interface WorkReportProject {
  id: string;
  name: string;
  summary: string;
  todaySummary: string;
  currentSummary: string;
  items: WorkReportItem[];
  carryoverItems: WorkReportItem[];
  counts: { active: number; completed: number; unverified: number; blocked: number; validations: number };
  agent?: {
    headline: string;
    summary: string;
    stage: string;
    provider: string;
    updatedAt: string;
    completed: string[];
    validations: string[];
    blockers: string[];
    remaining: string[];
    evidenceIds: string[];
    evidence: EvidenceRef[];
  };
}

export interface WorkReport {
  range: WorkReportRange | "date";
  label: string;
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  generatedAt: string;
  projectCount: number;
  itemCount: number;
  metrics: {
    active: number;
    completed: number;
    unverified: number;
    blocked: number;
    validations: number;
    changedProjects: number;
    changedItems: number;
    carryoverItems: number;
  };
  projects: WorkReportProject[];
  changes: Array<{
    id: string; projectId: string; projectName: string; workItemId: string; type: string;
    title: string; detectedAt: string; evidence: WorkReportEvidence[];
  }>;
  statusLabels: Record<string, string>;
}

export type LlmMode = "off" | "local" | "remote";

export interface LlmSettings {
  mode: LlmMode;
  baseUrl: string;
  model: string;
  protocol: "chat_completions" | "responses" | "anthropic_messages";
  allowRemote: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxSessionsPerScan: number;
  maxWorkItemsPerScan: number;
  maxProjectsPerScan: number;
  retryFailed: boolean;
  hasApiKey: boolean;
  source: "env" | "file" | "ccswitch" | "default";
  environmentOverrides: string[];
}

export interface LlmSettingsPayload {
  mode: LlmMode;
  baseUrl: string;
  model: string;
  protocol?: "chat_completions" | "responses" | "anthropic_messages";
  apiKey?: string;
  clearApiKey?: boolean;
  allowRemote: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxSessionsPerScan: number;
  maxWorkItemsPerScan: number;
  maxProjectsPerScan: number;
  retryFailed: boolean;
}

export interface ProviderConnectionTest {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

export interface CcswitchDiscovery {
  available: boolean;
  providerId?: string;
  providerName?: string;
  appType?: "codex" | "claude";
  baseUrl?: string;
  model?: string;
  protocol?: "chat_completions" | "responses" | "anthropic_messages";
  mode?: LlmMode;
  hasApiKey?: boolean;
}

export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  status: WorkStatus;
  confidence: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  next_step: string;
  session_count: number;
  evidence_count: number;
  correction: (WorkItemCorrectionPayload & {
    id: string;
    anchorSessionId: string;
    sourceWorkItemId: string;
    createdAt: string;
    updatedAt: string;
  }) | null;
  projectCorrection: (ProjectCorrectionPayload & {
    targetProjectId: string;
    id: string;
    anchorSessionId: string;
    sourceWorkItemId: string;
    sourceProjectId: string;
    createdAt: string;
    updatedAt: string;
  }) | null;
  feedback: WorkItemFeedback[];
  agent: { provider: string; updatedAt: string; evidenceIds: string[] } | null;
  evidence: EvidenceRef[];
  progress: {
    objective: string;
    headline: string;
    summary: string;
    status: string;
    nextStep: string;
    completed: string[];
    validations: string[];
    blockers: string[];
    remaining: string[];
    facts: Array<EvidenceRef & {
      kind: "finding" | "change" | "validation" | "risk" | "next_step";
      text: string;
      confidence: number;
    }>;
  } | null;
}

export interface ReviewQueueItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  summary: string;
  status: string;
  confidence: number;
  lastActivityAt: string | null;
  feedback: WorkItemFeedback[];
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
}

export type EvalErrorType = "title_wrong" | "split_needed" | "merge_needed" | "status_wrong" | "summary_wrong" | "citation_wrong";

export interface WorkItemEvalScore {
  version: 1;
  generatedAt: string;
  totalItems: number;
  reviewedItems: number;
  unreviewedItems: number;
  coverage: number;
  confirmedAccurate: number;
  errorCounts: Record<EvalErrorType, number>;
  errorRates: Record<EvalErrorType, number>;
  topErrors: Array<{ type: EvalErrorType; label: string; count: number; rate: number }>;
}

export interface WorkItemEvalSuite {
  version: 1;
  generatedAt: string;
  reviewedOnly: boolean;
  cases: Array<Record<string, unknown>>;
}

export interface EvidenceRef {
  id: string;
  source: string;
  source_file: string;
  source_line: number;
  event_type: string;
  tool_name: string | null;
  timestamp: string | null;
  is_error: number;
  evidence_kind: string;
  preview: string;
}

export interface TimelineEvent {
  id: string;
  event_type: string;
  timestamp: string;
  tool_name: string | null;
  is_error: number;
  content: string | null;
  command: string | null;
  source: string;
  session_title: string;
  source_file: string;
  source_line: number;
}

export interface RepositorySnapshot {
  id: string;
  projectId: string;
  capturedAt: string;
  available: boolean;
  state: "clean" | "dirty" | "empty" | "missing" | "not_git";
  branch: string | null;
  headCommit: string | null;
  headSubject: string | null;
  headCommittedAt: string | null;
  upstream: string | null;
  aheadCount: number;
  behindCount: number;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  changedFiles: string[];
}

export interface ProjectDetailResponse {
  project: ProjectSummary;
  progress: ProjectProgress | null;
  repository: RepositorySnapshot | null;
  workItems: WorkItem[];
  timeline: TimelineEvent[];
  sources: Array<{ source: string; count: number }>;
  projectOptions: Array<{ id: string; name: string; root_path: string; work_count: number }>;
  statusLabels: Record<string, string>;
}
