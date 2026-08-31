import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(...parts: Array<string | number | null | undefined>): string {
  return sha256(parts.map((part) => part ?? "").join("\u001f")).slice(0, 32);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function truncate(value: string | undefined, max = 24_000): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripInjectedContext(value: string): string {
  if (/^The following is the Codex agent history\b/i.test(value.trim())) return "";
  const injectedTags = [
    "claude-mem-context",
    "system-reminder",
    "codex_internal_context",
    "environment_context",
    "ide_opened_file",
    "ide_selection",
    "local-command-caveat",
    "local-command-stdout",
    "command-name",
    "command-message",
    "command-args",
    "task-notification",
    "subagent_notification",
    "in-app-browser-context",
    "turn_aborted",
  ];
  let cleaned = value;
  for (const tag of injectedTags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  return cleaned.trim();
}

export function redactSecrets(value: string): string {
  return value
    .replace(/((?:^|\s)(?:-u|--user)\s+)(?:'[^'\r\n]*:[^'\r\n]*'|"[^"\r\n]*:[^"\r\n]*"|[^\s'"\r\n]+:[^\s'"\r\n]+)/gim, "$1[REDACTED_BASIC_AUTH]")
    .replace(/(https?:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, "$1[REDACTED_BASIC_AUTH]@")
    .replace(/((?:^|\s)(?:-b|--cookie)\s+)(?:'[^'\r\n]*'|"[^"\r\n]*"|[^\s\r\n]+)/gim, "$1[REDACTED_COOKIES]")
    .replace(/(Authorization\s*:\s*)[^'"\r\n]+/gi, "$1[REDACTED]")
    .replace(/(Cookie\s*:\s*)[^'"\r\n]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function redactJsonFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (/(?:encrypted_content|signature|password|passwd|secret|token|api[_-]?key|authorization|cookie)/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, redactJsonFields(entry)];
  }));
}

export function redactRawEvidence(value: string): string {
  try {
    return redactSecrets(JSON.stringify(redactJsonFields(JSON.parse(value))));
  } catch {
    return redactSecrets(value);
  }
}
