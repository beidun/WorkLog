import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { CanonicalEvent, ParsedRecord, SessionSeed } from "../types";
import { redactSecrets, sha256, stableId, stripInjectedContext, truncate } from "../utils";
import type { AdapterState, HistoryAdapter } from "./common";
import { jsonObject, stringValue } from "./common";

function idFromPath(path: string): string {
  const match = basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match?.[1] ?? stableId("codex-file", path);
}

function decodeArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload.arguments ?? payload.input;
  if (typeof value === "string") {
    try { return jsonObject(JSON.parse(value)); } catch { return { input: value }; }
  }
  return jsonObject(value);
}

function extractPatchFiles(value: string): string[] {
  const files: string[] = [];
  for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(match[1].trim());
  return files;
}

function eventFrom(path: string, line: number, raw: string, sessionId: string, data: Omit<CanonicalEvent, "id" | "source" | "sessionExternalId" | "sourceFile" | "sourceLine" | "rawHash"> & { key?: string }): CanonicalEvent {
  const rawHash = sha256(raw);
  return {
    ...data,
    id: stableId("codex", sessionId, data.key ?? rawHash, data.type),
    source: "codex",
    sessionExternalId: sessionId,
    sourceFile: path,
    sourceLine: line,
    rawHash,
  };
}

export class CodexAdapter implements HistoryAdapter {
  readonly source = "codex" as const;
  constructor(private readonly home: string) {}

  async *discover(): AsyncIterable<string> {
    for (const root of [join(this.home, "sessions"), join(this.home, "archived_sessions")]) {
      if (!existsSync(root)) continue;
      const glob = new Bun.Glob("**/*.jsonl");
      for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) yield path;
    }
  }

  seedFromPath(path: string): SessionSeed {
    return { source: "codex", externalId: idFromPath(path), isSubagent: false, sourceFile: path };
  }

  parse(raw: string, line: number, path: string, state: AdapterState): ParsedRecord[] {
    const record = jsonObject(JSON.parse(raw));
    const type = stringValue(record.type);
    const payload = jsonObject(record.payload);
    const timestamp = stringValue(record.timestamp) ?? stringValue(payload.timestamp);
    const sessionId = type === "session_meta"
      ? stringValue(payload.session_id) ?? stringValue(payload.id) ?? state.session.externalId
      : state.session.externalId;

    if (type === "session_meta") {
      const git = jsonObject(payload.git);
      const rawParentId = stringValue(payload.parent_thread_id) ?? stringValue(payload.forked_from_id);
      const parentExternalId = rawParentId && rawParentId !== sessionId ? rawParentId : undefined;
      const seed: SessionSeed = {
        source: "codex",
        externalId: sessionId,
        parentExternalId,
        cwd: stringValue(payload.cwd),
        gitBranch: stringValue(git.branch),
        gitCommit: stringValue(git.commit_hash),
        gitRemote: stringValue(git.repository_url),
        startedAt: timestamp,
        isSubagent: Boolean(parentExternalId),
        sourceFile: path,
      };
      state.session = seed;
      return [{ session: seed }];
    }

    if (type === "turn_context") {
      const cwd = stringValue(payload.cwd);
      if (!cwd) return [];
      const seed = { ...state.session, externalId: sessionId, cwd, endedAt: timestamp };
      state.session = seed;
      return [{ session: seed }];
    }

    if (type === "response_item" && payload.type === "message") {
      const role = stringValue(payload.role);
      if (role !== "user" && role !== "assistant") return [];
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content.map((item) => {
        const part = jsonObject(item);
        return stringValue(part.text);
      }).filter(Boolean).join("\n");
      const cleaned = redactSecrets(stripInjectedContext(text));
      if (!cleaned) return [];
      return [{ event: eventFrom(path, line, raw, sessionId, {
        key: stringValue(payload.id), type: role === "user" ? "user_message" : "assistant_message",
        role, timestamp, content: truncate(cleaned), cwd: state.session.cwd,
      }) }];
    }

    if (type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      const args = decodeArgs(payload);
      const name = stringValue(payload.name) ?? "unknown";
      const input = stringValue(args.input);
      const command = stringValue(args.cmd)
        ?? (["exec", "exec_command"].includes(name) ? input : undefined)
        ?? (name === "apply_patch" ? input : undefined);
      const filePaths = [stringValue(args.path), stringValue(args.file_path), ...extractPatchFiles(input ?? "")].filter((item): item is string => Boolean(item));
      return [{ event: eventFrom(path, line, raw, sessionId, {
        key: stringValue(payload.id) ?? stringValue(payload.call_id), type: "tool_call", timestamp,
        toolName: name, toolCallId: stringValue(payload.call_id), command: truncate(redactSecrets(command ?? "")),
        content: name === "apply_patch" ? "Applied a source patch" : undefined,
        cwd: stringValue(args.workdir) ?? state.session.cwd, filePaths, metadata: { argumentKeys: Object.keys(args) },
      }) }];
    }

    if (type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
      const outputValue = payload.output;
      const output = typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "");
      let isError = false;
      try {
        const parsed = jsonObject(JSON.parse(output));
        isError = typeof parsed.exit_code === "number" && parsed.exit_code !== 0 || parsed.isError === true;
      } catch {
        isError = /(?:exit code|status)\s*[:=]?\s*[1-9]\d*|script failed|isError["']?\s*:\s*true/i.test(output);
      }
      return [{ event: eventFrom(path, line, raw, sessionId, {
        key: stringValue(payload.id) ?? stringValue(payload.call_id), type: "tool_result", timestamp,
        toolCallId: stringValue(payload.call_id), content: truncate(redactSecrets(output)), isError,
        cwd: state.session.cwd,
      }) }];
    }

    if (type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(String(payload.type))) {
      const mapped = payload.type === "task_complete" ? "task_completed" : payload.type === "turn_aborted" ? "task_aborted" : "task_started";
      return [{ event: eventFrom(path, line, raw, sessionId, {
        key: stringValue(payload.turn_id), type: mapped, timestamp,
        content: mapped === "task_aborted" ? stringValue(payload.reason) : undefined, cwd: state.session.cwd,
      }) }];
    }

    return [];
  }
}
