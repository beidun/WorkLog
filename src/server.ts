import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { WorklogDatabase } from "./db";
import { runFullScan, scanState } from "./runtime";
import { getDailyReport, getEvidence, getOverview, getProject } from "./services";

const config = loadConfig();
const database = new WorklogDatabase(config.databasePath);
const webRoot = join(process.cwd(), "dist", "web");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isLocalMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch { return false; }
}

async function api(request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/overview" && request.method === "GET") return json(getOverview(database));
  if (url.pathname === "/api/scan/status" && request.method === "GET") return json(scanState);
  if (url.pathname === "/api/scan" && request.method === "POST") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    if (scanState.running) return json({ status: "already_running" }, 202);
    void runFullScan(config, database).catch((error) => console.error(error));
    return json({ status: "started" }, 202);
  }
  if (url.pathname === "/api/reports/daily" && request.method === "GET") return json(getDailyReport(database, url.searchParams.get("date") ?? undefined));
  const projectMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)$/);
  if (projectMatch && request.method === "GET") {
    const result = getProject(database, projectMatch[1]);
    return result ? json(result) : json({ error: "Project not found" }, 404);
  }
  const evidenceMatch = url.pathname.match(/^\/api\/evidence\/([a-f0-9]+)$/);
  if (evidenceMatch && request.method === "GET") {
    const result = await getEvidence(database, evidenceMatch[1]);
    return result ? json(result) : json({ error: "Evidence not found" }, 404);
  }
  return null;
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const response = await api(request, url);
    if (response) return response;
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const asset = join(webRoot, requested);
    if (existsSync(asset)) return new Response(Bun.file(asset));
    const index = join(webRoot, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return json({ message: "Agent Worklog API is running", web: "Run `bun run dev:web` for the development UI." });
  },
});

console.log(`Agent Worklog listening on http://${server.hostname}:${server.port}`);
