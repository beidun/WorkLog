import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStoredSettings } from "./settings";
import { discoverCcswitchConfig } from "./ccswitch";

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
export type LlmProtocol = "chat_completions" | "responses" | "anthropic_messages";

export interface LlmConfig {
  mode: LlmMode;
  baseUrl: string;
  model: string;
  protocol?: LlmProtocol;
  apiKey?: string;
  allowRemote: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxSessionsPerScan: number;
  maxWorkItemsPerScan: number;
  maxProjectsPerScan: number;
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
  const hasExplicitEnvironment = LLM_CONNECTION_ENV_FIELDS.some((name) => process.env[name] !== undefined);
  const importCcswitch = process.env.WORKLOG_LLM_IMPORT_CCSWITCH === "1";
  const storedIsDefaultOff = stored.mode === "off" && !stored.model;
  const discovered = !hasExplicitEnvironment && (Object.keys(stored).length === 0 || storedIsDefaultOff) && importCcswitch
    ? discoverCcswitchConfig() : null;
  const imported = discovered ?? undefined;
  const rawMode = process.env.WORKLOG_LLM_MODE ?? stored.mode ?? "off";
  if (!["off", "local", "remote"].includes(rawMode)) throw new Error("WORKLOG_LLM_MODE must be off, local or remote");
  const mode = rawMode as LlmMode;
  const firstText = (...values: Array<string | undefined>): string | undefined => values.find((value) => Boolean(value?.trim()));
  const storedBaseUrl = storedIsDefaultOff ? undefined : stored.baseUrl;
  const storedModel = storedIsDefaultOff ? undefined : stored.model;
  const storedApiKey = storedIsDefaultOff ? undefined : stored.apiKey;
  return {
    mode: discovered?.mode ?? mode,
    baseUrl: firstText(process.env.WORKLOG_LLM_BASE_URL, storedBaseUrl, imported?.baseUrl) ?? (mode === "local" ? "http://127.0.0.1:11434/v1" : ""),
    model: firstText(process.env.WORKLOG_LLM_MODEL, storedModel, imported?.model) ?? "",
    protocol: (process.env.WORKLOG_LLM_PROTOCOL as LlmProtocol | undefined) ?? stored.protocol ?? imported?.protocol ?? "chat_completions",
    apiKey: firstText(process.env.WORKLOG_LLM_API_KEY, storedApiKey, imported?.apiKey),
    allowRemote: booleanEnv("WORKLOG_LLM_ALLOW_REMOTE", (storedIsDefaultOff ? undefined : stored.allowRemote) ?? Boolean(discovered && discovered.mode === "remote")),
    timeoutMs: integerEnv("WORKLOG_LLM_TIMEOUT_MS", stored.timeoutMs ?? 60_000, 1_000),
    maxInputChars: integerEnv("WORKLOG_LLM_MAX_INPUT_CHARS", stored.maxInputChars ?? 24_000, 2_000),
    maxSessionsPerScan: integerEnv("WORKLOG_LLM_MAX_SESSIONS_PER_SCAN", stored.maxSessionsPerScan ?? 20, 1),
    maxWorkItemsPerScan: integerEnv("WORKLOG_LLM_MAX_WORK_ITEMS_PER_SCAN", stored.maxWorkItemsPerScan ?? 20, 1),
    maxProjectsPerScan: integerEnv("WORKLOG_LLM_MAX_PROJECTS_PER_SCAN", stored.maxProjectsPerScan ?? 10, 1),
    retryFailed: booleanEnv("WORKLOG_LLM_RETRY_FAILED", stored.retryFailed ?? false),
  };
}

const LLM_CONNECTION_ENV_FIELDS = [
  "WORKLOG_LLM_MODE", "WORKLOG_LLM_BASE_URL", "WORKLOG_LLM_MODEL", "WORKLOG_LLM_API_KEY", "WORKLOG_LLM_PROTOCOL",
];

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
