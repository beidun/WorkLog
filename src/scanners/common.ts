import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ParsedRecord, SessionSeed } from "../types";

export interface AdapterState {
  session: SessionSeed;
}

export interface HistoryAdapter {
  readonly source: "codex" | "claude_code";
  discover(): AsyncIterable<string>;
  seedFromPath(path: string): SessionSeed;
  parse(raw: string, line: number, path: string, state: AdapterState): ParsedRecord[];
}

export interface JsonLine {
  raw: string;
  line: number;
  endOffset: number;
}

export async function* readJsonLines(path: string, startOffset = 0, startLine = 0): AsyncGenerator<JsonLine> {
  const stream = createReadStream(path, { start: startOffset });
  let pending = Buffer.alloc(0);
  let offset = startOffset;
  let line = startLine;

  for await (const chunk of stream) {
    const buffer = Buffer.concat([pending, Buffer.from(chunk)]);
    let cursor = 0;
    while (true) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const row = buffer.subarray(cursor, newline);
      const bytes = newline - cursor + 1;
      offset += bytes;
      line += 1;
      const raw = row.toString("utf8").replace(/\r$/, "");
      if (raw.trim()) yield { raw, line, endOffset: offset };
      cursor = newline + 1;
    }
    pending = buffer.subarray(cursor);
  }

  if (pending.length > 0) {
    const raw = pending.toString("utf8").replace(/\r$/, "");
    if (raw.trim()) {
      try {
        JSON.parse(raw);
        line += 1;
        offset += pending.length;
        yield { raw, line, endOffset: offset };
      } catch {
        // An actively written JSONL file may end in a partial record. Keep the cursor
        // before it so the next incremental scan can retry the complete line.
      }
    }
  }
}

export async function fileVersion(path: string): Promise<{ size: number; mtimeMs: number }> {
  const info = await stat(path);
  return { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
