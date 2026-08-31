import type { WorklogDatabase } from "./db";
import { safeJson, stableId } from "./utils";

export type ProgressChangeType =
  | "started"
  | "progress_updated"
  | "completed"
  | "validation_added"
  | "blocker_added"
  | "blocker_resolved";

interface SnapshotItem {
  workItemId: string;
  projectId: string;
  projectName: string;
  title: string;
  summary: string;
  status: string;
  nextStep: string;
  lastActivityAt: string | null;
  completed: string[];
  validations: string[];
  blockers: string[];
  remaining: string[];
  evidenceIds: string[];
  sessionIds: string[];
}

export interface ProgressChange {
  id: string;
  snapshotId: string;
  previousSnapshotId?: string;
  projectId: string;
  projectName: string;
  workItemId: string;
  changeType: ProgressChangeType;
  title: string;
  before: SnapshotItem | null;
  after: SnapshotItem;
  evidenceIds: string[];
  detectedAt: string;
}

export interface ProgressSnapshotResult {
  snapshotId: string;
  previousSnapshotId?: string;
  capturedAt: string;
  baseline: boolean;
  itemCount: number;
  changes: ProgressChange[];
}

function stringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function unique(values: string[][], maximum = 8): string[] {
  return [...new Set(values.flat())].slice(0, maximum);
}

function currentSnapshotItems(database: WorklogDatabase): SnapshotItem[] {
  const db = database.db;
  const rows = db.query(`
    SELECT wi.*, p.name AS project_name
    FROM work_items wi JOIN projects p ON p.id=wi.project_id
    ORDER BY p.name, wi.last_activity_at DESC, wi.id
  `).all() as Array<{
    id: string; project_id: string; project_name: string; title: string; summary: string;
    status: string; next_step: string | null; last_activity_at: string | null;
  }>;

  return rows.map((row) => {
    const segmentDigests = db.query(`
      SELECT ws.session_id,ws.completed_json,ws.validations_json,ws.blockers_json,ws.remaining_json,ws.last_event_at
      FROM work_item_segments wis JOIN work_segments ws ON ws.id=wis.segment_id
      WHERE wis.work_item_id=? ORDER BY ws.last_event_at DESC,ws.id
    `).all(row.id) as Array<{
      session_id: string; completed_json: string; validations_json: string; blockers_json: string;
      remaining_json: string; last_event_at: string | null;
    }>;
    const digests = segmentDigests.length > 0 ? segmentDigests : (db.query(`
      SELECT d.completed_json,d.validations_json,d.blockers_json,d.remaining_json,d.last_event_at
      FROM work_item_sessions wis JOIN session_digests d ON d.session_id=wis.session_id
      WHERE wis.work_item_id=? ORDER BY d.last_event_at DESC, d.session_id
    `).all(row.id) as Array<{
      completed_json: string; validations_json: string; blockers_json: string;
      remaining_json: string; last_event_at: string | null;
    }>);
    const latest = digests[0];
    const lastDigestActivity = digests.map((item) => item.last_event_at).filter((value): value is string => Boolean(value)).sort().at(-1);
    const sessionIds = (segmentDigests.length > 0
      ? segmentDigests
      : db.query("SELECT session_id FROM work_item_sessions WHERE work_item_id=? ORDER BY session_id").all(row.id) as Array<{ session_id: string }>).map((item) => item.session_id);
    const evidenceIds = (db.query(`
      SELECT event_id FROM work_item_evidence WHERE work_item_id=? ORDER BY event_id
    `).all(row.id) as Array<{ event_id: string }>).map((item) => item.event_id).slice(0, 8);
    return {
      workItemId: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      summary: row.summary,
      status: row.status,
      nextStep: row.next_step ?? "",
      lastActivityAt: lastDigestActivity ?? row.last_activity_at,
      completed: unique(digests.map((item) => stringList(item.completed_json))),
      validations: unique(digests.map((item) => stringList(item.validations_json))),
      blockers: row.status === "blocked" && latest ? stringList(latest.blockers_json) : [],
      remaining: ["verified", "abandoned"].includes(row.status) || !latest ? [] : stringList(latest.remaining_json),
      evidenceIds,
      sessionIds,
    };
  });
}

function readSnapshotItems(database: WorklogDatabase, snapshotId: string): SnapshotItem[] {
  return (database.db.query(`
    SELECT * FROM work_item_snapshots WHERE snapshot_id=? ORDER BY project_name, work_item_id
  `).all(snapshotId) as Array<{
    work_item_id: string; project_id: string; project_name: string; title: string; summary: string;
    status: string; next_step: string; last_activity_at: string | null; completed_json: string;
    validations_json: string; blockers_json: string; remaining_json: string;
    evidence_ids_json: string; session_ids_json: string;
  }>).map((row) => ({
    workItemId: row.work_item_id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    summary: row.summary,
    status: row.status,
    nextStep: row.next_step,
    lastActivityAt: row.last_activity_at,
    completed: stringList(row.completed_json),
    validations: stringList(row.validations_json),
    blockers: stringList(row.blockers_json),
    remaining: stringList(row.remaining_json),
    evidenceIds: stringList(row.evidence_ids_json),
    sessionIds: stringList(row.session_ids_json),
  }));
}

function sessionOverlap(a: SnapshotItem, b: SnapshotItem): number {
  const right = new Set(b.sessionIds);
  return a.sessionIds.reduce((count, id) => count + (right.has(id) ? 1 : 0), 0);
}

function matchPrevious(current: SnapshotItem, previous: SnapshotItem[], used: Set<string>): SnapshotItem | undefined {
  const exact = previous.find((item) => item.workItemId === current.workItemId && !used.has(item.workItemId));
  if (exact) return exact;
  return previous
    .filter((item) => item.projectId === current.projectId && !used.has(item.workItemId))
    .map((item) => ({ item, overlap: sessionOverlap(current, item) }))
    .filter((candidate) => candidate.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)[0]?.item;
}

function added(after: string[], before: string[]): string[] {
  const previous = new Set(before);
  return after.filter((item) => !previous.has(item));
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function changeTypes(before: SnapshotItem, after: SnapshotItem, previousCapturedAt: string): ProgressChangeType[] {
  const types: ProgressChangeType[] = [];
  const wasFinished = ["verified", "done_unverified"].includes(before.status);
  const isFinished = ["verified", "done_unverified"].includes(after.status);
  if (!wasFinished && isFinished) types.push("completed");
  if ((before.status !== "blocked" && after.status === "blocked") || added(after.blockers, before.blockers).length > 0) types.push("blocker_added");
  if (before.status === "blocked" && after.status !== "blocked") types.push("blocker_resolved");
  if (added(after.validations, before.validations).length > 0) types.push("validation_added");
  const progressChanged = before.title !== after.title
    || before.summary !== after.summary
    || before.nextStep !== after.nextStep
    || (before.lastActivityAt !== after.lastActivityAt && Boolean(after.lastActivityAt) && after.lastActivityAt! > previousCapturedAt)
    || (!sameList(before.completed, after.completed) && added(after.completed, before.completed).length > 0)
    || (before.status !== after.status && types.length === 0);
  if (progressChanged) types.push("progress_updated");
  return [...new Set(types)];
}

function makeChange(
  snapshotId: string,
  previousSnapshotId: string,
  type: ProgressChangeType,
  before: SnapshotItem | null,
  after: SnapshotItem,
  detectedAt: string,
): ProgressChange {
  return {
    id: stableId("progress-change", snapshotId, after.workItemId, type),
    snapshotId,
    previousSnapshotId,
    projectId: after.projectId,
    projectName: after.projectName,
    workItemId: after.workItemId,
    changeType: type,
    title: after.title,
    before,
    after,
    evidenceIds: after.evidenceIds,
    detectedAt,
  };
}

export function captureProgressSnapshot(
  database: WorklogDatabase,
  scan: { startedAt?: string; finishedAt?: string } = {},
  capturedAt = new Date().toISOString(),
): ProgressSnapshotResult {
  const db = database.db;
  const previous = db.query("SELECT id,captured_at FROM progress_snapshots ORDER BY captured_at DESC, created_at DESC LIMIT 1")
    .get() as { id: string; captured_at: string } | null;
  const snapshotId = stableId("progress-snapshot", capturedAt, scan.startedAt ?? "", scan.finishedAt ?? "");
  const items = currentSnapshotItems(database);
  const previousItems = previous ? readSnapshotItems(database, previous.id) : [];
  const used = new Set<string>();
  const changes: ProgressChange[] = [];
  if (previous) {
    for (const item of items) {
      const before = matchPrevious(item, previousItems, used);
      if (!before) {
        changes.push(makeChange(snapshotId, previous.id, "started", null, item, capturedAt));
        continue;
      }
      used.add(before.workItemId);
      for (const type of changeTypes(before, item, previous.captured_at)) {
        changes.push(makeChange(snapshotId, previous.id, type, before, item, capturedAt));
      }
    }
  }

  const transaction = db.transaction(() => {
    db.query(`
      INSERT INTO progress_snapshots(id,captured_at,scan_started_at,scan_finished_at,item_count,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(snapshotId, capturedAt, scan.startedAt ?? null, scan.finishedAt ?? null, items.length, capturedAt);
    const insertItem = db.query(`
      INSERT INTO work_item_snapshots(snapshot_id,work_item_id,project_id,project_name,title,summary,status,next_step,
        last_activity_at,completed_json,validations_json,blockers_json,remaining_json,evidence_ids_json,session_ids_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const item of items) {
      insertItem.run(snapshotId,item.workItemId,item.projectId,item.projectName,item.title,item.summary,item.status,
        item.nextStep,item.lastActivityAt,safeJson(item.completed),safeJson(item.validations),safeJson(item.blockers),
        safeJson(item.remaining),safeJson(item.evidenceIds),safeJson(item.sessionIds));
    }
    const insertChange = db.query(`
      INSERT INTO progress_changes(id,snapshot_id,previous_snapshot_id,project_id,project_name,work_item_id,change_type,
        title,before_json,after_json,evidence_ids_json,detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const change of changes) {
      insertChange.run(change.id,change.snapshotId,change.previousSnapshotId ?? null,change.projectId,change.projectName,
        change.workItemId,change.changeType,change.title,change.before ? safeJson(change.before) : null,
        safeJson(change.after),safeJson(change.evidenceIds),change.detectedAt);
    }
  });
  transaction();
  return {
    snapshotId,
    previousSnapshotId: previous?.id,
    capturedAt,
    baseline: !previous,
    itemCount: items.length,
    changes,
  };
}

export function latestProgressChanges(database: WorklogDatabase, limit = 8): ProgressChange[] {
  const snapshot = database.db.query("SELECT id FROM progress_snapshots ORDER BY captured_at DESC, created_at DESC LIMIT 1")
    .get() as { id: string } | null;
  if (!snapshot) return [];
  return (database.db.query(`
    SELECT * FROM progress_changes WHERE snapshot_id=? ORDER BY detected_at DESC, id LIMIT ?
  `).all(snapshot.id, limit) as Array<{
    id: string; snapshot_id: string; previous_snapshot_id: string | null; project_id: string; project_name: string;
    work_item_id: string; change_type: ProgressChangeType; title: string; before_json: string | null;
    after_json: string; evidence_ids_json: string; detected_at: string;
  }>).map((row) => ({
    id: row.id,
    snapshotId: row.snapshot_id,
    previousSnapshotId: row.previous_snapshot_id ?? undefined,
    projectId: row.project_id,
    projectName: row.project_name,
    workItemId: row.work_item_id,
    changeType: row.change_type,
    title: row.title,
    before: row.before_json ? JSON.parse(row.before_json) as SnapshotItem : null,
    after: JSON.parse(row.after_json) as SnapshotItem,
    evidenceIds: stringList(row.evidence_ids_json),
    detectedAt: row.detected_at,
  }));
}
