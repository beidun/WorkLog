import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { WorklogDatabase } from "../src/db";
import { captureRepositorySnapshots, latestRepositorySnapshot } from "../src/repository-snapshots";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-repository-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Agent Worklog Test"]);
  git(repo, ["config", "user.email", "agent-worklog@example.test"]);
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial repository"]);
  const db = new WorklogDatabase(join(root, "db", "worklog.sqlite"));
  const now = "2026-08-18T00:00:00.000Z";
  db.db.query("INSERT INTO projects(id,name,root_path,last_activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("project-1", basename(repo), repo, now, now, now);
  return { db, repo };
}

describe("repository snapshots", () => {
  test("captures clean and dirty worktree evidence without reading file contents", () => {
    const { db, repo } = fixture();
    const branch = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const baseline = captureRepositorySnapshots(db, "2026-08-18T00:01:00.000Z");
    expect(baseline).toEqual({ projects: 1, captured: 1, changed: 1, unavailable: 0 });
    const repeated = captureRepositorySnapshots(db, "2026-08-18T00:01:00.000Z");
    expect(repeated).toEqual({ projects: 1, captured: 1, changed: 0, unavailable: 0 });
    expect(db.db.query("SELECT COUNT(*) AS count FROM repository_snapshots").get()).toEqual({ count: 1 });
    expect(latestRepositorySnapshot(db, "project-1")).toMatchObject({
      available: true,
      state: "clean",
      branch,
      headSubject: "initial repository",
      stagedCount: 0,
      modifiedCount: 0,
      untrackedCount: 0,
      changedFiles: [],
    });

    writeFileSync(join(repo, "README.md"), "changed\n");
    writeFileSync(join(repo, "notes.txt"), "private local note\n");
    const dirty = captureRepositorySnapshots(db, "2026-08-18T00:02:00.000Z");
    expect(dirty.changed).toBe(1);
    expect(latestRepositorySnapshot(db, "project-1")).toMatchObject({
      state: "dirty",
      modifiedCount: 1,
      untrackedCount: 1,
      changedFiles: ["README.md", "notes.txt"],
    });
    expect(db.db.query("SELECT COUNT(*) AS count FROM repository_snapshots").get()).toEqual({ count: 2 });
    db.close();
  });

  test("records a non-Git project as unavailable instead of inventing repository evidence", () => {
    const { db } = fixture();
    const plain = mkdtempSync(join(tmpdir(), "agent-worklog-plain-"));
    roots.push(plain);
    db.db.query("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("project-plain", "plain", plain, "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:00.000Z");
    const result = captureRepositorySnapshots(db, "2026-08-18T00:03:00.000Z");
    expect(result.unavailable).toBe(1);
    expect(latestRepositorySnapshot(db, "project-plain")).toMatchObject({ available: false, state: "not_git" });
    db.close();
  });
});
