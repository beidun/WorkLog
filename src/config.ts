import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  dataDir: string;
  databasePath: string;
  codexHome: string;
  claudeHome: string;
  host: string;
  port: number;
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(process.env.WORKLOG_DATA_DIR ?? join(process.cwd(), ".worklog"));
  return {
    dataDir,
    databasePath: join(dataDir, "worklog.sqlite"),
    codexHome: resolve(process.env.WORKLOG_CODEX_HOME ?? join(homedir(), ".codex")),
    claudeHome: resolve(process.env.WORKLOG_CLAUDE_HOME ?? join(homedir(), ".claude")),
    host: process.env.WORKLOG_HOST ?? "127.0.0.1",
    port: Number(process.env.WORKLOG_PORT ?? 4317),
  };
}
