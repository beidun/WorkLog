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
import type { AgentTraceStep } from "./agent/worklog-agent";
import { ProjectAgent, projectAgentInputHash, type ProjectAgentInput } from "./agent/project-agent";
import { runWorkItemAgents } from "./agent/work-item-agent";
import { clearAgentFailure, getAgentFailure, persistAgentFailure, persistAgentTrace, recordAgentFailure } from "./agent/trace-store";
import { getProjectAgentDecision, saveProjectAgentDecision } from "./agent/project-agent-store";
import { getProjectProgress } from "./services";

export interface ScanRuntimeState {
  running: boolean;
  currentFile?: string;
  stats?: ScanStats;
  result?: FullScanResult;
  llm?: ProviderRuntimeStatus;
  error?: string;
  agent?: { runId?: string; sessionId?: string; phase?: AgentTraceStep["phase"]; status?: AgentTraceStep["status"]; attempts?: number; detail?: string };
}

export const scanState: ScanRuntimeState = { running: false };

export type FullScanResult = ScanStats & {
  projectsAssigned: number;
  digestsRebuilt: number;
  digestsSkipped: number;
  digestsEnhanced: number;
  digestsFallback: number;
  digestsDeferred: number;
  workItemAgentsEnhanced: number;
  workItemAgentsFallback: number;
  workItemAgentsSkipped: number;
  workItemAgentsDeferred: number;
  workItemAgentsManual: number;
  projectAgentsEnhanced: number;
  projectAgentsFallback: number;
  projectAgentsSkipped: number;
  projectAgentsDeferred: number;
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
  scanState.agent = undefined;
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
      // A live scan gets one bounded transient retry; direct library callers
      // retain the single-attempt default for deterministic tests/rebuilds.
      agentMaxAttempts: 2,
      agentRetryDelayMs: 250,
      onAgentTrace: (step) => {
        scanState.agent = { runId: step.runId, sessionId: step.sessionId, phase: step.phase, status: step.status, attempts: step.attempt, detail: step.detail };
      },
    });
    const workItems = rebuildWorkItems(db);
    let workItemAgentsEnhanced = 0;
    let workItemAgentsFallback = 0;
    let workItemAgentsSkipped = 0;
    let workItemAgentsDeferred = 0;
    let workItemAgentsManual = 0;
    if (provider) {
      const itemAgents = await runWorkItemAgents(db, provider, {
        maxWorkItems: config.llm.maxWorkItemsPerScan,
        retryFailed: config.llm.retryFailed,
        agentMaxAttempts: 2,
        agentRetryDelayMs: 250,
        onTrace: (step) => {
          persistAgentTrace(db, step);
          scanState.agent = { runId: step.runId, sessionId: step.sessionId, phase: step.phase, status: step.status, attempts: step.attempt, detail: step.detail };
        },
      });
      workItemAgentsEnhanced = itemAgents.enhanced;
      workItemAgentsFallback = itemAgents.fallback;
      workItemAgentsSkipped = itemAgents.skipped;
      workItemAgentsDeferred = itemAgents.deferred;
      workItemAgentsManual = itemAgents.manual;
    } else {
      // When the user explicitly disables the model, do not keep model-derived
      // item narratives over a freshly rebuilt deterministic work-item set.
      db.db.run("DELETE FROM work_item_agent_decisions");
      db.db.run("DELETE FROM agent_failures WHERE scope='work_item'");
    }
    let projectAgentsEnhanced = 0;
    let projectAgentsFallback = 0;
    let projectAgentsSkipped = 0;
    let projectAgentsDeferred = 0;
    if (provider) {
      const projects = db.db.query(`
        SELECT id,name FROM projects
        WHERE EXISTS (SELECT 1 FROM work_items wi WHERE wi.project_id=projects.id)
        ORDER BY CASE WHEN EXISTS (
          SELECT 1 FROM work_items priority_wi
          WHERE priority_wi.project_id=projects.id AND priority_wi.status IN ('blocked','partially_done','done_unverified','in_progress')
        ) THEN 0 ELSE 1 END, last_activity_at DESC
      `).all() as Array<{ id: string; name: string }>;
      const projectLimit = config.llm.maxProjectsPerScan;
      let projectAttempts = 0;
      for (const project of projects) {
        const progress = getProjectProgress(db, project.id, true);
        if (!progress) continue;
        const items = progress.workstreams.flatMap((stream) => stream.items)
          .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
        const evidence = db.db.query(`
          SELECT DISTINCT e.id,e.event_type AS kind,COALESCE(NULLIF(e.content,''),NULLIF(e.command,''),e.tool_name,e.event_type) AS text,e.timestamp,e.is_error
          FROM work_item_evidence wie JOIN events e ON e.id=wie.event_id JOIN work_items wi ON wi.id=wie.work_item_id
          WHERE wi.project_id=? ORDER BY e.timestamp DESC,e.source_line DESC LIMIT 80
        `).all(project.id).map((event) => {
          const row = event as { id: string; kind: string; text: string; timestamp?: string; is_error: number };
          return { id: row.id, kind: row.kind, text: row.text, timestamp: row.timestamp, isError: row.is_error === 1 };
        }) as Array<{ id: string; kind: string; text: string; timestamp?: string; isError?: boolean }>;
        if (evidence.length === 0) continue;
        const traceSessionId = db.db.query(`SELECT wis.session_id FROM work_item_sessions wis JOIN work_items wi ON wi.id=wis.work_item_id WHERE wi.project_id=? ORDER BY wi.last_activity_at DESC LIMIT 1`).get(project.id) as { session_id: string } | null;
        const input: ProjectAgentInput = { projectId: project.id, projectName: project.name, items, evidence, deterministicStage: progress.stage, traceSessionId: traceSessionId?.session_id };
        const inputHash = projectAgentInputHash(input);
        const previousFailure = getAgentFailure(db, "project", project.id);
        if (previousFailure?.inputHash === inputHash && previousFailure.provider === provider.name && !config.llm.retryFailed) {
          projectAgentsSkipped += 1;
          continue;
        }
        if (previousFailure) clearAgentFailure(db, "project", project.id);
        const cachedDecision = getProjectAgentDecision(db, project.id);
        if (cachedDecision?.inputHash === inputHash && cachedDecision.provider === provider.name) {
          projectAgentsSkipped += 1;
          continue;
        }
        if (cachedDecision) db.db.query("DELETE FROM project_agent_decisions WHERE project_id=?").run(project.id);
        if (projectAttempts >= projectLimit) {
          projectAgentsDeferred += 1;
          continue;
        }
        projectAttempts += 1;
        let runId: string | undefined;
        let attempts = 0;
        try {
          const decision = await new ProjectAgent(provider, (step) => {
            runId = step.runId;
            attempts = Math.max(attempts, step.attempt);
            if (step.sessionId) persistAgentTrace(db, step);
            scanState.agent = { runId: step.runId, sessionId: step.sessionId, phase: step.phase, status: step.status, attempts: step.attempt, detail: step.detail };
          }, { maxAttempts: 2, retryDelayMs: 250 }).run(input);
          saveProjectAgentDecision(db, decision);
          clearAgentFailure(db, "project", project.id);
          projectAgentsEnhanced += 1;
        } catch (error) {
          projectAgentsFallback += 1;
          recordAgentFailure(db, {
            scope: "project", targetId: project.id, inputHash, provider: provider.name,
            error: error instanceof Error ? error.message : String(error),
          });
          if (runId && traceSessionId?.session_id) {
            persistAgentFailure(db, runId, traceSessionId.session_id, error, provider.name, attempts, "project", project.id);
          }
        }
      }
    }
    const progress = captureProgressSnapshot(db, {
      startedAt: stats.startedAt,
      finishedAt: stats.finishedAt,
    }, stats.finishedAt ?? new Date().toISOString());
    scanState.stats = stats;
    const result = {
      ...stats, projectsAssigned, digestsRebuilt: digests.rebuilt, digestsSkipped: digests.skipped,
      digestsEnhanced: digests.enhanced, digestsFallback: digests.fallback, digestsDeferred: digests.deferred,
      workItemAgentsEnhanced, workItemAgentsFallback, workItemAgentsSkipped, workItemAgentsDeferred, workItemAgentsManual,
      projectAgentsEnhanced, projectAgentsFallback, projectAgentsSkipped, projectAgentsDeferred,
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
