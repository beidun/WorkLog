import type { AppConfig } from "./config";
import { WorklogDatabase } from "./db";
import { assignProjects } from "./project-resolver";
import { ClaudeCodeAdapter } from "./scanners/claude";
import { CodexAdapter } from "./scanners/codex";
import { scanHistories } from "./scanners";
import type { ScanStats } from "./types";
import { rebuildWorkItems } from "./work-items";

export interface ScanRuntimeState {
  running: boolean;
  currentFile?: string;
  stats?: ScanStats;
  error?: string;
}

export const scanState: ScanRuntimeState = { running: false };

export async function runFullScan(config: AppConfig, database?: WorklogDatabase): Promise<ScanStats & { projectsAssigned: number; workItems: number }> {
  if (scanState.running) throw new Error("A scan is already running");
  scanState.running = true;
  scanState.error = undefined;
  const db = database ?? new WorklogDatabase(config.databasePath);
  try {
    const stats = await scanHistories(db, [new CodexAdapter(config.codexHome), new ClaudeCodeAdapter(config.claudeHome)], (next, currentFile) => {
      scanState.stats = { ...next };
      scanState.currentFile = currentFile;
    });
    db.normalizeStoredContext();
    const projectsAssigned = assignProjects(db);
    const workItems = rebuildWorkItems(db);
    scanState.stats = stats;
    return { ...stats, projectsAssigned, workItems };
  } catch (error) {
    scanState.error = String(error);
    throw error;
  } finally {
    scanState.running = false;
    scanState.currentFile = undefined;
    if (!database) db.close();
  }
}
