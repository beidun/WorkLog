import { existsSync, statSync } from "node:fs";
import type { WorklogDatabase } from "./db";
import { safeJson, sha256, stableId } from "./utils";

const FILE_LIMIT = 200;

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

export interface RepositoryCaptureStats {
  projects: number;
  captured: number;
  changed: number;
  unavailable: number;
}

interface SnapshotInput extends Omit<RepositorySnapshot, "id" | "projectId" | "capturedAt"> {
  stateHash: string;
}

function git(root: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim() || "";
}

function gitFiles(root: string, args: string[]): string[] {
  const value = git(root, args);
  if (value === null || value === "") return [];
  return value.split("\0").map((item) => item.trim()).filter(Boolean).sort();
}

function unavailableSnapshot(state: "missing" | "not_git"): SnapshotInput {
  return {
    available: false,
    state,
    branch: null,
    headCommit: null,
    headSubject: null,
    headCommittedAt: null,
    upstream: null,
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 0,
    modifiedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changedFiles: [],
    stateHash: sha256(state),
  };
}

function inspectRepository(root: string): SnapshotInput {
  if (!existsSync(root) || !statSync(root).isDirectory()) return unavailableSnapshot("missing");
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return unavailableSnapshot("not_git");

  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]) || "detached";
  const headCommit = git(root, ["rev-parse", "--verify", "HEAD"]) || null;
  const headSubject = headCommit ? git(root, ["log", "-1", "--format=%s"]) || null : null;
  const headCommittedAt = headCommit ? git(root, ["log", "-1", "--format=%cI"]) || null : null;
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || null;
  const aheadBehind = upstream ? git(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]) : null;
  const [aheadCount = 0, behindCount = 0] = aheadBehind?.split(/\s+/).map(Number) ?? [];
  const staged = gitFiles(root, ["diff", "--cached", "--name-only", "-z"]);
  const modified = gitFiles(root, ["diff", "--name-only", "-z"]);
  const untracked = gitFiles(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const conflicted = gitFiles(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const changedFiles = [...new Set([...conflicted, ...staged, ...modified, ...untracked])].sort();
  const state = headCommit ? (changedFiles.length > 0 ? "dirty" : "clean") : "empty";
  const stateValue = {
    available: true, state, branch, headCommit, headSubject, headCommittedAt, upstream,
    aheadCount, behindCount, staged, modified, untracked, conflicted,
  };
  return {
    available: true,
    state,
    branch,
    headCommit,
    headSubject,
    headCommittedAt,
    upstream,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
    stagedCount: staged.length,
    modifiedCount: modified.length,
    untrackedCount: untracked.length,
    conflictedCount: conflicted.length,
    changedFiles: changedFiles.slice(0, FILE_LIMIT),
    stateHash: sha256(JSON.stringify(stateValue)),
  };
}

export function captureRepositorySnapshots(database: WorklogDatabase, capturedAt = new Date().toISOString()): RepositoryCaptureStats {
  const projects = database.db.query("SELECT id,root_path FROM projects ORDER BY id").all() as Array<{ id: string; root_path: string }>;
  const snapshots = projects.map((project) => ({ project, snapshot: inspectRepository(project.root_path) }));
  let captured = 0;
  let changed = 0;
  let unavailable = 0;
  const insert = database.db.query(`
    INSERT INTO repository_snapshots(id,project_id,captured_at,available,state,state_hash,branch,head_commit,
      head_subject,head_committed_at,upstream,ahead_count,behind_count,staged_count,modified_count,
      untracked_count,conflicted_count,changed_files_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      available=excluded.available,state=excluded.state,state_hash=excluded.state_hash,branch=excluded.branch,
      head_commit=excluded.head_commit,head_subject=excluded.head_subject,head_committed_at=excluded.head_committed_at,
      upstream=excluded.upstream,ahead_count=excluded.ahead_count,behind_count=excluded.behind_count,
      staged_count=excluded.staged_count,modified_count=excluded.modified_count,untracked_count=excluded.untracked_count,
      conflicted_count=excluded.conflicted_count,changed_files_json=excluded.changed_files_json
  `);
  const transaction = database.db.transaction(() => {
    for (const { project, snapshot } of snapshots) {
      const previous = database.db.query(`
        SELECT state_hash FROM repository_snapshots WHERE project_id=? ORDER BY captured_at DESC,created_at DESC LIMIT 1
      `).get(project.id) as { state_hash: string } | null;
      if (!previous || previous.state_hash !== snapshot.stateHash) changed += 1;
      if (!snapshot.available) unavailable += 1;
      const id = stableId("repository-snapshot", project.id, capturedAt, snapshot.stateHash);
      insert.run(id, project.id, capturedAt, snapshot.available ? 1 : 0, snapshot.state, snapshot.stateHash,
        snapshot.branch, snapshot.headCommit, snapshot.headSubject, snapshot.headCommittedAt, snapshot.upstream,
        snapshot.aheadCount, snapshot.behindCount, snapshot.stagedCount, snapshot.modifiedCount,
        snapshot.untrackedCount, snapshot.conflictedCount, safeJson(snapshot.changedFiles), capturedAt);
      captured += 1;
    }
  });
  transaction();
  return { projects: projects.length, captured, changed, unavailable };
}

export function latestRepositorySnapshot(database: WorklogDatabase, projectId: string): RepositorySnapshot | null {
  const row = database.db.query(`
    SELECT * FROM repository_snapshots WHERE project_id=? ORDER BY captured_at DESC,created_at DESC LIMIT 1
  `).get(projectId) as Record<string, unknown> | null;
  if (!row) return null;
  let changedFiles: string[] = [];
  try { changedFiles = JSON.parse(String(row.changed_files_json)) as string[]; } catch { changedFiles = []; }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    capturedAt: String(row.captured_at),
    available: Number(row.available) === 1,
    state: row.state as RepositorySnapshot["state"],
    branch: row.branch == null ? null : String(row.branch),
    headCommit: row.head_commit == null ? null : String(row.head_commit),
    headSubject: row.head_subject == null ? null : String(row.head_subject),
    headCommittedAt: row.head_committed_at == null ? null : String(row.head_committed_at),
    upstream: row.upstream == null ? null : String(row.upstream),
    aheadCount: Number(row.ahead_count),
    behindCount: Number(row.behind_count),
    stagedCount: Number(row.staged_count),
    modifiedCount: Number(row.modified_count),
    untrackedCount: Number(row.untracked_count),
    conflictedCount: Number(row.conflicted_count),
    changedFiles,
  };
}
