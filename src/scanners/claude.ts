import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CanonicalEvent, ParsedRecord, SessionSeed } from "../types";
import { redactSecrets, sha256, stableId, stripInjectedContext, truncate } from "../utils";
import type { AdapterState, HistoryAdapter } from "./common";
import { jsonObject, stringValue } from "./common";

function fileIdentity(path: string): { externalId: string; parentExternalId?: string; isSubagent: boolean } {
  if (path.includes("/subagents/")) {
    return {
      externalId: `subagent:${basename(path, ".jsonl")}`,
      parentExternalId: basename(dirname(dirname(path))),
      isSubagent: true,
    };
  }
  return { externalId: basename(path, ".jsonl"), isSubagent: false };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      const obj = jsonObject(item);
      return stringValue(obj.text) ?? stringValue(obj.content) ?? "";
    }).filter(Boolean).join("\n");
  }
  return value == null ? "" : JSON.stringify(value);
}

function eventFrom(path: string, line: number, raw: string, sessionId: string, data: Omit<CanonicalEvent, "id" | "source" | "sessionExternalId" | "sourceFile" | "sourceLine" | "rawHash"> & { key?: string }): CanonicalEvent {
  const rawHash = sha256(raw);
  return {
    ...data,
    id: stableId("claude_code", sessionId, data.key ?? rawHash, data.type),
    source: "claude_code",
    sessionExternalId: sessionId,
    sourceFile: path,
    sourceLine: line,
    rawHash,
  };
}

function toolFields(name: string, input: Record<string, unknown>): { command?: string; cwd?: string; files: string[] } {
  const files = [stringValue(input.file_path), stringValue(input.path)].filter((item): item is string => Boolean(item));
  return {
    command: name === "Bash" ? stringValue(input.command) : undefined,
    cwd: stringValue(input.cwd),
    files,
  };
}

export class ClaudeCodeAdapter implements HistoryAdapter {
  readonly source = "claude_code" as const;
  constructor(private readonly home: string) {}

  async *discover(): AsyncIterable<string> {
    const root = join(this.home, "projects");
    if (!existsSync(root)) return;
    const glob = new Bun.Glob("**/*.jsonl");
    for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
      if (path.includes("/-Users-macmini99--claude-mem-observer-sessions/")) continue;
      if (path.includes("/memory/")) continue;
      yield path;
    }
  }

  seedFromPath(path: string): SessionSeed {
    const identity = fileIdentity(path);
    return { source: "claude_code", ...identity, sourceFile: path };
  }

  parse(raw: string, line: number, path: string, state: AdapterState): ParsedRecord[] {
    const record = jsonObject(JSON.parse(raw));
    const type = stringValue(record.type);
    const identity = fileIdentity(path);
    const topSessionId = stringValue(record.sessionId);
    const sessionId = identity.isSubagent ? identity.externalId : topSessionId ?? state.session.externalId;
    const timestamp = stringValue(record.timestamp);
    const cwd = stringValue(record.cwd) ?? state.session.cwd;
    const seed: SessionSeed = {
      ...state.session,
      externalId: sessionId,
      parentExternalId: identity.parentExternalId,
      cwd,
      gitBranch: stringValue(record.gitBranch) ?? state.session.gitBranch,
      startedAt: state.session.startedAt ?? timestamp,
      endedAt: timestamp ?? state.session.endedAt,
      isSubagent: identity.isSubagent || record.isSidechain === true,
      sourceFile: path,
    };
    state.session = seed;
    const results: ParsedRecord[] = [{ session: seed }];

    if (type === "ai-title" || type === "custom-title") {
      const title = stringValue(record.aiTitle) ?? stringValue(record.customTitle);
      if (title) results.push({ title: { source: "claude_code", sessionExternalId: sessionId, title } });
      return results;
    }

    if (type === "assistant") {
      const message = jsonObject(record.message);
      const content = Array.isArray(message.content) ? message.content : [];
      content.forEach((partValue, index) => {
        const part = jsonObject(partValue);
        if (part.type === "text") {
          const cleaned = redactSecrets(stripInjectedContext(stringValue(part.text) ?? ""));
          if (cleaned) results.push({ event: eventFrom(path, line, raw, sessionId, {
            key: `${stringValue(record.uuid) ?? sha256(raw)}:text:${index}`,
            type: "assistant_message", role: "assistant", timestamp, content: truncate(cleaned), cwd,
          }) });
        } else if (part.type === "tool_use") {
          const name = stringValue(part.name) ?? "unknown";
          const input = jsonObject(part.input);
          const fields = toolFields(name, input);
          results.push({ event: eventFrom(path, line, raw, sessionId, {
            key: stringValue(part.id), type: "tool_call", timestamp, toolName: name,
            toolCallId: stringValue(part.id), command: truncate(redactSecrets(fields.command ?? "")),
            cwd: fields.cwd ?? cwd, filePaths: fields.files, metadata: { argumentKeys: Object.keys(input) },
          }) });
        }
      });
      return results;
    }

    if (type === "user") {
      const message = jsonObject(record.message);
      if (typeof message.content === "string") {
        const cleaned = redactSecrets(stripInjectedContext(message.content));
        if (cleaned) results.push({ event: eventFrom(path, line, raw, sessionId, {
          key: stringValue(record.uuid), type: "user_message", role: "user", timestamp,
          content: truncate(cleaned), cwd,
        }) });
      } else if (Array.isArray(message.content)) {
        message.content.forEach((partValue, index) => {
          const part = jsonObject(partValue);
          if (part.type === "tool_result") {
            const content = redactSecrets(contentText(part.content));
            results.push({ event: eventFrom(path, line, raw, sessionId, {
              key: `${stringValue(record.uuid) ?? sha256(raw)}:${index}`,
              type: "tool_result", timestamp, toolCallId: stringValue(part.tool_use_id),
              content: truncate(content), isError: part.is_error === true, cwd,
            }) });
          } else if (part.type === "text") {
            const cleaned = redactSecrets(stripInjectedContext(stringValue(part.text) ?? ""));
            if (cleaned) results.push({ event: eventFrom(path, line, raw, sessionId, {
              key: `${stringValue(record.uuid) ?? sha256(raw)}:text:${index}`,
              type: "user_message", role: "user", timestamp, content: truncate(cleaned), cwd,
            }) });
          }
        });
      }
      return results;
    }

    return results;
  }
}
