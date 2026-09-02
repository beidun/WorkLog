import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmMode, LlmProtocol } from "./config";

/** A safe, read-only projection of a ccswitch Codex/Claude provider. */
export interface CcswitchProviderConfig {
  providerId: string;
  providerName: string;
  appType: "codex" | "claude";
  baseUrl: string;
  model: string;
  apiKey?: string;
  protocol: LlmProtocol;
  mode: Exclude<LlmMode, "off">;
}

interface ProviderRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  is_current: number;
  meta: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tomlString(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']`, "m"));
  return match?.[1]?.trim() || undefined;
}

function modeFor(baseUrl: string): Exclude<LlmMode, "off"> {
  const url = new URL(baseUrl);
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ? "local" : "remote";
}

function parseRow(row: ProviderRow): CcswitchProviderConfig | null {
  let settings: unknown;
  try { settings = JSON.parse(row.settings_config); } catch { return null; }
  if (!settings || typeof settings !== "object") return null;
  const record = settings as Record<string, unknown>;
  const config = stringValue(record.config);
  const env = record.env && typeof record.env === "object" ? record.env as Record<string, unknown> : {};
  const baseUrl = row.app_type === "codex" && config ? tomlString(config, "base_url") : stringValue(env.ANTHROPIC_BASE_URL);
  const model = row.app_type === "codex" && config
    ? tomlString(config, "model")
    : stringValue(env.ANTHROPIC_MODEL) ?? stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME) ?? stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  if (!baseUrl || !model) return null;
  let parsedUrl: URL;
  try { parsedUrl = new URL(baseUrl); } catch { return null; }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) return null;
  const auth = record.auth && typeof record.auth === "object" ? record.auth as Record<string, unknown> : {};
  const apiKey = row.app_type === "codex" ? stringValue(auth.OPENAI_API_KEY) : stringValue(env.ANTHROPIC_AUTH_TOKEN);
  const wireApi = config ? tomlString(config, "wire_api") : undefined;
  let meta: Record<string, unknown> = {};
  try { const parsedMeta = JSON.parse(row.meta); if (parsedMeta && typeof parsedMeta === "object") meta = parsedMeta as Record<string, unknown>; } catch { /* ignore malformed metadata */ }
  const protocol: LlmProtocol = row.app_type === "claude"
    ? "anthropic_messages"
    : wireApi === "responses" || meta.apiFormat === "openai_responses" ? "responses" : "chat_completions";
  return {
    providerId: row.id,
    providerName: row.name,
    appType: row.app_type as "codex" | "claude",
    baseUrl,
    model,
    apiKey,
    protocol,
    mode: modeFor(baseUrl),
  };
}

/** Read only the selected Codex/Claude provider; credentials never leave this process. */
export function discoverCcswitchConfig(home = process.env.WORKLOG_CCSWITCH_HOME ?? join(homedir(), ".cc-switch"), preferredAppType?: "codex" | "claude", preferredProviderId?: string): CcswitchProviderConfig | null {
  const path = join(home, "cc-switch.db");
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    const rows = db.query(`
      SELECT id,app_type,name,settings_config,is_current,meta
      FROM providers WHERE app_type IN ('codex','claude')
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, is_current DESC,
        CASE app_type WHEN ? THEN 0 ELSE 1 END, created_at DESC, id
    `).all(preferredProviderId ?? "", preferredAppType ?? "codex") as ProviderRow[];
    for (const row of rows) {
      const parsed = parseRow(row);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
