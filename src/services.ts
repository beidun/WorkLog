import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { WorklogDatabase } from "./db";
import { redactSecrets, truncate } from "./utils";

const STATUS_LABELS: Record<string, string> = {
  planned: "计划中",
  in_progress: "进行中",
  partially_done: "部分完成",
  done_unverified: "待验证",
  verified: "已验证",
  blocked: "阻塞",
  abandoned: "已放弃",
};

export function getOverview(database: WorklogDatabase) {
  const db = database.db;
  const projects = db.query(`
    SELECT p.id, p.name, p.root_path, p.git_remote, p.last_activity_at,
      COUNT(DISTINCT wi.id) AS work_count,
      COUNT(DISTINCT CASE WHEN wi.status='verified' THEN wi.id END) AS verified_count,
      COUNT(DISTINCT CASE WHEN wi.status IN ('in_progress','partially_done') THEN wi.id END) AS active_count,
      COUNT(DISTINCT CASE WHEN wi.status='done_unverified' THEN wi.id END) AS unverified_count,
      COUNT(DISTINCT CASE WHEN wi.status='blocked' THEN wi.id END) AS blocked_count,
      (SELECT title FROM work_items recent WHERE recent.project_id=p.id ORDER BY recent.last_activity_at DESC LIMIT 1) AS current_focus,
      GROUP_CONCAT(DISTINCT s.source) AS sources
    FROM projects p
    LEFT JOIN work_items wi ON wi.project_id=p.id
    LEFT JOIN sessions s ON s.project_id=p.id
    GROUP BY p.id
    HAVING COUNT(DISTINCT wi.id) > 0
    ORDER BY p.last_activity_at DESC
  `).all();
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
      needsAttention: workItems.filter((item) => ["blocked", "done_unverified"].includes(item.status)).length,
    },
    projects,
    attention: db.query(`SELECT wi.id, wi.title, wi.status, wi.next_step, wi.last_activity_at, p.name AS project_name
      FROM work_items wi JOIN projects p ON p.id=wi.project_id
      WHERE wi.status IN ('blocked','done_unverified','partially_done')
      ORDER BY CASE wi.status WHEN 'blocked' THEN 0 WHEN 'partially_done' THEN 1 ELSE 2 END, wi.last_activity_at DESC LIMIT 8`).all(),
    sourceCounts,
    scan,
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
    evidence: getWorkItemEvidence(database, item.id),
  }));
  const timeline = db.query(`
    SELECT e.id, e.event_type, e.timestamp, e.tool_name, e.is_error, e.content, e.command,
      e.source, e.session_id, e.source_file, e.source_line,
      COALESCE(s.title, '未命名会话') AS session_title
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE e.project_id=? AND (e.event_type IN ('user_message','assistant_message','tool_call','tool_result'))
    ORDER BY e.timestamp DESC, e.source_line DESC LIMIT 120
  `).all(id);
  const sources = db.query("SELECT source, COUNT(*) AS count FROM sessions WHERE project_id=? AND is_subagent=0 GROUP BY source").all(id);
  return { project, workItems, timeline, sources, statusLabels: STATUS_LABELS };
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
      if (line >= start && line <= end) rows.push({ source_line: line, raw: truncate(redactSecrets(raw), 12_000) ?? "" });
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

export function getDailyReport(database: WorklogDatabase, date?: string) {
  const target = date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const rows = database.db.query(`
    SELECT wi.*, p.name AS project_name FROM work_items wi JOIN projects p ON p.id=wi.project_id
    WHERE wi.last_activity_at IS NOT NULL ORDER BY p.name, wi.last_activity_at DESC
  `).all() as Array<Record<string, unknown> & { id: string; project_name: string; last_activity_at: string }>;
  const items = rows
    .filter((row) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(row.last_activity_at)) === target)
    .map((item) => ({ ...item, evidence: getWorkItemEvidence(database, String(item.id)) }));
  return { date: target, projectCount: new Set(items.map((item) => item.project_name)).size, items, statusLabels: STATUS_LABELS };
}
