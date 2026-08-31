import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmConfig, LlmMode } from "./config";

const SETTINGS_FILE = "settings.json";
const MODES = new Set<LlmMode>(["off", "local", "remote"]);

export const LLM_ENVIRONMENT_FIELDS = {
  WORKLOG_LLM_MODE: "mode",
  WORKLOG_LLM_BASE_URL: "baseUrl",
  WORKLOG_LLM_MODEL: "model",
  WORKLOG_LLM_API_KEY: "apiKey",
  WORKLOG_LLM_ALLOW_REMOTE: "allowRemote",
  WORKLOG_LLM_TIMEOUT_MS: "timeoutMs",
  WORKLOG_LLM_MAX_INPUT_CHARS: "maxInputChars",
  WORKLOG_LLM_MAX_SESSIONS_PER_SCAN: "maxSessionsPerScan",
  WORKLOG_LLM_RETRY_FAILED: "retryFailed",
} as const;

export interface StoredSettings {
  llm?: Partial<LlmConfig>;
}

export interface LlmSettingsUpdate {
  mode: LlmMode;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  allowRemote: boolean;
  timeoutMs: number;
  maxInputChars: number;
  maxSessionsPerScan: number;
  retryFailed: boolean;
}

export interface PublicLlmSettings extends Omit<LlmConfig, "apiKey"> {
  hasApiKey: boolean;
  source: "env" | "file" | "default";
  environmentOverrides: string[];
}

function invalid(message: string): never {
  throw new Error(`Invalid Worklog settings: ${message}`);
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maximum) invalid(`${name} is too long`);
  return normalized;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function parseStoredLlm(value: unknown): Partial<LlmConfig> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("llm must be an object");
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== undefined && (typeof mode !== "string" || !MODES.has(mode as LlmMode))) invalid("llm.mode must be off, local or remote");
  return {
    ...(mode !== undefined ? { mode: mode as LlmMode } : {}),
    ...(record.baseUrl !== undefined ? { baseUrl: optionalString(record.baseUrl, "llm.baseUrl", 2_048)! } : {}),
    ...(record.model !== undefined ? { model: optionalString(record.model, "llm.model", 256)! } : {}),
    ...(record.apiKey !== undefined ? { apiKey: optionalString(record.apiKey, "llm.apiKey", 4_096) || undefined } : {}),
    ...(record.allowRemote !== undefined ? { allowRemote: optionalBoolean(record.allowRemote, "llm.allowRemote")! } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: optionalInteger(record.timeoutMs, "llm.timeoutMs", 1_000, 300_000)! } : {}),
    ...(record.maxInputChars !== undefined ? { maxInputChars: optionalInteger(record.maxInputChars, "llm.maxInputChars", 2_000, 200_000)! } : {}),
    ...(record.maxSessionsPerScan !== undefined ? { maxSessionsPerScan: optionalInteger(record.maxSessionsPerScan, "llm.maxSessionsPerScan", 1, 200)! } : {}),
    ...(record.retryFailed !== undefined ? { retryFailed: optionalBoolean(record.retryFailed, "llm.retryFailed")! } : {}),
  };
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

export function readStoredSettings(dataDir: string): StoredSettings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    invalid(`${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("root must be an object");
  return { llm: parseStoredLlm((parsed as Record<string, unknown>).llm) };
}

export function writeStoredLlmSettings(dataDir: string, llm: LlmConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = settingsPath(dataDir);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ llm }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maximum) invalid(`${name} is too long`);
  return normalized;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
  return value;
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = optionalInteger(value, name, minimum, maximum);
  if (parsed === undefined) invalid(`${name} is required`);
  return parsed;
}

export function parseLlmSettingsUpdate(value: unknown, existingApiKey?: string): LlmConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request body must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.mode !== "string" || !MODES.has(record.mode as LlmMode)) invalid("mode must be off, local or remote");
  if (record.clearApiKey !== undefined && typeof record.clearApiKey !== "boolean") invalid("clearApiKey must be a boolean");
  const suppliedApiKey = optionalString(record.apiKey, "apiKey", 4_096);
  const apiKey = record.clearApiKey === true ? undefined : (suppliedApiKey || existingApiKey);
  return {
    mode: record.mode as LlmMode,
    baseUrl: requiredString(record.baseUrl, "baseUrl", 2_048),
    model: requiredString(record.model, "model", 256),
    apiKey,
    allowRemote: requiredBoolean(record.allowRemote, "allowRemote"),
    timeoutMs: requiredInteger(record.timeoutMs, "timeoutMs", 1_000, 300_000),
    maxInputChars: requiredInteger(record.maxInputChars, "maxInputChars", 2_000, 200_000),
    maxSessionsPerScan: requiredInteger(record.maxSessionsPerScan, "maxSessionsPerScan", 1, 200),
    retryFailed: requiredBoolean(record.retryFailed, "retryFailed"),
  };
}

export function environmentOverrides(): string[] {
  return Object.entries(LLM_ENVIRONMENT_FIELDS)
    .filter(([name]) => process.env[name] !== undefined)
    .map(([, field]) => field);
}

export function publicLlmSettings(config: LlmConfig, dataDir: string): PublicLlmSettings {
  const overrides = environmentOverrides();
  const hasFileSettings = Object.keys(readStoredSettings(dataDir).llm ?? {}).length > 0;
  const { apiKey, ...safe } = config;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey),
    source: overrides.length > 0 ? "env" : (hasFileSettings ? "file" : "default"),
    environmentOverrides: overrides,
  };
}
