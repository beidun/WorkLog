import type { WorklogDatabase } from "./db";
import { normalizeWhitespace } from "./utils";

export type WorkReportRange = "today" | "yesterday" | "week";
export type WorkReportCategory = "active" | "completed" | "unverified" | "blocked";
export type WorkReportActivityKind = "today" | "carryover";

export interface ReportEvidence {
  id: string;
  source: string;
  source_file: string;
  source_line: number;
  event_type: string;
  tool_name: string | null;
  timestamp: string | null;
  evidence_kind: string;
  preview: string;
}

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
  evidence: ReportEvidence[];
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
}

export interface WorkReportChange {
  id: string;
  projectId: string;
  projectName: string;
  workItemId: string;
  type: string;
  title: string;
  detectedAt: string;
  evidence: ReportEvidence[];
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
  changes: WorkReportChange[];
  statusLabels: Record<string, string>;
}

const STATUS_LABELS: Record<string, string> = {
  planned: "计划中",
  in_progress: "进行中",
  partially_done: "部分完成",
  done_unverified: "待验证",
  verified: "已验证",
  blocked: "阻塞",
  abandoned: "已放弃",
};

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

function utcCalendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatUtcCalendar(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function shiftDate(value: string, days: number): string {
  const date = utcCalendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcCalendar(date);
}

function startInstant(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && formatUtcCalendar(utcCalendarDate(value)) === value;
}

export function workReportPeriod(range: WorkReportRange, now = new Date()) {
  const today = SHANGHAI_DATE.format(now);
  if (range === "yesterday") {
    const date = shiftDate(today, -1);
    return { range, label: "昨天", startDate: date, endDate: date, startAt: startInstant(date), endAt: startInstant(today) };
  }
  if (range === "week") {
    const calendar = utcCalendarDate(today);
    const weekday = calendar.getUTCDay();
    const mondayOffset = weekday === 0 ? 6 : weekday - 1;
    const startDate = shiftDate(today, -mondayOffset);
    return { range, label: "本周", startDate, endDate: today, startAt: startInstant(startDate), endAt: startInstant(shiftDate(today, 1)) };
  }
  return { range, label: "今天", startDate: today, endDate: today, startAt: startInstant(today), endAt: startInstant(shiftDate(today, 1)) };
}

export function dateReportPeriod(date: string) {
  if (!validDate(date)) throw new Error("date must use YYYY-MM-DD");
  return { range: "date" as const, label: date, startDate: date, endDate: date, startAt: startInstant(date), endAt: startInstant(shiftDate(date, 1)) };
}

function stringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function unique(values: string[][], maximum = 6): string[] {
  return [...new Set(values.flat())].slice(0, maximum);
}

function category(status: string): WorkReportCategory {
  if (status === "blocked") return "blocked";
  if (status === "verified") return "completed";
  if (status === "done_unverified") return "unverified";
  return "active";
}

function evidenceRows(
  database: WorklogDatabase,
  sessionIds: string[],
  period: { startAt: string; endAt: string },
  maximum = 6,
  allowFallback = true,
): ReportEvidence[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(",");
  const select = `
    SELECT DISTINCT e.id,e.source,e.source_file,e.source_line,e.event_type,e.tool_name,e.timestamp,
      sde.digest_section AS evidence_kind,
      substr(COALESCE(NULLIF(e.command,''),NULLIF(e.content,''),e.tool_name,e.event_type),1,180) AS preview
    FROM session_digest_evidence sde JOIN events e ON e.id=sde.event_id
    WHERE sde.session_id IN (${placeholders})`;
  const order = ` ORDER BY CASE sde.digest_section WHEN 'validation' THEN 0 WHEN 'completed' THEN 1 WHEN 'blocker' THEN 2 ELSE 3 END,
    e.timestamp DESC,e.source_line DESC LIMIT ?`;
  const inPeriod = database.db.query(`${select} AND e.timestamp>=? AND e.timestamp<?${order}`)
    .all(...sessionIds, period.startAt, period.endAt, maximum) as ReportEvidence[];
  if (inPeriod.length > 0 || !allowFallback) return inPeriod;
  return database.db.query(`${select}${order}`).all(...sessionIds, maximum) as ReportEvidence[];
}

function segmentEvidenceRows(
  database: WorklogDatabase,
  segmentIds: string[],
  period: { startAt: string; endAt: string },
  maximum = 6,
  allowFallback = true,
): ReportEvidence[] {
  if (segmentIds.length === 0) return [];
  const placeholders = segmentIds.map(() => "?").join(",");
  const select = `
    SELECT DISTINCT e.id,e.source,e.source_file,e.source_line,e.event_type,e.tool_name,e.timestamp,
      wse.digest_section AS evidence_kind,
      substr(COALESCE(NULLIF(e.command,''),NULLIF(e.content,''),e.tool_name,e.event_type),1,180) AS preview
    FROM work_segment_evidence wse JOIN events e ON e.id=wse.event_id
    WHERE wse.segment_id IN (${placeholders})`;
  const order = ` ORDER BY CASE wse.digest_section WHEN 'validation' THEN 0 WHEN 'completed' THEN 1 WHEN 'blocker' THEN 2 ELSE 3 END,
    e.timestamp DESC,e.source_line DESC LIMIT ?`;
  const inPeriod = database.db.query(`${select} AND e.timestamp>=? AND e.timestamp<?${order}`)
    .all(...segmentIds, period.startAt, period.endAt, maximum) as ReportEvidence[];
  if (inPeriod.length > 0 || !allowFallback) return inPeriod;
  return database.db.query(`${select}${order}`).all(...segmentIds, maximum) as ReportEvidence[];
}

function evidenceByIds(database: WorklogDatabase, ids: string[], maximum = 4): ReportEvidence[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database.db.query(`
    SELECT e.id,e.source,e.source_file,e.source_line,e.event_type,e.tool_name,e.timestamp,
      'change' AS evidence_kind,
      substr(COALESCE(NULLIF(e.command,''),NULLIF(e.content,''),e.tool_name,e.event_type),1,180) AS preview
    FROM events e WHERE e.id IN (${placeholders}) ORDER BY e.timestamp DESC,e.source_line DESC LIMIT ?
  `).all(...ids, maximum) as ReportEvidence[];
}

function projectSummary(counts: WorkReportProject["counts"]): string {
  const parts: string[] = [];
  if (counts.completed) parts.push(`${counts.completed} 项已验证`);
  if (counts.unverified) parts.push(`${counts.unverified} 项待验证`);
  if (counts.active) parts.push(`${counts.active} 项正在推进`);
  if (counts.blocked) parts.push(`${counts.blocked} 项受阻`);
  if (counts.validations) parts.push(`${counts.validations} 条验证记录`);
  return parts.join("，") || "该时间范围内有工作记录";
}

type ReportCounts = WorkReportProject["counts"];

type ReportDigest = {
  segment_id: string | null;
  session_id: string;
  headline: string;
  progress_summary: string;
  completed_json: string;
  validations_json: string;
  blockers_json: string;
  remaining_json: string;
  status: string;
  next_step: string;
  last_event_at: string | null;
};

function countsForItems(items: WorkReportItem[]): ReportCounts {
  return {
    active: items.filter((item) => item.category === "active").length,
    completed: items.filter((item) => item.category === "completed").length,
    unverified: items.filter((item) => item.category === "unverified").length,
    blocked: items.filter((item) => item.category === "blocked").length,
    validations: items.reduce((sum, item) => sum + item.validations.length, 0),
  };
}

function currentCounts(candidates: Array<{ project_id: string; status: string }>, projectId: string): ReportCounts {
  const projectItems = candidates.filter((item) => item.project_id === projectId);
  return {
    active: projectItems.filter((item) => !["verified", "done_unverified", "abandoned", "blocked"].includes(item.status)).length,
    completed: projectItems.filter((item) => item.status === "verified").length,
    unverified: projectItems.filter((item) => item.status === "done_unverified").length,
    blocked: projectItems.filter((item) => item.status === "blocked").length,
    validations: 0,
  };
}

function currentSummary(counts: ReportCounts): string {
  const parts: string[] = [];
  if (counts.completed) parts.push(`${counts.completed} 项已验证`);
  if (counts.unverified) parts.push(`${counts.unverified} 项待验证`);
  if (counts.active) parts.push(`${counts.active} 项正在推进`);
  if (counts.blocked) parts.push(`${counts.blocked} 项受阻`);
  return parts.join("，") || "暂无未结束工作事项";
}

function projectTodaySummary(items: WorkReportItem[]): string {
  if (items.length === 0) return "本时段没有新的对话活动";
  const entries = items.slice(0, 3).map((item) => {
    const concreteChange = item.changeSummary.find((value) => !value.startsWith("今天有 "));
    return `${item.title}：${concreteChange ?? item.summary}`;
  });
  const suffix = items.length > entries.length ? ` 等 ${items.length} 项` : "";
  const text = `${entries.join("；")}${suffix}`;
  return text.length <= 180 ? text : `${text.slice(0, 179)}…`;
}

function changedValues(current: string[], previous: string[]): string[] {
  const previousSet = new Set(previous);
  return current.filter((value) => !previousSet.has(value));
}

function changeSummary(
  kind: WorkReportActivityKind,
  status: string,
  today: ReportDigest[],
  previous: ReportDigest[],
): string[] {
  if (kind === "carryover") return ["本时间范围没有新的对话活动，沿用历史状态"];
  const completed = unique(today.map((item) => stringList(item.completed_json)));
  const previousCompleted = unique(previous.map((item) => stringList(item.completed_json)));
  const validations = unique(today.map((item) => stringList(item.validations_json)));
  const previousValidations = unique(previous.map((item) => stringList(item.validations_json)));
  const blockers = unique(today.map((item) => stringList(item.blockers_json)));
  const previousBlockers = unique(previous.map((item) => stringList(item.blockers_json)));
  const changes: string[] = [];
  const newCompleted = changedValues(completed, previousCompleted);
  const newValidations = changedValues(validations, previousValidations);
  const newBlockers = changedValues(blockers, previousBlockers);
  if (newCompleted.length) changes.push(`完成：${newCompleted.join("、")}`);
  if (newValidations.length) changes.push(`验证：${newValidations.join("、")}`);
  if (newBlockers.length) changes.push(`阻塞：${newBlockers.join("、")}`);
  const previousStatus = previous[0]?.status;
  if (previousStatus === "blocked" && status !== "blocked") changes.push("阻塞已解除");
  if (previousStatus && previousStatus !== status) {
    changes.push(`状态：${STATUS_LABELS[previousStatus] ?? previousStatus} → ${STATUS_LABELS[status] ?? status}`);
  }
  const latest = today[0];
  const prior = previous[0];
  if (latest && prior && normalizeWhitespace(latest.progress_summary) !== normalizeWhitespace(prior.progress_summary) && latest.progress_summary) {
    changes.push(`进展：${latest.progress_summary}`);
  }
  if (latest && prior && normalizeWhitespace(latest.next_step) !== normalizeWhitespace(prior.next_step) && latest.next_step) {
    changes.push(`下一步更新：${latest.next_step}`);
  }
  if (changes.length === 0 && today.length > 0) {
    changes.push(`本时段有 ${today.length} 段对话活动，当前为${STATUS_LABELS[status] ?? status}`);
  }
  return changes;
}

function makeReportItem(
  candidate: { id: string; project_id: string; project_name: string; title: string; summary: string; status: string; next_step: string },
  kind: WorkReportActivityKind,
  digests: ReportDigest[],
  previous: ReportDigest[],
  evidence: ReportEvidence[],
): WorkReportItem | null {
  const latest = digests[0];
  if (!latest || !latest.last_event_at || evidence.length === 0) return null;
  const reportStatus = latest.segment_id === null ? candidate.status : latest.status;
  return {
    id: candidate.id,
    projectId: candidate.project_id,
    projectName: candidate.project_name,
    title: candidate.title,
    summary: latest.progress_summary || candidate.summary,
    status: reportStatus,
    category: category(reportStatus),
    completed: unique(digests.map((item) => stringList(item.completed_json))),
    validations: unique(digests.map((item) => stringList(item.validations_json))),
    blockers: reportStatus === "blocked" ? stringList(latest.blockers_json) : [],
    remaining: ["verified", "abandoned"].includes(reportStatus) ? [] : stringList(latest.remaining_json),
    nextStep: latest.next_step || candidate.next_step,
    lastActivityAt: latest.last_event_at,
    evidence,
    activityKind: kind,
    changeSummary: changeSummary(kind, reportStatus, digests, previous),
  };
}

function buildReport(database: WorklogDatabase, period: ReturnType<typeof workReportPeriod> | ReturnType<typeof dateReportPeriod>): WorkReport {
  const db = database.db;
  const candidates = db.query(`
    SELECT wi.id,wi.project_id,p.name AS project_name,wi.title,wi.summary,wi.status,COALESCE(wi.next_step,'') AS next_step
    FROM work_items wi JOIN projects p ON p.id=wi.project_id
    ORDER BY p.name,wi.id
  `).all() as Array<{
    id: string; project_id: string; project_name: string; title: string; summary: string; status: string; next_step: string;
  }>;

  const items: WorkReportItem[] = [];
  const carryoverItems: WorkReportItem[] = [];
  for (const candidate of candidates) {
    const hasSegments = Boolean(db.query("SELECT 1 FROM work_item_segments WHERE work_item_id=? LIMIT 1").get(candidate.id));
    const allDigests = (hasSegments ? db.query(`
      SELECT ws.id AS segment_id,ws.session_id,ws.headline,ws.progress_summary,ws.completed_json,ws.validations_json,ws.blockers_json,
        ws.remaining_json,ws.status,ws.next_step,ws.last_event_at
      FROM work_item_segments wis JOIN work_segments ws ON ws.id=wis.segment_id
      WHERE wis.work_item_id=? ORDER BY ws.last_event_at DESC,ws.id
    `).all(candidate.id) : db.query(`
      SELECT NULL AS segment_id,d.session_id,d.headline,d.progress_summary,d.completed_json,d.validations_json,d.blockers_json,
        d.remaining_json,d.status,d.next_step,d.last_event_at
      FROM work_item_sessions wis JOIN session_digests d ON d.session_id=wis.session_id
      WHERE wis.work_item_id=? ORDER BY d.last_event_at DESC,d.session_id
    `).all(candidate.id)) as ReportDigest[];
    const digests = allDigests.filter((item) => Boolean(item.last_event_at && item.last_event_at >= period.startAt && item.last_event_at < period.endAt));
    const previous = allDigests.filter((item) => Boolean(item.last_event_at && item.last_event_at < period.startAt));

    if (digests.length > 0) {
      const evidence = hasSegments
        ? segmentEvidenceRows(database, digests.map((item) => item.segment_id!).filter(Boolean), period, 6, false)
        : evidenceRows(database, digests.map((item) => item.session_id), period, 6, false);
      const item = makeReportItem(candidate, "today", digests, previous, evidence);
      if (item) items.push(item);
    }

    // A daily report should make historical state visible without presenting it as new progress.
    // Only non-terminal items are carried over, and only when we can cite their previous activity.
    if (digests.length === 0 && previous.length > 0 && !["verified", "abandoned"].includes(candidate.status)) {
      const evidence = hasSegments
        ? segmentEvidenceRows(database, previous.map((item) => item.segment_id!).filter(Boolean), period)
        : evidenceRows(database, previous.map((item) => item.session_id), period);
      const item = makeReportItem(candidate, "carryover", [previous[0]!], previous.slice(1), evidence);
      if (item) carryoverItems.push(item);
    }
  }

  const projectIds = [...new Set([...items, ...carryoverItems].map((item) => item.projectId))];
  const projects = projectIds.map((projectId) => {
    const projectItems = items.filter((item) => item.projectId === projectId).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const projectCarryover = carryoverItems.filter((item) => item.projectId === projectId)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const allProjectItems = [...projectItems, ...projectCarryover].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const counts = countsForItems(projectItems);
    const current = currentCounts(candidates, projectId);
    const todaySummary = projectTodaySummary(projectItems);
    return {
      id: projectId,
      name: allProjectItems[0].projectName,
      summary: todaySummary,
      todaySummary,
      currentSummary: currentSummary(current),
      items: projectItems,
      carryoverItems: projectCarryover,
      counts,
    };
  }).sort((a, b) => {
    const aLast = [...a.items, ...a.carryoverItems].sort((x, y) => y.lastActivityAt.localeCompare(x.lastActivityAt))[0]?.lastActivityAt ?? "";
    const bLast = [...b.items, ...b.carryoverItems].sort((x, y) => y.lastActivityAt.localeCompare(x.lastActivityAt))[0]?.lastActivityAt ?? "";
    return bLast.localeCompare(aLast);
  });

  const changes = (db.query(`
    SELECT * FROM progress_changes WHERE detected_at>=? AND detected_at<? ORDER BY detected_at DESC,id LIMIT 30
  `).all(period.startAt, period.endAt) as Array<{
    id: string; project_id: string; project_name: string; work_item_id: string; change_type: string;
    title: string; detected_at: string; evidence_ids_json: string;
  }>).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    workItemId: row.work_item_id,
    type: row.change_type,
    title: row.title,
    detectedAt: row.detected_at,
    evidence: evidenceByIds(database, stringList(row.evidence_ids_json)),
  })).filter((change) => change.evidence.length > 0);

  const metrics = {
    active: items.filter((item) => item.category === "active").length,
    completed: items.filter((item) => item.category === "completed").length,
    unverified: items.filter((item) => item.category === "unverified").length,
    blocked: items.filter((item) => item.category === "blocked").length,
    validations: items.reduce((sum, item) => sum + item.validations.length, 0),
    changedProjects: projects.filter((project) => project.items.length > 0).length,
    changedItems: items.length,
    carryoverItems: carryoverItems.length,
  };
  return {
    ...period,
    generatedAt: new Date().toISOString(),
    projectCount: projects.length,
    itemCount: items.length,
    metrics,
    projects,
    changes,
    statusLabels: STATUS_LABELS,
  };
}

export function getWorkReport(database: WorklogDatabase, range: WorkReportRange = "today", now = new Date()): WorkReport {
  if (!["today", "yesterday", "week"].includes(range)) throw new Error("range must be today, yesterday or week");
  return buildReport(database, workReportPeriod(range, now));
}

export function getWorkReportForDate(database: WorklogDatabase, date: string): WorkReport {
  return buildReport(database, dateReportPeriod(date));
}
