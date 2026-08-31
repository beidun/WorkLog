import type { AppConfig } from "./config";
import { WorklogDatabase } from "./db";
import { assignProjects } from "./project-resolver";
import { ClaudeCodeAdapter } from "./scanners/claude";
import { CodexAdapter } from "./scanners/codex";
import { scanHistories } from "./scanners";
import { rebuildSessionDigests } from "./session-digests";
import { createModelProvider, providerStatus, type ProviderRuntimeStatus } from "./llm/provider";
import { captureProgressSnapshot } from "./progress-snapshots";
import { captureRepositorySnapshots } from "./repository-snapshots";
import type { ScanStats } from "./types";
import { rebuildWorkItems } from "./work-items";

export interface ScanRuntimeState {
  running: boolean;
  currentFile?: string;
  stats?: ScanStats;
  result?: FullScanResult;
  llm?: ProviderRuntimeStatus;
  error?: string;
}

export const scanState: ScanRuntimeState = { running: false };

export type FullScanResult = ScanStats & {
  projectsAssigned: number;
  digestsRebuilt: number;
  digestsSkipped: number;
  digestsEnhanced: number;
  digestsFallback: number;
  digestsDeferred: number;
  workItems: number;
  repositorySnapshots: number;
  repositoryChanges: number;
  repositoriesUnavailable: number;
  progressSnapshotId: string;
  progressBaseline: boolean;
  progressChanges: number;
  llmProvider: ProviderRuntimeStatus;
};

export async function runFullScan(config: AppConfig, database?: WorklogDatabase): Promise<FullScanResult> {
  if (scanState.running) throw new Error("A scan is already running");
  scanState.running = true;
  scanState.error = undefined;
  scanState.result = undefined;
  scanState.llm = providerStatus(config.llm);
  const db = database ?? new WorklogDatabase(config.databasePath);
  try {
    const stats = await scanHistories(db, [new CodexAdapter(config.codexHome), new ClaudeCodeAdapter(config.claudeHome)], (next, currentFile) => {
      scanState.stats = { ...next };
      scanState.currentFile = currentFile;
    });
    db.normalizeStoredContext();
    const projectsAssigned = assignProjects(db);
    const repositories = captureRepositorySnapshots(db, stats.finishedAt ?? new Date().toISOString());
    const provider = createModelProvider(config.llm);
    const digests = await rebuildSessionDigests(db, {
      provider,
      maxModelSessions: config.llm.maxSessionsPerScan,
      retryFailed: config.llm.retryFailed,
    });
    const workItems = rebuildWorkItems(db);
    const progress = captureProgressSnapshot(db, {
      startedAt: stats.startedAt,
      finishedAt: stats.finishedAt,
    }, stats.finishedAt ?? new Date().toISOString());
    scanState.stats = stats;
    const result = {
      ...stats, projectsAssigned, digestsRebuilt: digests.rebuilt, digestsSkipped: digests.skipped,
      digestsEnhanced: digests.enhanced, digestsFallback: digests.fallback, digestsDeferred: digests.deferred,
      repositorySnapshots: repositories.captured, repositoryChanges: repositories.changed,
      repositoriesUnavailable: repositories.unavailable,
      workItems, progressSnapshotId: progress.snapshotId, progressBaseline: progress.baseline,
      progressChanges: progress.changes.length, llmProvider: scanState.llm,
    };
    scanState.result = result;
    return result;
  } catch (error) {
    scanState.error = String(error);
    throw error;
  } finally {
    scanState.running = false;
    scanState.currentFile = undefined;
    if (!database) db.close();
  }
}
