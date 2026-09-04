import type { AgentRun, AgentRunDetails, CcswitchDiscovery, LlmSettings, LlmSettingsPayload, Overview, ProjectCorrectionPayload, ProjectDetailResponse, ProviderConnectionTest, ReviewQueueResponse, WorkItemCorrectionPayload, WorkItemFeedback, WorkItemFeedbackType, WorkItemEvalScore, WorkItemEvalSuite, WorkReport, WorkReportRange } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };

export const api = {
  overview: () => request<Overview>("/api/overview"),
  project: (id: string) => request<ProjectDetailResponse>(`/api/projects/${id}`),
  saveWorkItemCorrection: (id: string, payload: WorkItemCorrectionPayload) => request<{ correction: unknown }>(`/api/work-items/${id}/correction`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  }),
  clearWorkItemCorrection: (id: string) => request<{ removed: number }>(`/api/work-items/${id}/correction`, { method: "DELETE" }),
  saveProjectCorrection: (id: string, payload: ProjectCorrectionPayload) => request<{ correction: unknown }>(`/api/work-items/${id}/project-correction`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  }),
  clearProjectCorrection: (id: string) => request<{ removed: number }>(`/api/work-items/${id}/project-correction`, { method: "DELETE" }),
  saveWorkItemFeedback: (id: string, type: WorkItemFeedbackType, note = "") => request<{ feedback: WorkItemFeedback }>(`/api/work-items/${id}/feedback`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ type, note }),
  }),
  clearWorkItemFeedback: (id: string, type: WorkItemFeedbackType) => request<{ removed: number }>(`/api/work-items/${id}/feedback/${type}`, { method: "DELETE" }),
  reviewQueue: () => request<ReviewQueueResponse>("/api/review"),
  evalScore: () => request<WorkItemEvalScore>("/api/evals/score"),
  exportEval: (includeUnreviewed = false) => request<WorkItemEvalSuite>(`/api/evals/export${includeUnreviewed ? "?includeUnreviewed=1" : ""}`),
  evidence: (id: string) => request<Record<string, any>>(`/api/evidence/${id}`),
  daily: (date?: string) => request<WorkReport>(`/api/reports/daily${date ? `?date=${encodeURIComponent(date)}` : ""}`),
  workReport: (range: WorkReportRange) => request<WorkReport>(`/api/reports/work?range=${range}`),
  scan: () => request<{ status: string }>("/api/scan", { method: "POST" }),
  analyzeProject: (id: string) => request<{ status: string; projectId?: string }>(`/api/projects/${encodeURIComponent(id)}/analyze`, { method: "POST" }),
  scanStatus: () => request<Record<string, any>>("/api/scan/status"),
  agentRuns: (limit = 20) => request<{ runs: AgentRun[] }>(`/api/agent/runs?limit=${limit}`),
  agentRun: (id: string) => request<AgentRunDetails>(`/api/agent/runs/${encodeURIComponent(id)}`),
  settings: () => request<LlmSettings>("/api/settings/llm"),
  discoverCcswitch: () => request<CcswitchDiscovery>("/api/settings/llm/ccswitch"),
  importCcswitch: (providerId?: string) => request<LlmSettings>(`/api/settings/llm/ccswitch${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}`, { method: "PUT" }),
  saveSettings: (payload: LlmSettingsPayload) => request<LlmSettings>("/api/settings/llm", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  }),
  testProvider: (payload: LlmSettingsPayload) => request<ProviderConnectionTest>("/api/settings/llm/test", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  }),
};
