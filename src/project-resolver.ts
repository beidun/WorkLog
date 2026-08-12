import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { WorklogDatabase } from "./db";
import { stableId } from "./utils";

interface ResolvedProject {
  id: string;
  name: string;
  root: string;
  remote?: string;
}

const cache = new Map<string, ResolvedProject | null>();

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.toString().trim();
  return value || undefined;
}

function resolveProject(candidate: string | null | undefined, fallbackRemote?: string | null): ResolvedProject | null {
  if (!candidate) return null;
  let path = candidate;
  if (!isAbsolute(path)) return null;
  if (cache.has(path)) return cache.get(path) ?? null;
  if (!existsSync(path)) {
    cache.set(path, null);
    return null;
  }
  if (statSync(path).isFile()) path = dirname(path);
  const root = gitValue(path, ["rev-parse", "--show-toplevel"]);
  if (root) {
    const remote = fallbackRemote ?? gitValue(root, ["remote", "get-url", "origin"]);
    const project = { id: stableId("project", remote ?? root), name: basename(root), root, remote: remote ?? undefined };
    cache.set(candidate, project);
    return project;
  }
  const project = { id: stableId("project", path), name: basename(path) || path, root: path };
  cache.set(candidate, project);
  return project;
}

export function assignProjects(database: WorklogDatabase): number {
  const db = database.db;
  const sessions = db.query(`
    SELECT id, cwd, git_remote, started_at, ended_at FROM sessions
    ORDER BY COALESCE(ended_at, started_at) ASC
  `).all() as Array<{ id: string; cwd: string | null; git_remote: string | null; started_at: string | null; ended_at: string | null }>;
  let assigned = 0;

  const upsertProject = (project: ResolvedProject, activity: string | null) => {
    const now = new Date().toISOString();
    db.query(`
      INSERT INTO projects(id, name, root_path, git_remote, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path,
        git_remote=COALESCE(excluded.git_remote, projects.git_remote),
        last_activity_at=CASE WHEN excluded.last_activity_at > projects.last_activity_at OR projects.last_activity_at IS NULL THEN excluded.last_activity_at ELSE projects.last_activity_at END,
        updated_at=excluded.updated_at
    `).run(project.id, project.name, project.root, project.remote ?? null, activity, now, now);
  };

  for (const session of sessions) {
    const eventRows = db.query(`
      SELECT id, cwd, file_paths_json, timestamp FROM events WHERE session_id = ? ORDER BY source_line
    `).all(session.id) as Array<{ id: string; cwd: string | null; file_paths_json: string; timestamp: string | null }>;
    const counts = new Map<string, { project: ResolvedProject; count: number; activity: string | null }>();

    for (const event of eventRows) {
      const paths = JSON.parse(event.file_paths_json) as string[];
      const candidates = [event.cwd, ...paths.map((file) => isAbsolute(file) ? file : resolve(event.cwd ?? session.cwd ?? "", file))];
      let project: ResolvedProject | null = null;
      for (const candidate of candidates) {
        project = resolveProject(candidate, session.git_remote);
        if (project) break;
      }
      if (!project) project = resolveProject(session.cwd, session.git_remote);
      if (!project) continue;
      upsertProject(project, event.timestamp ?? session.ended_at ?? session.started_at);
      db.query("UPDATE events SET project_id = ? WHERE id = ?").run(project.id, event.id);
      const current = counts.get(project.id) ?? { project, count: 0, activity: null };
      current.count += 1;
      if (event.timestamp && (!current.activity || event.timestamp > current.activity)) current.activity = event.timestamp;
      counts.set(project.id, current);
    }

    if (counts.size === 0) {
      const fallback = resolveProject(session.cwd, session.git_remote);
      if (fallback) {
        upsertProject(fallback, session.ended_at ?? session.started_at);
        counts.set(fallback.id, { project: fallback, count: 1, activity: session.ended_at ?? session.started_at });
      }
    }

    const primary = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (primary) {
      db.query("UPDATE sessions SET project_id = ? WHERE id = ?").run(primary.project.id, session.id);
      assigned += 1;
    }
  }

  db.run(`
    UPDATE sessions AS child SET project_id = COALESCE(child.project_id, (
      SELECT parent.project_id FROM sessions AS parent WHERE parent.id = child.parent_session_id
    )) WHERE child.parent_session_id IS NOT NULL
  `);
  db.run(`
    UPDATE events SET project_id = COALESCE(project_id, (SELECT project_id FROM sessions WHERE sessions.id = events.session_id))
  `);
  return assigned;
}
