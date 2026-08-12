import { loadConfig } from "./config";
import { WorklogDatabase } from "./db";
import { runFullScan } from "./runtime";
import { getDailyReport, getOverview } from "./services";

const command = process.argv[2] ?? "help";
const config = loadConfig();

if (command === "scan") {
  console.log("Scanning Codex and Claude Code history…");
  const result = await runFullScan(config);
  console.log(JSON.stringify(result, null, 2));
} else if (command === "serve") {
  await import("./server");
} else if (command === "status" || command === "projects") {
  const db = new WorklogDatabase(config.databasePath);
  const overview = getOverview(db) as { projects: Array<Record<string, unknown>>; metrics: Record<string, unknown> };
  console.log(`Projects: ${overview.metrics.projects} · Active: ${overview.metrics.active} · Needs attention: ${overview.metrics.needsAttention}`);
  for (const project of overview.projects) {
    console.log(`- ${project.name}: ${project.current_focus ?? "No activity"} (${project.last_activity_at ?? "unknown"})`);
  }
  db.close();
} else if (command === "daily") {
  const db = new WorklogDatabase(config.databasePath);
  const report = getDailyReport(db, process.argv[3]) as { date: string; projectCount: number; items: Array<Record<string, unknown> & { evidence?: Array<Record<string, unknown>> }> };
  console.log(`# ${report.date} 工作总结\n\n涉及 ${report.projectCount} 个项目。`);
  for (const item of report.items) {
    console.log(`- [${item.project_name}] ${item.title}: ${item.summary}`);
    for (const [index, citation] of (item.evidence ?? []).entries()) {
      console.log(`  [${index + 1}] ${citation.source} · ${citation.source_file}:${citation.source_line}`);
    }
  }
  db.close();
} else {
  console.log(`Agent Worklog\n\nCommands:\n  scan             Scan Codex and Claude Code history\n  serve            Start local API and Web UI\n  status           Show all project progress\n  daily [date]     Generate a daily summary`);
}
