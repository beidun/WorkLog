import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { ClaudeCodeAdapter } from "../src/scanners/claude";
import { CodexAdapter } from "../src/scanners/codex";
import { scanHistories } from "../src/scanners";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-test-"));
  roots.push(root);
  return root;
}

describe("history adapters", () => {
  test("Codex tool calls and results keep a stable evidence link", async () => {
    const root = tempRoot();
    const codex = join(root, ".codex");
    const file = join(codex, "sessions", "2026", "08", "12", "rollout-2026-08-12T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
    await Bun.write(file, [
      { type: "session_meta", timestamp: "2026-08-12T00:00:00Z", payload: { id: "11111111-1111-4111-8111-111111111111", cwd: root } },
      { type: "response_item", timestamp: "2026-08-12T00:01:00Z", payload: { type: "function_call", id: "call-row", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "bun test", workdir: root }) } },
      { type: "response_item", timestamp: "2026-08-12T00:01:01Z", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ exit_code: 0, output: "2 pass" }) } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const stats = await scanHistories(db, [new CodexAdapter(codex)]);
    expect(stats.eventsUpserted).toBe(2);
    const rows = db.db.query("SELECT event_type, tool_call_id, is_error FROM events ORDER BY source_line").all() as any[];
    expect(rows).toEqual([
      { event_type: "tool_call", tool_call_id: "call-1", is_error: 0 },
      { event_type: "tool_result", tool_call_id: "call-1", is_error: 0 },
    ]);
    const again = await scanHistories(db, [new CodexAdapter(codex)]);
    expect(again.filesSkipped).toBe(1);
    expect(db.db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });

    appendFileSync(file, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-12T00:02:00Z",
      payload: { type: "function_call", call_id: "call-2", name: "exec_command", arguments: JSON.stringify({ cmd: "bun run build" }) },
    })}\n`);
    const incremental = await scanHistories(db, [new CodexAdapter(codex)]);
    expect(incremental.eventsUpserted).toBe(1);
    expect(db.db.query("SELECT cwd FROM events WHERE tool_call_id = 'call-2'").get()).toEqual({ cwd: root });
    db.close();
  });

  test("Codex legacy custom exec calls preserve their command", async () => {
    const root = tempRoot();
    const codex = join(root, ".codex");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const file = join(codex, "sessions", "2026", "08", "12", `rollout-2026-08-12T00-00-00-${sessionId}.jsonl`);
    await Bun.write(file, [
      { type: "session_meta", timestamp: "2026-08-12T00:00:00Z", payload: { id: sessionId, parent_thread_id: sessionId, cwd: root } },
      { type: "response_item", timestamp: "2026-08-12T00:01:00Z", payload: { type: "custom_tool_call", call_id: "legacy-1", name: "exec", input: "cargo test --locked" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    await scanHistories(db, [new CodexAdapter(codex)]);
    expect(db.db.query("SELECT tool_name, command, cwd FROM events WHERE tool_call_id = 'legacy-1'").get())
      .toEqual({ tool_name: "exec", command: "cargo test --locked", cwd: root });
    expect(db.db.query("SELECT parent_external_id, parent_session_id, is_subagent FROM sessions WHERE external_id = ?").get(sessionId))
      .toEqual({ parent_external_id: null, parent_session_id: null, is_subagent: 0 });
    db.close();
  });

  test("Claude Code excludes observer sessions and links tool results", async () => {
    const root = tempRoot();
    const claude = join(root, ".claude");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const file = join(claude, "projects", "-tmp-project", `${sessionId}.jsonl`);
    const observer = join(claude, "projects", "-Users-macmini99--claude-mem-observer-sessions", "ignored.jsonl");
    await Bun.write(file, [
      { type: "user", uuid: "u1", sessionId, cwd: root, timestamp: "2026-08-12T00:00:00Z", message: { content: "修复扫描器" } },
      { type: "assistant", uuid: "a1", sessionId, cwd: root, timestamp: "2026-08-12T00:01:00Z", message: { content: [{ type: "tool_use", id: "tool-1", name: "Edit", input: { file_path: join(root, "src.ts"), old_string: "a", new_string: "b" } }] } },
      { type: "user", uuid: "u2", sessionId, cwd: root, timestamp: "2026-08-12T00:01:01Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "updated", is_error: false }] } },
    ].map(JSON.stringify).join("\n") + "\n");
    await Bun.write(observer, `${JSON.stringify({ type: "user", sessionId: "noise", message: { content: "noise" } })}\n`);
    const db = new WorklogDatabase(join(root, "worklog.sqlite"));
    const stats = await scanHistories(db, [new ClaudeCodeAdapter(claude)]);
    expect(stats.filesDiscovered).toBe(1);
    const rows = db.db.query("SELECT event_type, tool_call_id FROM events ORDER BY source_line").all() as any[];
    expect(rows.map((row) => row.event_type)).toEqual(["user_message", "tool_call", "tool_result"]);
    expect(rows[1].tool_call_id).toBe(rows[2].tool_call_id);
    db.close();
  });
});
