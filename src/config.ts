import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStoredSettings } from "./settings";

export interface AppConfig {
  dataDir: string;
  databasePath: string;
  codexHome: string;
  claudeHome: string;
  host: string;
  port: number;
  llm: LlmConfig;
}

export type LlmMode = "off" | "local" | "remote";

export interface LlmConfig {
  mode: LlmMode;
  baseUrl: string;
  model: string;
  apiKey?: string;
  allowRemote: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxSessionsPerScan: number;
  retryFailed: boolean;
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw !== "0" && raw !== "1") throw new Error(`${name} must be 0 or 1`);
  return raw === "1";
}

function llmConfig(stored: Partial<LlmConfig>): LlmConfig {
  const rawMode = process.env.WORKLOG_LLM_MODE ?? stored.mode ?? "off";
  if (!["off", "local", "remote"].includes(rawMode)) throw new Error("WORKLOG_LLM_MODE must be off, local or remote");
  const mode = rawMode as LlmMode;
  return {
    mode,
    baseUrl: process.env.WORKLOG_LLM_BASE_URL ?? stored.baseUrl ?? (mode === "local" ? "http://127.0.0.1:11434/v1" : ""),
    model: process.env.WORKLOG_LLM_MODEL ?? stored.model ?? "",
    apiKey: (process.env.WORKLOG_LLM_API_KEY ?? stored.apiKey) || undefined,
    allowRemote: booleanEnv("WORKLOG_LLM_ALLOW_REMOTE", stored.allowRemote ?? false),
    timeoutMs: integerEnv("WORKLOG_LLM_TIMEOUT_MS", stored.timeoutMs ?? 60_000, 1_000),
    maxInputChars: integerEnv("WORKLOG_LLM_MAX_INPUT_CHARS", stored.maxInputChars ?? 24_000, 2_000),
    maxSessionsPerScan: integerEnv("WORKLOG_LLM_MAX_SESSIONS_PER_SCAN", stored.maxSessionsPerScan ?? 20, 1),
    retryFailed: booleanEnv("WORKLOG_LLM_RETRY_FAILED", stored.retryFailed ?? false),
  };
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(process.env.WORKLOG_DATA_DIR ?? join(process.cwd(), ".worklog"));
  const stored = readStoredSettings(dataDir);
  return {
    dataDir,
    databasePath: join(dataDir, "worklog.sqlite"),
    codexHome: resolve(process.env.WORKLOG_CODEX_HOME ?? join(homedir(), ".codex")),
    claudeHome: resolve(process.env.WORKLOG_CLAUDE_HOME ?? join(homedir(), ".claude")),
    host: process.env.WORKLOG_HOST ?? "127.0.0.1",
    port: Number(process.env.WORKLOG_PORT ?? 4317),
    llm: llmConfig(stored.llm ?? {}),
  };
}
