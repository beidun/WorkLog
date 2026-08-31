import type { WorklogDatabase } from "./db";
import { basename } from "node:path";
import { normalizeWhitespace, safeJson, sha256, stableId } from "./utils";
import { loadWorkItemCorrections } from "./work-item-corrections";
import { loadProjectCorrections } from "./project-corrections";
import { detectSessionSegmentRanges, inferSegmentDigest, segmentHash, type SessionSegmentRange } from "./session-digests";

interface SessionActivity {
  id: string;
  sessionId: string;
  segmentOrdinal: number;
  startLine: number;
  endLine: number;
  projectId: string;
  title: string;
  headline: string;
  progressSummary: string;
  status: string;
  confidence: number;
  nextStep: string;
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  startedAt: string | null;
  endedAt: string | null;
  files: Set<string>;
  evidence: Array<{ eventId: string; digestSection: string }>;
  facts: ActivityFact[];
}

interface ActivityFact {
  kind: "finding" | "change" | "validation" | "risk" | "next_step";
  text: string;
  confidence: number;
}

const GENERIC_PROGRESS = /^(?:当前任务正在处理|当前任务仍处于|当前工作受已识别|已形成明确结论并完成本轮处理|已完成主要处理|已完成 \d+ 个文件的修改|已修改文件：)/;
const TITLE_ACTION = /^(修复|修正|实现|新增|添加|修改|调整|合并|补充|完善|提升|重构|优化|排查|检查|核查|梳理|分析|解读|研究|迁移|导入|部署|启动|重启|停止|处理|生成|更新|测试|同步|查询|查看|确认|追踪|设计|规划|总结|审查|审核|定位|读取|扫描|统计|对比)(.*)$/;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function validationLabel(text: string): string {
  const raw = normalizeWhitespace(text.replace(/^验证通过[：:]\s*/, ""));
  const command = raw.match(/(?:cargo\s+(?:test|check|clippy|build|fmt)\b[^|;&]*|bun\s+(?:test|run\s+(?:build|test|typecheck))\b[^|;&]*|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:build|test|typecheck))\b[^|;&]*|(?:npx\s+)?(?:tsc|vue-tsc)\b[^|;&]*|vite\s+build\b[^|;&]*|pytest\b[^|;&]*|python\s+-m\s+pytest\b[^|;&]*|go\s+test\b[^|;&]*|mvn\s+test\b[^|;&]*|gradle\s+test\b[^|;&]*)/i)?.[0];
  if (command) return normalizeWhitespace(command.replace(/\s+(?:\d*>|>>?).*$/, "").replace(/\s+\[REDACTED_[^\]]+\].*$/, "")).slice(0, 100);
  return (raw.split(/[。！？!?；;]/)[0] ?? raw).replace(/(?:仍然|还是|已经|已)?通过$/, "").trim().slice(0, 100);
}

function changedFile(text: string): string | null {
  const path = text.match(/^已修改文件[：:]\s*(.+)$/)?.[1];
  return path ? basename(path) : null;
}

function displayTitle(value: string): string {
  const hadHtml = /<[^>]*>|<[^>]*$/.test(value);
  let title = normalizeWhitespace(value.replace(/<[^>]*>/g, " ").replace(/<[^>]*$/g, " "));
  title = title
    .replace(/\s*[：:；;。]\s*(?:不要|无需|请勿)[\s\S]*$/i, "")
    .replace(/\s+(?:不要|无需|请勿)(?:执行|提交|push|修改|改动)[\s\S]*$/i, "")
    .replace(/[？?！!。；;：:]+$/g, "");
  const matched = title.match(TITLE_ACTION);
  if (!matched) return title.slice(0, 64) || "梳理当前工作";

  let action = matched[1]!;
  let subject = matched[2]!.trim().replace(/^\d+[.、]\s*/, "");
  if (/^(?:(?:那你|你)(?:给我|帮我)?|给我)?\s*(?:查|看|看看|查看|查询)(?:一下)?/.test(subject)) action = "核查";
  if (/^(?:(?:那你|你)(?:给我|帮我)?|给我)?\s*(?:拿接口)?(?:测|测试)(?:一下)?/.test(subject)) action = "测试";
  subject = subject
    .replace(/^(?:那你|你)(?:给我|帮我)?\s*/, "")
    .replace(/^给我\s*/, "")
    .replace(/^我(?:现在)?(?:想让|想要|需要)\s*/, "")
    .replace(/^(?:查|看|看看|查看|查询|(?:拿接口)?(?:测|测试))(?:一下)?\s*/, "")
    .replace(/^[，,：:\s]+/, "")
    .replace(/^你\s*/, "");
  title = `${action}${subject}`.replace(/[？?！!。；;：:]+$/g, "");
  if (hadHtml && title.length <= action.length + 2) title = `${action}粘贴内容中的问题`;
  return title.length > 64 ? `${title.slice(0, 63)}…` : title || "梳理当前工作";
}

function evidenceSummary(latest: SessionActivity, facts: ActivityFact[]): string {
  if (!GENERIC_PROGRESS.test(latest.progressSummary)) return latest.progressSummary;

  if (latest.status === "blocked") {
    const risk = facts.find((fact) => fact.kind === "risk");
    if (risk) return risk.text;
  }
  const finding = facts.find((fact) => fact.kind === "finding");
  if (finding) return finding.text;

  const semanticChange = facts.find((fact) => fact.kind === "change" && !changedFile(fact.text));
  if (semanticChange) return semanticChange.text;

  const files = unique(facts.filter((fact) => fact.kind === "change").map((fact) => changedFile(fact.text)).filter((file): file is string => Boolean(file)));
  const validations = unique(facts.filter((fact) => fact.kind === "validation").map((fact) => validationLabel(fact.text)).filter(Boolean));
  if (files.length > 0) {
    const visibleFiles = files.slice(0, 2).join("、");
    const fileSummary = files.length > 2 ? `${visibleFiles} 等 ${files.length} 个文件已修改` : `${visibleFiles} 已修改`;
    if (latest.status === "verified" && validations.length > 0) {
      const validationSummary = validations.length === 1 ? `${validations[0]} 验证` : `${validations.length} 项验证（${validations[0]}）`;
      return `${fileSummary}，并通过 ${validationSummary}。`;
    }
    if (latest.status === "verified") return `${fileSummary}，本轮工作已完成。`;
    if (latest.status === "done_unverified") return `${fileSummary}，尚待最终验证。`;
    if (latest.status === "partially_done") return `${fileSummary}，仍有未完成项。`;
    if (latest.status === "abandoned") return `${fileSummary}，本轮任务已停止。`;
    return `${fileSummary}，任务仍在进行。`;
  }
  if (validations.length > 0) {
    return validations.length === 1 ? `已通过 ${validations[0]} 验证。` : `已通过 ${validations.length} 项验证（${validations[0]}）。`;
  }
  return latest.progressSummary;
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

interface SessionDigestRow {
  session_id: string;
  project_id: string;
  started_at: string | null;
  ended_at: string | null;
  objective: string;
  headline: string;
  progress_summary: string;
  completed_json: string;
  validations_json: string;
  blockers_json: string;
  remaining_json: string;
  status: string;
  confidence: number;
  next_step: string;
  last_event_at: string | null;
  provider: string;
}

interface SegmentEvent {
  id: string;
  event_type: string;
  timestamp: string | null;
  source_line: number;
  tool_name: string | null;
  tool_call_id: string | null;
  content: string | null;
  command: string | null;
  file_paths_json: string;
  is_error: number;
  raw_hash: string;
  metadata_json: string;
}

function listValue(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function eventFiles(events: SegmentEvent[]): Set<string> {
  const files = new Set<string>();
  for (const event of events) {
    try {
      for (const file of JSON.parse(event.file_paths_json) as unknown[]) if (typeof file === "string") files.add(file);
    } catch { /* malformed legacy metadata is ignored */ }
  }
  return files;
}

function segmentEvents(events: SegmentEvent[], range: SessionSegmentRange): SegmentEvent[] {
  return events.filter((event) => event.source_line >= range.startLine && event.source_line <= range.endLine);
}

function digestEvidence(database: WorklogDatabase, sessionId: string, startLine: number, endLine: number): Array<{ eventId: string; digestSection: string }> {
  return database.db.query(`
    SELECT sde.event_id AS eventId,sde.digest_section AS digestSection
    FROM session_digest_evidence sde JOIN events e ON e.id=sde.event_id
    WHERE sde.session_id=? AND e.source_line BETWEEN ? AND ?
    ORDER BY sde.rank,e.source_line
  `).all(sessionId, startLine, endLine) as Array<{ eventId: string; digestSection: string }>;
}

function digestFacts(database: WorklogDatabase, sessionId: string, startLine: number, endLine: number): ActivityFact[] {
  return database.db.query(`
    SELECT sf.fact_kind AS kind,sf.text,sf.confidence
    FROM session_facts sf JOIN events e ON e.id=sf.event_id
    WHERE sf.session_id=? AND e.source_line BETWEEN ? AND ?
    ORDER BY sf.rank
  `).all(sessionId, startLine, endLine) as ActivityFact[];
}

function segmentActivity(database: WorklogDatabase, row: SessionDigestRow, events: SegmentEvent[], range: SessionSegmentRange, latest: boolean): SessionActivity | null {
  const rangeEvents = segmentEvents(events, range);
  if (rangeEvents.length === 0 && !latest) return null;
  const rangeHash = segmentHash(rangeEvents as any, range.ordinal);
  const inferred = latest
    ? null
    : inferSegmentDigest(row.session_id, rangeHash, rangeEvents as any);
  const digest = inferred ?? (latest || range.ordinal === 0 ? {
    sessionId: row.session_id,
    inputHash: rangeHash,
    objective: row.objective,
    headline: row.headline,
    progressSummary: row.progress_summary,
    completed: listValue(row.completed_json),
    validations: listValue(row.validations_json),
    blockers: listValue(row.blockers_json),
    remaining: listValue(row.remaining_json),
    facts: [],
    status: row.status as SessionActivity["status"],
    confidence: row.confidence,
    nextStep: row.next_step,
    lastEventAt: row.last_event_at ?? rangeEvents.at(-1)?.timestamp ?? undefined,
    provider: row.provider,
    evidence: [],
  } : null);
  if (!digest) return null;
  const facts = inferred?.facts ?? digestFacts(database, row.session_id, range.startLine, range.endLine);
  const evidence = inferred
    ? inferred.evidence.map((item) => ({ eventId: item.eventId, digestSection: item.section }))
    : digestEvidence(database, row.session_id, range.startLine, range.endLine);
  const first = rangeEvents[0]?.timestamp ?? row.started_at;
  const last = rangeEvents.at(-1)?.timestamp ?? row.last_event_at ?? row.ended_at ?? first;
  return {
    id: stableId("work-segment", row.session_id, range.startLine, range.endLine),
    sessionId: row.session_id,
    segmentOrdinal: range.ordinal,
    startLine: range.startLine,
    endLine: range.endLine,
    projectId: row.project_id,
    title: normalizeWhitespace(digest.objective),
    headline: digest.headline,
    progressSummary: digest.progressSummary,
    status: digest.status,
    confidence: digest.confidence,
    nextStep: digest.nextStep,
    completed: digest.completed,
    validations: digest.validations,
    blockers: digest.blockers,
    remaining: digest.remaining,
    startedAt: first,
    endedAt: last,
    files: eventFiles(rangeEvents),
    evidence,
    facts,
  };
}

function persistSegment(database: WorklogDatabase, segment: SessionActivity, provider: string, now: string): void {
  const db = database.db;
  const segmentId = segment.id;
  db.query(`
    INSERT INTO work_segments(id,session_id,ordinal,start_line,end_line,input_hash,objective,headline,progress_summary,
      completed_json,validations_json,blockers_json,remaining_json,status,confidence,next_step,last_event_at,provider,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,start_line=excluded.start_line,end_line=excluded.end_line,
      input_hash=excluded.input_hash,objective=excluded.objective,headline=excluded.headline,progress_summary=excluded.progress_summary,
      completed_json=excluded.completed_json,validations_json=excluded.validations_json,blockers_json=excluded.blockers_json,
      remaining_json=excluded.remaining_json,status=excluded.status,confidence=excluded.confidence,next_step=excluded.next_step,
      last_event_at=excluded.last_event_at,provider=excluded.provider,updated_at=excluded.updated_at
  `).run(segmentId, segment.sessionId, segment.segmentOrdinal, segment.startLine, segment.endLine,
    sha256(`${segment.sessionId}:${segment.startLine}:${segment.endLine}:${segment.title}`), segment.title, segment.headline,
    segment.progressSummary, safeJson(segment.completed), safeJson(segment.validations), safeJson(segment.blockers), safeJson(segment.remaining), segment.status, segment.confidence,
    segment.nextStep, segment.endedAt, provider, now, now);
  db.query("DELETE FROM work_segment_evidence WHERE segment_id=?").run(segmentId);
  for (const [rank, item] of segment.evidence.entries()) {
    db.query("INSERT OR IGNORE INTO work_segment_evidence(segment_id,event_id,digest_section,rank) VALUES (?,?,?,?)")
      .run(segmentId, item.eventId, item.digestSection, rank);
  }
  db.query("DELETE FROM work_segment_facts WHERE segment_id=?").run(segmentId);
  for (const [rank, fact] of segment.facts.entries()) {
    const eventId = segment.evidence.find((item) => item.digestSection === fact.kind || item.digestSection === (fact.kind === "change" ? "completed" : fact.kind))?.eventId
      ?? segment.evidence[0]?.eventId;
    if (!eventId) continue;
    db.query(`INSERT OR IGNORE INTO work_segment_facts(id,segment_id,event_id,fact_kind,text,confidence,rank,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sha256(`work-segment-fact:${segmentId}:${fact.kind}:${fact.text}`), segmentId,
        eventId,
        fact.kind, fact.text, fact.confidence, rank, now);
  }
}

export function rebuildWorkItems(database: WorklogDatabase): number {
  const db = database.db;
  const corrections = loadWorkItemCorrections(database);
  const projectCorrections = loadProjectCorrections(database);
  const roots = db.query(`
    SELECT s.id AS session_id, s.project_id, s.started_at, s.ended_at, d.objective, d.headline,
      d.progress_summary, d.completed_json, d.validations_json, d.blockers_json, d.remaining_json,
      d.status, d.confidence, d.next_step, d.last_event_at, d.provider
    FROM sessions s JOIN session_digests d ON d.session_id=s.id
    WHERE s.project_id IS NOT NULL AND s.is_subagent = 0
    ORDER BY s.project_id, COALESCE(s.ended_at, s.started_at)
  `).all() as Array<SessionDigestRow>;

  const sessions: SessionActivity[] = [];
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run("DELETE FROM work_segment_evidence");
    db.run("DELETE FROM work_segment_facts");
    db.run("DELETE FROM work_segments");
    for (const row of roots) {
      const events = db.query(`
        SELECT id,event_type,timestamp,source_line,tool_name,tool_call_id,content,command,file_paths_json,is_error,raw_hash,metadata_json
        FROM events WHERE session_id=? ORDER BY source_line,id
      `).all(row.session_id) as SegmentEvent[];
      const ranges = detectSessionSegmentRanges(events as any);
      const segmentRanges = ranges.length > 0 ? ranges : [{ ordinal: 0, startLine: events[0]?.source_line ?? 1, endLine: events.at(-1)?.source_line ?? 1, objectiveEventId: events[0]?.id ?? row.session_id }];
      for (const range of segmentRanges) {
        const latest = range.ordinal === segmentRanges.length - 1;
        const segment = segmentActivity(database, row, events, range, latest);
        if (!segment) continue;
        persistSegment(database, segment, latest ? row.provider : "deterministic-segment-v1", now);
        sessions.push(segment);
      }
    }
  })();

  const groups: SessionActivity[][] = [];
  for (const session of sessions) {
    const group = groups.find((candidate) => candidate[0].projectId === session.projectId && candidate.some((item) => shouldMerge(item, session)));
    if (group) group.push(session); else groups.push([session]);
  }

  const transaction = db.transaction(() => {
    db.run("DELETE FROM work_item_evidence");
    db.run("DELETE FROM work_item_segments");
    db.run("DELETE FROM work_item_sessions");
    db.run("DELETE FROM work_items");
    for (const group of groups) {
      const sessionIds = unique(group.map((item) => item.sessionId));
      const first = group.map((s) => s.startedAt).filter(Boolean).sort()[0] ?? null;
      const last = group.map((s) => s.endedAt ?? s.startedAt).filter(Boolean).sort().at(-1) ?? null;
      const latest = group.slice().sort((left, right) => (right.endedAt ?? "").localeCompare(left.endedAt ?? ""))[0]!;
      const workItemId = stableId("work-item", group[0].projectId, ...group.map((item) => item.id).sort());
      const correction = sessionIds.map((sessionId) => corrections.get(sessionId)).filter(Boolean)
        .sort((left, right) => right!.updatedAt.localeCompare(left!.updatedAt))[0];
      const projectCorrection = sessionIds.map((sessionId) => projectCorrections.get(sessionId)).filter(Boolean)
        .sort((left, right) => right!.updatedAt.localeCompare(left!.updatedAt))[0];
      const facts = group.flatMap((item) => item.facts).slice(-30);
      const automatic = {
        title: displayTitle(latest.headline),
        summary: evidenceSummary(latest, facts),
        status: latest.status,
        nextStep: latest.nextStep,
      };
      db.query(`INSERT INTO work_items(id, project_id, title, summary, status, confidence, first_activity_at, last_activity_at, next_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(workItemId, projectCorrection?.targetProjectId ?? group[0].projectId, correction?.title ?? automatic.title, correction?.summary ?? automatic.summary,
          correction?.status ?? automatic.status, latest.confidence, first, last, correction?.nextStep ?? automatic.nextStep, now, now);
      for (const sessionId of sessionIds) db.query("INSERT INTO work_item_sessions(work_item_id, session_id) VALUES (?, ?)").run(workItemId, sessionId);

      for (const segment of group) {
        db.query("INSERT INTO work_item_segments(work_item_id,segment_id) VALUES (?,?)").run(workItemId, segment.id);
        for (const item of segment.evidence) {
          db.query("INSERT OR IGNORE INTO work_item_evidence(work_item_id,event_id,evidence_kind) VALUES (?,?,?)")
            .run(workItemId, item.eventId, item.digestSection);
        }
      }
    }
  });
  transaction();
  return groups.length;
}
