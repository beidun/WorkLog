import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSource, CanonicalEvent, ProjectRow, SessionSeed, WorkStatus } from "./types";
import { redactSecrets, safeJson, stableId, stripInjectedContext } from "./utils";

export class WorklogDatabase {
  readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS source_files (
        source TEXT NOT NULL,
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        last_offset INTEGER NOT NULL DEFAULT 0,
        last_line INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        scanned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        git_remote TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        parent_external_id TEXT,
        parent_session_id TEXT,
        project_id TEXT,
        title TEXT,
        cwd TEXT,
        git_branch TEXT,
        git_commit TEXT,
        git_remote TEXT,
        started_at TEXT,
        ended_at TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        source_file TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        role TEXT,
        timestamp TEXT,
        tool_name TEXT,
        tool_call_id TEXT,
        content TEXT,
        command TEXT,
        cwd TEXT,
        file_paths_json TEXT NOT NULL DEFAULT '[]',
        is_error INTEGER NOT NULL DEFAULT 0,
        source_file TEXT NOT NULL,
        source_line INTEGER NOT NULL,
        raw_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        first_activity_at TEXT,
        last_activity_at TEXT,
        next_step TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS work_item_sessions (
        work_item_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY(work_item_id, session_id),
        FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS work_item_evidence (
        work_item_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL,
        PRIMARY KEY(work_item_id, event_id),
        FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project_activity ON sessions(project_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_session_line ON events(session_id, source_line);
      CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tool_call ON events(session_id, tool_call_id);
      CREATE INDEX IF NOT EXISTS idx_work_items_project_status ON work_items(project_id, status, last_activity_at DESC);
    `);
  }

  getFileCursor(path: string): { size: number; mtime_ms: number; last_offset: number; last_line: number } | null {
    return this.db.query("SELECT size, mtime_ms, last_offset, last_line FROM source_files WHERE path = ?").get(path) as ReturnType<WorklogDatabase["getFileCursor"]>;
  }

  getSessionSeed(source: AgentSource, path: string, preferredExternalId: string): SessionSeed | null {
    const row = this.db.query(`
      SELECT external_id, parent_external_id, title, cwd, git_branch, git_commit, git_remote,
        started_at, ended_at, is_subagent, source_file
      FROM sessions
      WHERE source = ? AND source_file = ?
      ORDER BY CASE WHEN external_id = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(source, path, preferredExternalId) as {
      external_id: string;
      parent_external_id: string | null;
      title: string | null;
      cwd: string | null;
      git_branch: string | null;
      git_commit: string | null;
      git_remote: string | null;
      started_at: string | null;
      ended_at: string | null;
      is_subagent: number;
      source_file: string;
    } | null;
    if (!row) return null;
    return {
      source,
      externalId: row.external_id,
      parentExternalId: row.parent_external_id ?? undefined,
      title: row.title ?? undefined,
      cwd: row.cwd ?? undefined,
      gitBranch: row.git_branch ?? undefined,
      gitCommit: row.git_commit ?? undefined,
      gitRemote: row.git_remote ?? undefined,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
      isSubagent: row.is_subagent === 1,
      sourceFile: row.source_file,
    };
  }

  updateFileCursor(source: string, path: string, state: { size: number; mtimeMs: number; offset: number; line: number; status: string; error?: string }): void {
    this.db.query(`
      INSERT INTO source_files(source, path, size, mtime_ms, last_offset, last_line, status, error, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms,
        last_offset=excluded.last_offset, last_line=excluded.last_line, status=excluded.status,
        error=excluded.error, scanned_at=excluded.scanned_at
    `).run(source, path, state.size, state.mtimeMs, state.offset, state.line, state.status, state.error ?? null, new Date().toISOString());
  }

  pruneSourceFileRows(source: AgentSource, currentPaths: string[]): void {
    if (currentPaths.length === 0) {
      this.db.query("DELETE FROM source_files WHERE source = ?").run(source);
      return;
    }
    this.db.query(`DELETE FROM source_files WHERE source = ? AND path NOT IN (${currentPaths.map(() => "?").join(",")})`)
      .run(source, ...currentPaths);
  }

  resetFile(path: string): void {
    const transaction = this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE source_file = ?").run(path);
      this.db.query("DELETE FROM sessions WHERE source_file = ?").run(path);
      this.db.query("DELETE FROM source_files WHERE path = ?").run(path);
    });
    transaction();
  }

  upsertSession(seed: SessionSeed): string {
    const id = stableId(seed.source, seed.externalId);
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO sessions(id, source, external_id, parent_external_id, title, cwd, git_branch,
        git_commit, git_remote, started_at, ended_at, is_subagent, source_file, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET
        parent_external_id=COALESCE(excluded.parent_external_id, sessions.parent_external_id),
        title=COALESCE(excluded.title, sessions.title), cwd=COALESCE(excluded.cwd, sessions.cwd),
        git_branch=COALESCE(excluded.git_branch, sessions.git_branch),
        git_commit=COALESCE(excluded.git_commit, sessions.git_commit),
        git_remote=COALESCE(excluded.git_remote, sessions.git_remote),
        started_at=COALESCE(sessions.started_at, excluded.started_at),
        ended_at=CASE WHEN excluded.ended_at > sessions.ended_at OR sessions.ended_at IS NULL THEN excluded.ended_at ELSE sessions.ended_at END,
        is_subagent=MAX(sessions.is_subagent, excluded.is_subagent), source_file=excluded.source_file,
        updated_at=excluded.updated_at
    `).run(id, seed.source, seed.externalId, seed.parentExternalId ?? null, seed.title ?? null,
      seed.cwd ?? null, seed.gitBranch ?? null, seed.gitCommit ?? null, seed.gitRemote ?? null,
      seed.startedAt ?? null, seed.endedAt ?? null, seed.isSubagent ? 1 : 0, seed.sourceFile, now, now);
    return id;
  }

  updateSessionTitle(source: string, externalId: string, title: string): void {
    this.db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE source = ? AND external_id = ?")
      .run(title, new Date().toISOString(), source, externalId);
  }

  upsertEvent(event: CanonicalEvent): boolean {
    const sessionId = stableId(event.source, event.sessionExternalId);
    const result = this.db.query(`
      INSERT INTO events(id, session_id, source, event_type, role, timestamp, tool_name,
        tool_call_id, content, command, cwd, file_paths_json, is_error, source_file, source_line,
        raw_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_file=excluded.source_file, source_line=excluded.source_line,
        raw_hash=excluded.raw_hash, content=excluded.content, command=excluded.command,
        cwd=excluded.cwd, file_paths_json=excluded.file_paths_json, is_error=excluded.is_error,
        metadata_json=excluded.metadata_json
    `).run(event.id, sessionId, event.source, event.type, event.role ?? null, event.timestamp ?? null,
      event.toolName ?? null, event.toolCallId ?? null, event.content ?? null, event.command ?? null,
      event.cwd ?? null, safeJson(event.filePaths ?? []), event.isError ? 1 : 0, event.sourceFile,
      event.sourceLine, event.rawHash, safeJson(event.metadata ?? {}));
    return result.changes > 0;
  }

  resolveParentSessions(): void {
    this.db.run(`
      UPDATE sessions SET parent_external_id = NULL, parent_session_id = NULL, is_subagent = 0
      WHERE parent_external_id = external_id OR parent_session_id = id
    `);
    this.db.run(`
      UPDATE sessions AS child SET parent_session_id = (
        SELECT parent.id FROM sessions AS parent
        WHERE parent.source = child.source AND parent.external_id = child.parent_external_id
      ) WHERE child.parent_external_id IS NOT NULL
    `);
  }

  normalizeStoredContext(): number {
    const rows = this.db.query(`
      SELECT id, content, command FROM events
      WHERE (content IS NOT NULL OR command IS NOT NULL) AND (
        content LIKE '<%' OR content LIKE 'The following is the Codex agent history%'
        OR content LIKE '% -u %' OR content LIKE '%--user %' OR content LIKE '%Authorization:%'
        OR content LIKE '% -b %' OR content LIKE '%--cookie %' OR content LIKE '%Cookie:%'
        OR command LIKE '% -u %' OR command LIKE '%--user %' OR command LIKE '%Authorization:%'
        OR command LIKE '% -b %' OR command LIKE '%--cookie %' OR command LIKE '%Cookie:%'
      )
    `).all() as Array<{ id: string; content: string | null; command: string | null }>;
    let changed = 0;
    const update = this.db.query("UPDATE events SET content = ?, command = ? WHERE id = ?");
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const content = row.content == null ? null : redactSecrets(stripInjectedContext(row.content)) || null;
        const command = row.command == null ? null : redactSecrets(row.command) || null;
        if (content !== row.content || command !== row.command) {
          update.run(content, command, row.id);
          changed += 1;
        }
      }
    });
    transaction();
    return changed;
  }

  close(): void {
    this.db.close();
  }
}
