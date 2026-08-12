import type { Overview, ProjectDetailResponse } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  overview: () => request<Overview>("/api/overview"),
  project: (id: string) => request<ProjectDetailResponse>(`/api/projects/${id}`),
  evidence: (id: string) => request<Record<string, any>>(`/api/evidence/${id}`),
  daily: () => request<Record<string, any>>("/api/reports/daily"),
  scan: () => request<{ status: string }>("/api/scan", { method: "POST" }),
  scanStatus: () => request<Record<string, any>>("/api/scan/status"),
};
