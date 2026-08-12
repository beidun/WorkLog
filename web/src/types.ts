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
}

export interface AttentionItem {
  id: string;
  title: string;
  status: string;
  next_step: string;
  last_activity_at: string;
  project_name: string;
}

export interface Overview {
  generatedAt: string;
  metrics: { projects: number; active: number; verifiedToday: number; needsAttention: number };
  projects: ProjectSummary[];
  attention: AttentionItem[];
  sourceCounts: Array<{ source: string; count: number }>;
  scan: Array<{ source: string; files: number; errors: number; last_scan: string }>;
  statusLabels: Record<string, string>;
}

export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  status: string;
  confidence: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  next_step: string;
  session_count: number;
  evidence_count: number;
  evidence: EvidenceRef[];
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

export interface ProjectDetailResponse {
  project: ProjectSummary;
  workItems: WorkItem[];
  timeline: TimelineEvent[];
  sources: Array<{ source: string; count: number }>;
  statusLabels: Record<string, string>;
}
