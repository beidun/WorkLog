import { loadConfig } from "./config";
import { WorklogDatabase } from "./db";
import { runFullScan } from "./runtime";
import { getDailyReport, getOverview } from "./services";
import { AGENT_PROMPT_VERSION, agentSystemPrompt, providerStatus } from "./llm/provider";
import { getWorkReport, type WorkReport, type WorkReportRange } from "./work-reports";
import { loadDigestEvalSuite, runDigestEvalSuite } from "./digest-eval";
import { defaultWorkItemEvalPath, exportWorkItemEvalSuite } from "./work-item-eval-export";
import { scoreWorkItemEval } from "./work-item-eval-score";
import { discoverCcswitchConfig } from "./ccswitch";

const command = process.argv[2] ?? "help";
const config = loadConfig();

if (command === "scan") {
  console.log("Scanning Codex and Claude Code history…");
  const result = await runFullScan(config);
  console.log(JSON.stringify(result, null, 2));
} else if (command === "scan-project") {
  const projectName = process.argv.slice(3).join(" ").trim();
  if (!projectName) throw new Error("Usage: bun src/cli.ts scan-project <project name>");
  const db = new WorklogDatabase(config.databasePath);
  const project = db.db.query("SELECT id,name FROM projects WHERE name=? COLLATE NOCASE LIMIT 1").get(projectName) as { id: string; name: string } | null;
  if (!project) {
    db.close();
    throw new Error(`Project not found: ${projectName}`);
  }
  console.log(`Scanning project ${project.name} with the Agent…`);
  try {
    const result = await runFullScan(config, db, { projectId: project.id });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
} else if (command === "serve") {
  await import("./server");
} else if (command === "status" || command === "projects") {
  const db = new WorklogDatabase(config.databasePath);
  const overview = getOverview(db) as { projects: Array<Record<string, unknown>>; metrics: Record<string, unknown> };
  console.log(`Projects: ${overview.metrics.projects} · Active: ${overview.metrics.active} · Needs attention: ${overview.metrics.needsAttention}`);
  const llm = providerStatus(config.llm);
  console.log(`LLM: ${llm.enabled ? `${llm.name} · ${llm.endpoint}` : "off (deterministic local digest)"}`);
  for (const project of overview.projects) {
    console.log(`- ${project.name}: ${project.current_focus ?? "No activity"} (${project.last_activity_at ?? "unknown"})`);
  }
  db.close();
} else if (command === "daily" || command === "report") {
  const db = new WorklogDatabase(config.databasePath);
  const value = process.argv[3];
  const report: WorkReport = command === "daily"
    ? getDailyReport(db, value)
    : getWorkReport(db, (value ?? "today") as WorkReportRange);
  console.log(`# ${report.label}工作总结\n\n${report.startDate}${report.endDate === report.startDate ? "" : ` 至 ${report.endDate}`}，涉及 ${report.projectCount} 个项目、${report.itemCount} 个事项。`);
  for (const project of report.projects) {
    console.log(`\n## ${project.name}\n\n本时段：${project.todaySummary}\n当前状态：${project.currentSummary}${project.agent ? `\nAgent 判断：${project.agent.summary}（${project.agent.provider}）` : ""}`);
    for (const item of project.items) {
      console.log(`- ${item.title}: ${item.summary}`);
      for (const change of item.changeSummary) console.log(`  本时段变化：${change}`);
      if (item.nextStep) console.log(`  下一步：${item.nextStep}`);
      for (const [index, citation] of item.evidence.entries()) {
        console.log(`  [${index + 1}] ${citation.source} · ${citation.source_file}:${citation.source_line}`);
      }
    }
    for (const item of project.carryoverItems) {
      console.log(`- [历史延续] ${item.title}: ${item.summary}`);
      if (item.nextStep) console.log(`  下一步：${item.nextStep}`);
      for (const [index, citation] of item.evidence.entries()) {
        console.log(`  [${index + 1}] ${citation.source} · ${citation.source_file}:${citation.source_line}`);
      }
    }
  }
  db.close();
} else if (command === "eval") {
  const suite = loadDigestEvalSuite(process.argv[3]);
  const result = await runDigestEvalSuite(suite);
  console.log(JSON.stringify({
    suiteVersion: result.suiteVersion,
    cases: `${result.passedCases}/${result.caseCount}`,
    checks: `${result.passedChecks}/${result.checkCount}`,
    passRate: `${(result.passRate * 100).toFixed(1)}%`,
  }, null, 2));
  for (const check of result.checks.filter((item) => !item.passed)) console.error(`FAIL ${check.caseId} · ${check.check}: ${check.detail}`);
  if (result.passedChecks !== result.checkCount) process.exitCode = 1;
} else if (command === "export-eval") {
  const db = new WorklogDatabase(config.databasePath);
  const includeUnreviewed = process.argv.includes("--all");
  const requestedPath = process.argv.slice(3).find((value) => !value.startsWith("--"));
  const outputPath = requestedPath ?? defaultWorkItemEvalPath(config.dataDir);
  const result = exportWorkItemEvalSuite(db, outputPath, { reviewedOnly: !includeUnreviewed });
  console.log(JSON.stringify({ path: result.path, cases: result.caseCount, reviewedOnly: !includeUnreviewed }, null, 2));
  db.close();
} else if (command === "eval-score") {
  const db = new WorklogDatabase(config.databasePath);
  console.log(JSON.stringify(scoreWorkItemEval(db), null, 2));
  db.close();
} else if (command === "discover-llm") {
  const discovered = discoverCcswitchConfig();
  console.log(JSON.stringify(discovered ? {
    available: true,
    providerId: discovered.providerId,
    providerName: discovered.providerName,
    appType: discovered.appType,
    baseUrl: discovered.baseUrl,
    model: discovered.model,
    protocol: discovered.protocol,
    mode: discovered.mode,
    hasApiKey: Boolean(discovered.apiKey),
  } : { available: false }, null, 2));
} else if (command === "prompts") {
  console.log(JSON.stringify({
    version: AGENT_PROMPT_VERSION,
    roles: {
      session: agentSystemPrompt("session"),
      work_item: agentSystemPrompt("work_item"),
      project: agentSystemPrompt("project"),
    },
  }, null, 2));
} else {
  console.log(`Agent Worklog\n\nCommands:\n  scan                         Scan Codex and Claude Code history\n  scan-project <name>          Only send one project's events to the Agent\n  serve                        Start local API and Web UI\n  status                       Show all project progress\n  daily [YYYY-MM-DD]           Generate a summary for one date\n  report [today|yesterday|week] Generate a time-range work summary\n  prompts                      Print the three active Agent system prompts\n  eval [path]                  Run deterministic digest regression cases\n  eval-score                   Score reviewed work-item feedback\n  discover-llm                 Show safe ccswitch model configuration\n  export-eval [path] [--all]   Export reviewed work-item evaluation cases`);
}
