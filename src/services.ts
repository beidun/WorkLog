import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { WorklogDatabase } from "./db";
import { normalizeWhitespace, redactRawEvidence, redactSecrets, stableId, truncate } from "./utils";
import { latestProgressChanges } from "./progress-snapshots";
import { getWorkReportForDate } from "./work-reports";
import { latestRepositorySnapshot } from "./repository-snapshots";
import { getWorkItemCorrection } from "./work-item-corrections";
import { getProjectCorrection } from "./project-corrections";
import { getWorkItemFeedback } from "./work-item-feedback";

const STATUS_LABELS: Record<string, string> = {
  planned: "计划中",
  in_progress: "进行中",
  partially_done: "部分完成",
  done_unverified: "待验证",
  verified: "已验证",
  blocked: "阻塞",
  abandoned: "已放弃",
};

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
  headline: string;
  summary: string;
  counts: { total: number; planned: number; active: number; completed: number; unverified: number; blocked: number };
  active: ProjectProgressItem[];
  completed: ProjectProgressItem[];
  blocked: ProjectProgressItem[];
  workstreams: ProjectWorkstream[];
  nextSteps: Array<{ text: string; workItemId: string; evidenceIds: string[] }>;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
}

const PROJECT_STAGE_LABELS: Record<ProjectProgressStage, string> = {
  planning: "规划阶段",
  implementation: "开发推进",
  validation: "验证阶段",
  blocked: "存在阻塞",
  completed: "阶段完成",
  mixed: "多线推进",
};

function projectProgressItem(row: Record<string, unknown>, evidenceIds: string[] = []): ProjectProgressItem {
  return {
    id: String(row.id),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    status: String(row.status),
    nextStep: String(row.next_step ?? ""),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
    confidence: Number(row.confidence ?? 0),
    evidenceCount: Number(row.evidence_count ?? evidenceIds.length),
    evidenceIds,
  };
}

const WORKSTREAM_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
const GENERIC_WORKSTREAM_TOKENS = new Set([
  "项目", "工作", "当前", "进度", "事项", "功能", "内容", "问题", "处理", "完成", "实现", "优化", "开发",
  "测试", "验证", "检查", "支持", "接入", "添加", "修改", "继续", "进行", "使用", "整理", "分析", "历史",
  "对话", "相关", "新的", "第一", "版本", "完善", "补充", "已经", "服务", "工具", "代码", "系统",
]);

function workstreamTokens(value: string): Set<string> {
  const normalized = normalizeWhitespace(value.toLocaleLowerCase());
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    if (!GENERIC_WORKSTREAM_TOKENS.has(token)) tokens.add(token);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const token = run.slice(index, index + 2);
      if (!GENERIC_WORKSTREAM_TOKENS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function normalizedWorkstreamPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase();
}

function workstreamDate(item: ProjectProgressItem): number | null {
  if (!item.lastActivityAt) return null;
  const timestamp = Date.parse(item.lastActivityAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stageForItems(items: ProjectProgressItem[]): { stage: ProjectProgressStage; stageLabel: string; current: ProjectProgressItem; counts: ProjectWorkstream["counts"] } {
  const byRecent = (left: ProjectProgressItem, right: ProjectProgressItem) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
  const active = items.filter((item) => ["in_progress", "partially_done", "done_unverified"].includes(item.status)).sort(byRecent);
  const completed = items.filter((item) => item.status === "verified").sort(byRecent);
  const blocked = items.filter((item) => item.status === "blocked").sort(byRecent);
  const planned = items.filter((item) => item.status === "planned").sort(byRecent);
  const counts = {
    total: items.length,
    planned: planned.length,
    active: items.filter((item) => ["in_progress", "partially_done"].includes(item.status)).length,
    completed: completed.length,
    unverified: items.filter((item) => item.status === "done_unverified").length,
    blocked: blocked.length,
  };
  const current = blocked[0] ?? active[0] ?? planned[0] ?? completed[0] ?? items[0]!;
  const hasWork = active.length > 0 || planned.length > 0;
  let stage: ProjectProgressStage;
  if (blocked.length > 0) stage = "blocked";
  else if (hasWork && completed.length > 0) stage = "mixed";
  else if (active.length > 0) stage = "implementation";
  else if (counts.unverified > 0) stage = "validation";
  else if (planned.length > 0) stage = "planning";
  else stage = "completed";
  return { stage, stageLabel: PROJECT_STAGE_LABELS[stage], current, counts };
}

function automaticWorkstreams(database: WorklogDatabase, projectId: string, items: ProjectProgressItem[], includeEvidence: boolean): ProjectWorkstream[] {
  if (items.length === 0) return [];
  const fileRows = database.db.query(`
    SELECT wis.work_item_id,e.file_paths_json
    FROM work_item_sessions wis JOIN events e ON e.session_id=wis.session_id
    JOIN work_items wi ON wi.id=wis.work_item_id
    WHERE wi.project_id=?
  `).all(projectId) as Array<{ work_item_id: string; file_paths_json: string }>;
  const files = new Map<string, Set<string>>();
  for (const row of fileRows) {
    let values: unknown;
    try { values = JSON.parse(row.file_paths_json); } catch { values = []; }
    const paths = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string").map(normalizedWorkstreamPath).filter(Boolean) : [];
    const current = files.get(row.work_item_id) ?? new Set<string>();
    for (const path of paths) current.add(path);
    files.set(row.work_item_id, current);
  }
  const tokens = new Map(items.map((item) => [item.id, workstreamTokens(`${item.title} ${item.summary}`)]));
  const titleTokens = new Map(items.map((item) => [item.id, workstreamTokens(item.title)]));
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftDate = workstreamDate(items[left]!);
      const rightDate = workstreamDate(items[right]!);
      if (leftDate !== null && rightDate !== null && Math.abs(leftDate - rightDate) > WORKSTREAM_WINDOW_MS) continue;
      const leftTokens = tokens.get(items[left]!.id)!;
      const rightTokens = tokens.get(items[right]!.id)!;
      const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
      const similarity = overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
      const leftTitleTokens = titleTokens.get(items[left]!.id)!;
      const rightTitleTokens = titleTokens.get(items[right]!.id)!;
      const titleOverlapTokens = [...leftTitleTokens].filter((token) => rightTitleTokens.has(token));
      const titleHasEvidence = titleOverlapTokens.length >= 2
        || titleOverlapTokens.some((token) => /^[a-z0-9][a-z0-9_-]{3,}$/i.test(token));
      const leftFiles = files.get(items[left]!.id) ?? new Set<string>();
      const rightFiles = files.get(items[right]!.id) ?? new Set<string>();
      const sharedFiles = [...leftFiles].filter((path) => rightFiles.has(path)).length;
      // A single Chinese bigram can be a token crossing two generic words (for example “目功”).
      // Require two textual overlaps unless a shared file independently reinforces the link.
      if ((similarity >= 0.35 && titleHasEvidence) || (similarity >= 0.20 && overlap >= 1 && sharedFiles > 0)) union(left, right);
    }
  }
  const groups = new Map<number, ProjectProgressItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  const byRecent = (left: ProjectProgressItem, right: ProjectProgressItem) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
  return [...groups.values()].map((group) => {
    const ordered = group.slice().sort(byRecent);
    const progress = stageForItems(ordered);
    const evidenceIds = [...new Set(ordered.flatMap((item) => item.evidenceIds))];
    return {
      id: stableId("workstream", projectId, ...ordered.map((item) => item.id).sort()),
      title: progress.current.title,
      stage: progress.stage,
      stageLabel: progress.stageLabel,
      summary: progress.current.summary,
      items: ordered,
      counts: progress.counts,
      evidenceIds: includeEvidence ? evidenceIds : [],
      confidence: Math.round((ordered.reduce((sum, item) => sum + item.confidence, 0) / ordered.length) * 100) / 100,
    };
  }).sort((left, right) => {
    const leftItem = left.items[0];
    const rightItem = right.items[0];
    const leftPriority = left.stage === "blocked" ? 0 : left.stage === "implementation" ? 1 : left.stage === "validation" ? 2 : 3;
    const rightPriority = right.stage === "blocked" ? 0 : right.stage === "implementation" ? 1 : right.stage === "validation" ? 2 : 3;
    return leftPriority - rightPriority || (rightItem?.lastActivityAt ?? "").localeCompare(leftItem?.lastActivityAt ?? "");
  });
}

export function getProjectProgress(database: WorklogDatabase, projectId: string, includeEvidence = false): ProjectProgress | null {
  const rows = database.db.query(`
    SELECT wi.id,wi.title,wi.summary,wi.status,wi.next_step,wi.last_activity_at,wi.confidence,
      (SELECT COUNT(*) FROM work_item_evidence wie WHERE wie.work_item_id=wi.id) AS evidence_count
    FROM work_items wi WHERE wi.project_id=?
    ORDER BY CASE wi.status
      WHEN 'blocked' THEN 0 WHEN 'partially_done' THEN 1 WHEN 'in_progress' THEN 2
      WHEN 'done_unverified' THEN 3 WHEN 'planned' THEN 4 WHEN 'verified' THEN 5 ELSE 6 END,
      wi.last_activity_at DESC,wi.id
  `).all(projectId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;

  const itemEvidence = new Map<string, string[]>();
  if (includeEvidence) {
    const evidenceRows = database.db.query(`
      SELECT wie.work_item_id,wie.event_id
      FROM work_item_evidence wie JOIN work_items wi ON wi.id=wie.work_item_id
      WHERE wi.project_id=? ORDER BY wie.work_item_id,wie.event_id
    `).all(projectId) as Array<{ work_item_id: string; event_id: string }>;
    for (const row of evidenceRows) itemEvidence.set(row.work_item_id, [...(itemEvidence.get(row.work_item_id) ?? []), row.event_id]);
  }
  const items = rows.map((row) => projectProgressItem(row, itemEvidence.get(String(row.id)) ?? []));
  const byRecent = (left: ProjectProgressItem, right: ProjectProgressItem) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
  const active = items.filter((item) => ["in_progress", "partially_done", "done_unverified"].includes(item.status)).sort(byRecent);
  const completed = items.filter((item) => item.status === "verified").sort(byRecent);
  const blocked = items.filter((item) => item.status === "blocked").sort(byRecent);
  const planned = items.filter((item) => item.status === "planned").sort(byRecent);
  const counts = {
    total: items.length,
    planned: planned.length,
    active: items.filter((item) => ["in_progress", "partially_done"].includes(item.status)).length,
    completed: completed.length,
    unverified: items.filter((item) => item.status === "done_unverified").length,
    blocked: blocked.length,
  };
  const current = items.find((item) => item.status === "blocked") ?? active[0] ?? planned[0] ?? completed[0] ?? items[0]!;
  const hasCompleted = completed.length > 0;
  const hasWork = active.length > 0 || planned.length > 0;
  let stage: ProjectProgressStage;
  if (blocked.length > 0) stage = "blocked";
  else if (hasWork && hasCompleted) stage = "mixed";
  else if (active.length > 0) stage = "implementation";
  else if (counts.unverified > 0) stage = "validation";
  else if (planned.length > 0) stage = "planning";
  else stage = "completed";

  const stageLabel = PROJECT_STAGE_LABELS[stage];
  const headline = blocked.length > 0
    ? `当前受阻：${blocked[0]!.title}`
    : active.length > 0
      ? `当前推进：${active[0]!.title}`
      : counts.unverified > 0
        ? `待验证：${items.find((item) => item.status === "done_unverified")!.title}`
        : completed.length > 0
          ? `最近完成：${completed[0]!.title}`
          : `当前阶段：${current.title}`;
  const summaryParts = [];
  if (counts.completed > 0) summaryParts.push(`已完成 ${counts.completed} 项`);
  if (counts.active > 0) summaryParts.push(`正在推进 ${counts.active} 项`);
  if (counts.unverified > 0) summaryParts.push(`待验证 ${counts.unverified} 项`);
  if (counts.blocked > 0) summaryParts.push(`受阻 ${counts.blocked} 项`);
  if (counts.planned > 0) summaryParts.push(`规划中 ${counts.planned} 项`);
  const summary = `${current.summary}${summaryParts.length > 0 ? `；${summaryParts.join("，")}` : ""}`.slice(0, 360);
  const nextSteps = [...blocked, ...active, ...planned]
    .filter((item) => item.nextStep)
    .slice(0, 5)
    .map((item) => ({ text: item.nextStep, workItemId: item.id, evidenceIds: item.evidenceIds }));
  const confidence = Math.round((items.reduce((sum, item) => sum + item.confidence, 0) / items.length) * 100) / 100;
  const evidence = includeEvidence ? database.db.query(`
    SELECT DISTINCT e.id,e.source,e.source_file,e.source_line,e.event_type,e.tool_name,e.timestamp,e.is_error,
      wie.evidence_kind,
      substr(COALESCE(NULLIF(e.command,''),NULLIF(e.content,''),e.tool_name,e.event_type),1,180) AS preview
    FROM work_item_evidence wie JOIN events e ON e.id=wie.event_id JOIN work_items wi ON wi.id=wie.work_item_id
    WHERE wi.project_id=? ORDER BY e.timestamp DESC,e.source_line DESC LIMIT 8
  `).all(projectId) as Array<Record<string, unknown>> : [];
  const workstreams = automaticWorkstreams(database, projectId, items, includeEvidence);
  return { stage, stageLabel, headline, summary, counts, active, completed: completed.slice(0, 5), blocked, workstreams, nextSteps, evidence, confidence };
}

export function getOverview(database: WorklogDatabase) {
  const db = database.db;
  const projectRows = db.query(`
    SELECT p.id, p.name, p.root_path, p.git_remote, p.last_activity_at,
      COUNT(DISTINCT wi.id) AS work_count,
      COUNT(DISTINCT CASE WHEN wi.status='verified' THEN wi.id END) AS verified_count,
      COUNT(DISTINCT CASE WHEN wi.status IN ('in_progress','partially_done') THEN wi.id END) AS active_count,
      COUNT(DISTINCT CASE WHEN wi.status='done_unverified' THEN wi.id END) AS unverified_count,
      COUNT(DISTINCT CASE WHEN wi.status='blocked' THEN wi.id END) AS blocked_count,
      GROUP_CONCAT(DISTINCT s.source) AS sources
    FROM projects p
    LEFT JOIN work_items wi ON wi.project_id=p.id
    LEFT JOIN work_item_sessions wis ON wis.work_item_id=wi.id
    LEFT JOIN sessions s ON s.id=wis.session_id
    GROUP BY p.id
    HAVING COUNT(DISTINCT wi.id) > 0
    ORDER BY p.last_activity_at DESC
  `).all() as Array<Record<string, unknown> & { id: string }>;
  const projects = projectRows.map((project) => {
    const progress = getProjectProgress(database, project.id);
    return { ...project, current_focus: progress?.summary ?? null, progress };
  });
  const workItems = db.query("SELECT status, last_activity_at FROM work_items").all() as Array<{ status: string; last_activity_at: string | null }>;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const todayItems = workItems.filter((item) => item.last_activity_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(item.last_activity_at)) === today);
  const sourceCounts = db.query("SELECT source, COUNT(*) AS count FROM sessions WHERE is_subagent=0 GROUP BY source").all();
  const scan = db.query("SELECT source, COUNT(*) AS files, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors, MAX(scanned_at) AS last_scan FROM source_files GROUP BY source").all();
  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      projects: projects.length,
      active: workItems.filter((item) => ["in_progress", "partially_done"].includes(item.status)).length,
      verifiedToday: todayItems.filter((item) => item.status === "verified").length,
      needsAttention: workItems.filter((item) => ["blocked", "partially_done", "done_unverified"].includes(item.status)).length,
    },
    projects,
    attention: db.query(`SELECT wi.id, wi.title, wi.summary, wi.status, wi.next_step, wi.last_activity_at,
      wi.project_id, p.name AS project_name
      FROM work_items wi JOIN projects p ON p.id=wi.project_id
      WHERE wi.status IN ('blocked','done_unverified','partially_done')
      ORDER BY CASE wi.status WHEN 'blocked' THEN 0 WHEN 'partially_done' THEN 1 ELSE 2 END, wi.last_activity_at DESC LIMIT 8`).all(),
    sourceCounts,
    scan,
    recentChanges: latestProgressChanges(database, 8).map((change) => ({
      id: change.id,
      projectId: change.projectId,
      projectName: change.projectName,
      workItemId: change.workItemId,
      changeType: change.changeType,
      title: change.title,
      detectedAt: change.detectedAt,
      evidenceIds: change.evidenceIds,
    })),
    statusLabels: STATUS_LABELS,
  };
}

export function getProject(database: WorklogDatabase, id: string) {
  const db = database.db;
  const project = db.query("SELECT * FROM projects WHERE id=?").get(id);
  if (!project) return null;
  const workItemRows = db.query(`
    SELECT wi.*,
      (SELECT COUNT(*) FROM work_item_sessions wis WHERE wis.work_item_id=wi.id) AS session_count,
      (SELECT COUNT(*) FROM work_item_evidence wie WHERE wie.work_item_id=wi.id) AS evidence_count
    FROM work_items wi WHERE wi.project_id=? ORDER BY wi.last_activity_at DESC
  `).all(id) as Array<Record<string, unknown> & { id: string }>;
  const workItems = workItemRows.map((item) => ({
    ...item,
    correction: getWorkItemCorrection(database, item.id),
    projectCorrection: getProjectCorrection(database, item.id),
    feedback: getWorkItemFeedback(database, item.id),
    evidence: getWorkItemEvidence(database, item.id),
    progress: getWorkItemProgress(database, item.id),
  }));
  const timeline = db.query(`
    SELECT e.id, e.event_type, e.timestamp, e.tool_name, e.is_error, e.content, e.command,
      e.source, e.session_id, e.source_file, e.source_line,
      COALESCE(s.title, '未命名会话') AS session_title
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE EXISTS (
      SELECT 1 FROM work_item_sessions wis JOIN work_items wi ON wi.id=wis.work_item_id
      WHERE wi.project_id=? AND (
        wis.session_id=e.session_id OR EXISTS (
          SELECT 1 FROM sessions child WHERE child.id=e.session_id AND child.parent_session_id=wis.session_id
        )
      )
    ) AND (e.event_type IN ('user_message','assistant_message','tool_call','tool_result'))
    ORDER BY e.timestamp DESC, e.source_line DESC LIMIT 120
  `).all(id);
  const sources = db.query(`
    SELECT s.source, COUNT(*) AS count
    FROM sessions s
    WHERE s.is_subagent=0 AND EXISTS (
      SELECT 1 FROM work_item_sessions wis JOIN work_items wi ON wi.id=wis.work_item_id
      WHERE wis.session_id=s.id AND wi.project_id=?
    ) GROUP BY s.source
  `).all(id);
  const projectOptions = db.query(`
    SELECT p.id, p.name, p.root_path,
      COUNT(DISTINCT wi.id) AS work_count
    FROM projects p LEFT JOIN work_items wi ON wi.project_id=p.id
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id
  `).all();
  return { project, progress: getProjectProgress(database, id, true), repository: latestRepositorySnapshot(database, id), workItems, timeline, sources, projectOptions, statusLabels: STATUS_LABELS };
}

async function readRawContext(sourceFile: string, sourceLine: number): Promise<Array<{ source_line: number; raw: string }>> {
  const rows: Array<{ source_line: number; raw: string }> = [];
  const start = Math.max(1, sourceLine - 3);
  const end = sourceLine + 3;
  try {
    const stream = createReadStream(sourceFile, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0;
    for await (const raw of lines) {
      line += 1;
      if (line >= start && line <= end) rows.push({ source_line: line, raw: truncate(redactRawEvidence(raw), 12_000) ?? "" });
      if (line > end) break;
    }
    lines.close();
    stream.destroy();
  } catch {
    return [];
  }
  return rows;
}

export async function getEvidence(database: WorklogDatabase, id: string) {
  const db = database.db;
  const event = db.query(`SELECT e.*, s.external_id, s.title AS session_title FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.id=?`).get(id) as { session_id: string; source_line: number } | null;
  if (!event) return null;
  const context = db.query(`
    SELECT id, event_type, role, timestamp, tool_name, content, command, is_error, source_line
    FROM events WHERE session_id=? AND source_line BETWEEN ? AND ? ORDER BY source_line
  `).all(event.session_id, Math.max(1, event.source_line - 3), event.source_line + 3);
  const rawContext = await readRawContext(String((event as Record<string, unknown>).source_file), event.source_line);
  return { event, context, rawContext };
}

function getWorkItemEvidence(database: WorklogDatabase, workItemId: string) {
  return database.db.query(`
    SELECT e.id, e.source, e.source_file, e.source_line, e.event_type, e.tool_name,
      e.timestamp, e.is_error, wie.evidence_kind,
      substr(COALESCE(NULLIF(e.command, ''), NULLIF(e.content, ''), e.tool_name, e.event_type), 1, 180) AS preview
    FROM work_item_evidence wie JOIN events e ON e.id=wie.event_id
    WHERE wie.work_item_id=?
    ORDER BY e.timestamp DESC, e.source_line DESC LIMIT 8
  `).all(workItemId);
}

function stringList(value: string): string[] {
  try { return JSON.parse(value) as string[]; } catch { return []; }
}

function getWorkItemProgress(database: WorklogDatabase, workItemId: string) {
  const segmentRows = database.db.query(`
    SELECT ws.objective,ws.headline,ws.progress_summary,ws.completed_json,ws.validations_json,
      ws.blockers_json,ws.remaining_json,ws.status,ws.next_step,ws.last_event_at
    FROM work_item_segments wis JOIN work_segments ws ON ws.id=wis.segment_id
    WHERE wis.work_item_id=? ORDER BY ws.last_event_at DESC,ws.ordinal DESC
  `).all(workItemId) as Array<{
    objective: string; headline: string; progress_summary: string; completed_json: string;
    validations_json: string; blockers_json: string; remaining_json: string;
    status: string; next_step: string; last_event_at: string | null;
  }>;
  if (segmentRows.length > 0) {
    const latest = segmentRows[0]!;
    const unique = (values: string[][], limit = 5) => [...new Set(values.flat())].slice(0, limit);
    const facts = database.db.query(`
      SELECT sf.fact_kind AS kind,sf.text,sf.confidence,
        e.id,e.source,e.source_file,e.source_line,e.event_type,e.tool_name,
        e.timestamp,e.is_error,sf.fact_kind AS evidence_kind,sf.text AS preview
      FROM work_item_segments wis
      JOIN work_segment_facts sf ON sf.segment_id=wis.segment_id
      JOIN events e ON e.id=sf.event_id
      WHERE wis.work_item_id=?
      ORDER BY sf.rank LIMIT 12
    `).all(workItemId);
    return {
      objective: latest.objective,
      headline: latest.headline,
      summary: latest.progress_summary,
      status: latest.status,
      nextStep: latest.next_step,
      completed: unique(segmentRows.map((row) => stringList(row.completed_json))),
      validations: unique(segmentRows.map((row) => stringList(row.validations_json))),
      blockers: latest.status === "blocked" ? stringList(latest.blockers_json) : [],
      remaining: ["verified", "abandoned"].includes(latest.status) ? [] : stringList(latest.remaining_json),
      facts,
    };
  }
  const rows = database.db.query(`
    SELECT d.objective,d.headline,d.progress_summary,d.completed_json,d.validations_json,
      d.blockers_json,d.remaining_json,d.status,d.next_step,d.last_event_at
    FROM work_item_sessions wis JOIN session_digests d ON d.session_id=wis.session_id
    WHERE wis.work_item_id=? ORDER BY d.last_event_at DESC
  `).all(workItemId) as Array<{
    objective: string; headline: string; progress_summary: string; completed_json: string;
    validations_json: string; blockers_json: string; remaining_json: string;
    status: string; next_step: string; last_event_at: string | null;
  }>;
  const latest = rows[0];
  if (!latest) return null;
  const unique = (values: string[][], limit = 5) => [...new Set(values.flat())].slice(0, limit);
  const facts = database.db.query(`
    SELECT sf.fact_kind AS kind, sf.text, sf.confidence,
      e.id, e.source, e.source_file, e.source_line, e.event_type, e.tool_name,
      e.timestamp, e.is_error, sf.fact_kind AS evidence_kind, sf.text AS preview
    FROM work_item_sessions wis
    JOIN session_facts sf ON sf.session_id=wis.session_id
    JOIN session_digests d ON d.session_id=sf.session_id
    JOIN events e ON e.id=sf.event_id
    WHERE wis.work_item_id=?
    ORDER BY d.last_event_at DESC,
      CASE sf.fact_kind WHEN 'finding' THEN 0 WHEN 'change' THEN 1 WHEN 'validation' THEN 2 WHEN 'risk' THEN 3 ELSE 4 END,
      sf.rank LIMIT 12
  `).all(workItemId);
  return {
    objective: latest.objective,
    headline: latest.headline,
    summary: latest.progress_summary,
    status: latest.status,
    nextStep: latest.next_step,
    completed: unique(rows.map((row) => stringList(row.completed_json))),
    validations: unique(rows.map((row) => stringList(row.validations_json))),
    blockers: latest.status === "blocked" ? stringList(latest.blockers_json) : [],
    remaining: ["verified", "abandoned"].includes(latest.status) ? [] : stringList(latest.remaining_json),
    facts,
  };
}

export function getDailyReport(database: WorklogDatabase, date?: string) {
  const target = date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  return getWorkReportForDate(database, target);
}
