import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { WorklogDatabase } from "./db";
import { runFullScan, scanState } from "./runtime";
import { getDailyReport, getEvidence, getOverview, getProject } from "./services";
import { OpenAICompatibleProvider, providerStatus } from "./llm/provider";
import { parseLlmSettingsUpdate, publicLlmSettings, readStoredSettings, writeStoredLlmSettings } from "./settings";
import { getWorkReport, type WorkReportRange } from "./work-reports";
import { clearWorkItemCorrection, parseWorkItemCorrection, saveWorkItemCorrection } from "./work-item-corrections";
import { rebuildWorkItems } from "./work-items";
import { clearProjectCorrection, parseProjectCorrection, saveProjectCorrection } from "./project-corrections";
import { clearWorkItemFeedback, getReviewQueue, parseWorkItemFeedback, saveWorkItemFeedback } from "./work-item-feedback";
import { buildWorkItemEvalSuite } from "./work-item-eval-export";
import { scoreWorkItemEval } from "./work-item-eval-score";

const config = loadConfig();
const database = new WorklogDatabase(config.databasePath);
scanState.llm = providerStatus(config.llm);
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected settings error";
  if (message.includes("WORKLOG_LLM_ALLOW_REMOTE=1")) return "远程模式需要勾选隐私授权后才能保存或测试。";
  if (message.includes("requires an https endpoint")) return "远程模式只允许使用 HTTPS 地址。";
  if (message.includes("Local LLM mode only allows")) return "本机模式只允许 localhost 或 loopback 地址。";
  if (message.includes("WORKLOG_LLM_BASE_URL is required")) return "启用模型时必须填写 Base URL。";
  if (message.includes("WORKLOG_LLM_MODEL is required")) return "启用模型时必须填写 Model。";
  if (message.includes("must not contain credentials")) return "Base URL 不能包含用户名或密码。";
  return message;
}

async function requestJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) throw new Error("Settings request is too large");
  return request.json();
}

async function api(request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/overview" && request.method === "GET") return json({ ...getOverview(database), llmProvider: scanState.llm });
  if (url.pathname === "/api/scan/status" && request.method === "GET") return json(scanState);
  if (url.pathname === "/api/settings/llm" && request.method === "GET") {
    return json(publicLlmSettings(config.llm, config.dataDir));
  }
  if (url.pathname === "/api/settings/llm" && request.method === "PUT") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const body = await requestJson(request);
      const storedApiKey = readStoredSettings(config.dataDir).llm?.apiKey;
      const nextStoredConfig = parseLlmSettingsUpdate(body, storedApiKey);
      if (nextStoredConfig.mode !== "off") new OpenAICompatibleProvider(nextStoredConfig);
      writeStoredLlmSettings(config.dataDir, nextStoredConfig);
      config.llm = loadConfig().llm;
      scanState.llm = providerStatus(config.llm);
      return json(publicLlmSettings(config.llm, config.dataDir));
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  if (url.pathname === "/api/settings/llm/test" && request.method === "POST") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const body = await requestJson(request);
      const testConfig = parseLlmSettingsUpdate(body, config.llm.apiKey);
      if (testConfig.mode === "off") return json({ error: "请先选择本机模型或远程模型。" }, 400);
      const provider = new OpenAICompatibleProvider(testConfig);
      return json(await provider.testConnection());
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  if (url.pathname === "/api/scan" && request.method === "POST") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    if (scanState.running) return json({ status: "already_running" }, 202);
    void runFullScan(config, database).catch((error) => console.error(error));
    return json({ status: "started" }, 202);
  }
  if (url.pathname === "/api/reports/work" && request.method === "GET") {
    try {
      const range = (url.searchParams.get("range") ?? "today") as WorkReportRange;
      return json(getWorkReport(database, range));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
  if (url.pathname === "/api/reports/daily" && request.method === "GET") return json(getDailyReport(database, url.searchParams.get("date") ?? undefined));
  if (url.pathname === "/api/review" && request.method === "GET") return json({ items: getReviewQueue(database) });
  if (url.pathname === "/api/evals/export" && request.method === "GET") {
    return json(buildWorkItemEvalSuite(database, { reviewedOnly: url.searchParams.get("includeUnreviewed") !== "1" }));
  }
  if (url.pathname === "/api/evals/score" && request.method === "GET") return json(scoreWorkItemEval(database));
  const correctionMatch = url.pathname.match(/^\/api\/work-items\/([a-f0-9]+)\/correction$/);
  if (correctionMatch && request.method === "PUT") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const correction = saveWorkItemCorrection(database, correctionMatch[1], parseWorkItemCorrection(await requestJson(request)));
      return json({ correction });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  if (correctionMatch && request.method === "DELETE") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const removed = clearWorkItemCorrection(database, correctionMatch[1]);
      rebuildWorkItems(database);
      return json({ removed });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  const projectCorrectionMatch = url.pathname.match(/^\/api\/work-items\/([a-f0-9]+)\/project-correction$/);
  if (projectCorrectionMatch && request.method === "PUT") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const correction = saveProjectCorrection(database, projectCorrectionMatch[1], parseProjectCorrection(await requestJson(request)));
      return json({ correction });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  const feedbackMatch = url.pathname.match(/^\/api\/work-items\/([a-f0-9]+)\/feedback(?:\/([a-z_]+))?$/);
  if (feedbackMatch && request.method === "POST") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const feedback = saveWorkItemFeedback(database, feedbackMatch[1], parseWorkItemFeedback(await requestJson(request)));
      return json({ feedback });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  if (feedbackMatch?.[2] && request.method === "DELETE") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const removed = clearWorkItemFeedback(database, feedbackMatch[1], parseWorkItemFeedback({ type: feedbackMatch[2] }).type);
      return json({ removed });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  if (projectCorrectionMatch && request.method === "DELETE") {
    if (!isLocalMutation(request)) return json({ error: "Local origin required" }, 403);
    try {
      const removed = clearProjectCorrection(database, projectCorrectionMatch[1]);
      rebuildWorkItems(database);
      return json({ removed });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
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
