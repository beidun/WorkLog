import type { WorklogDatabase } from "./db";
import type { WorkStatus } from "./types";
import { normalizeWhitespace, stableId } from "./utils";

interface SessionActivity {
  id: string;
  projectId: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  files: Set<string>;
}

interface EventRow {
  id: string;
  session_id: string;
  event_type: string;
  timestamp: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  content: string | null;
  command: string | null;
  file_paths_json: string;
  is_error: number;
}

function titleTokens(value: string): Set<string> {
  const normalized = normalizeWhitespace(value.toLowerCase());
  const tokens = new Set(normalized.match(/[a-z0-9_\-]{2,}/g) ?? []);
  const chinese = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let i = 0; i < chinese.length - 1; i += 1) tokens.add(chinese[i] + chinese[i + 1]);
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function shouldMerge(a: SessionActivity, b: SessionActivity): boolean {
  const aTime = new Date(a.endedAt ?? a.startedAt ?? 0).getTime();
  const bTime = new Date(b.endedAt ?? b.startedAt ?? 0).getTime();
  if (Math.abs(aTime - bTime) > 14 * 86_400_000) return false;
  const similarity = jaccard(titleTokens(a.title), titleTokens(b.title));
  let sharedFiles = 0;
  for (const file of a.files) if (b.files.has(file)) sharedFiles += 1;
  return similarity >= 0.72 || (similarity >= 0.35 && sharedFiles >= 2);
}

function inferStatus(events: EventRow[]): { status: WorkStatus; confidence: number; summary: string; nextStep: string } {
  const calls = new Map(events.filter((e) => e.event_type === "tool_call" && e.tool_call_id).map((e) => [e.tool_call_id!, e]));
  const results = new Map(events.filter((e) => e.event_type === "tool_result" && e.tool_call_id).map((e) => [e.tool_call_id!, e]));
  const writes = events.filter((e) => /^(Edit|Write|apply_patch)$/i.test(e.tool_name ?? ""));
  const validationCalls = events.filter((e) => e.event_type === "tool_call" && /(?:^|\s)(?:cargo\s+(?:test|check|clippy|build)|npm\s+(?:test|run\s+build)|bun\s+test|pytest|vitest|tsc\s+--noEmit)(?:\s|$)/i.test(e.command ?? ""));
  const successfulValidations = validationCalls.filter((call) => {
    const result = call.tool_call_id ? results.get(call.tool_call_id) : undefined;
    return result && result.is_error === 0;
  });
  const failures = events.filter((e) => e.event_type === "tool_result" && e.is_error === 1);
  const messages = events.filter((e) => /_message$/.test(e.event_type)).map((e) => e.content ?? "").join(" ");
  const explicitBlocked = /(?:blocked|阻塞|卡住|缺少权限|无法继续|需要用户|等待.*确认)/i.test(messages);
  const aborted = events.some((e) => e.event_type === "task_aborted");
  const toolCalls = events.filter((e) => e.event_type === "tool_call").length;

  let status: WorkStatus;
  let confidence = 0.72;
  if (explicitBlocked && successfulValidations.length === 0) { status = "blocked"; confidence = 0.78; }
  else if (successfulValidations.length > 0 && writes.length > 0) { status = "verified"; confidence = 0.9; }
  else if (writes.length > 0 && failures.length > 0) { status = "partially_done"; confidence = 0.78; }
  else if (writes.length > 0) { status = "done_unverified"; confidence = 0.75; }
  else if (toolCalls > 0) { status = "in_progress"; confidence = 0.7; }
  else if (aborted) { status = "abandoned"; confidence = 0.62; }
  else { status = "planned"; confidence = 0.65; }

  const summary = `${toolCalls} 次工具调用，${writes.length} 次修改，${successfulValidations.length} 项验证通过${failures.length ? `，${failures.length} 次执行失败` : ""}。`;
  const nextStep = status === "verified" ? "确认是否需要提交、发布或进入下一项工作。"
    : status === "done_unverified" ? "补充测试、构建或运行验证。"
    : status === "blocked" ? "解决阻塞条件后继续。"
    : status === "partially_done" ? "处理失败项并重新验证。"
    : "继续最近尚未完成的工作。";
  return { status, confidence, summary, nextStep };
}

export function rebuildWorkItems(database: WorklogDatabase): number {
  const db = database.db;
  const roots = db.query(`
    SELECT s.id, s.project_id, s.title, s.started_at, s.ended_at,
      COALESCE((SELECT content FROM events WHERE session_id=s.id AND event_type='user_message'
        AND content IS NOT NULL AND trim(content) <> '' ORDER BY source_line LIMIT 1), '未命名工作') AS first_prompt
    FROM sessions s WHERE s.project_id IS NOT NULL AND s.is_subagent = 0
      AND EXISTS (SELECT 1 FROM events useful WHERE useful.session_id=s.id
        AND useful.event_type='user_message' AND useful.content IS NOT NULL AND trim(useful.content) <> '')
    ORDER BY s.project_id, COALESCE(s.ended_at, s.started_at)
  `).all() as Array<{ id: string; project_id: string; title: string | null; started_at: string | null; ended_at: string | null; first_prompt: string }>;

  const sessions: SessionActivity[] = roots.map((row) => {
    const fileRows = db.query(`SELECT file_paths_json FROM events WHERE session_id = ?`).all(row.id) as Array<{ file_paths_json: string }>;
    const files = new Set(fileRows.flatMap((item) => JSON.parse(item.file_paths_json) as string[]));
    const title = normalizeWhitespace(row.title ?? row.first_prompt).replace(/^\/goal\s+/i, "").slice(0, 100) || "未命名工作";
    return { id: row.id, projectId: row.project_id, title, startedAt: row.started_at, endedAt: row.ended_at, files };
  });

  const groups: SessionActivity[][] = [];
  for (const session of sessions) {
    const group = groups.find((candidate) => candidate[0].projectId === session.projectId && candidate.some((item) => shouldMerge(item, session)));
    if (group) group.push(session); else groups.push([session]);
  }

  const transaction = db.transaction(() => {
    db.run("DELETE FROM work_item_evidence");
    db.run("DELETE FROM work_item_sessions");
    db.run("DELETE FROM work_items");
    const now = new Date().toISOString();
    for (const group of groups) {
      const sessionIds = group.map((item) => item.id);
      const childIds = db.query(`SELECT id FROM sessions WHERE parent_session_id IN (${sessionIds.map(() => "?").join(",")})`).all(...sessionIds) as Array<{ id: string }>;
      const allIds = [...sessionIds, ...childIds.map((item) => item.id)];
      const events = db.query(`SELECT id, session_id, event_type, timestamp, tool_name, tool_call_id, content, command, file_paths_json, is_error FROM events WHERE session_id IN (${allIds.map(() => "?").join(",")}) ORDER BY timestamp, source_line`).all(...allIds) as EventRow[];
      const inference = inferStatus(events);
      const first = group.map((s) => s.startedAt).filter(Boolean).sort()[0] ?? null;
      const last = group.map((s) => s.endedAt ?? s.startedAt).filter(Boolean).sort().at(-1) ?? null;
      const title = group.at(-1)!.title;
      const workItemId = stableId("work-item", group[0].projectId, ...sessionIds.sort());
      db.query(`INSERT INTO work_items(id, project_id, title, summary, status, confidence, first_activity_at, last_activity_at, next_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(workItemId, group[0].projectId, title, inference.summary, inference.status, inference.confidence, first, last, inference.nextStep, now, now);
      for (const sessionId of sessionIds) db.query("INSERT INTO work_item_sessions(work_item_id, session_id) VALUES (?, ?)").run(workItemId, sessionId);

      const firstUser = events.find((event) => event.event_type === "user_message");
      const candidates = events.filter((e) => e.event_type === "tool_result" && e.is_error === 1 || /^(Edit|Write|apply_patch)$/i.test(e.tool_name ?? "") || e.event_type === "assistant_message").slice(-7);
      const evidence = [...new Map([firstUser, ...candidates].filter((event): event is EventRow => Boolean(event)).map((event) => [event.id, event])).values()];
      if (evidence.length === 0 && events.length > 0) evidence.push(events.at(-1)!);
      for (const event of evidence) {
        const kind = event.is_error ? "execution_failure" : /^(Edit|Write|apply_patch)$/i.test(event.tool_name ?? "") ? "file_change" : event.event_type === "user_message" ? "user_request" : "agent_statement";
        db.query("INSERT OR IGNORE INTO work_item_evidence(work_item_id, event_id, evidence_kind) VALUES (?, ?, ?)").run(workItemId, event.id, kind);
      }
    }
  });
  transaction();
  return groups.length;
}
