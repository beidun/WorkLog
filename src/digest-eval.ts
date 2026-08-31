import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorklogDatabase } from "./db";
import { rebuildSessionDigests } from "./session-digests";
import type { EventType, SessionFactKind, WorkStatus } from "./types";
import { sha256 } from "./utils";

export interface DigestEvalEvent {
  id: string;
  type: EventType;
  role?: "user" | "assistant";
  content?: string;
  command?: string;
  toolName?: string;
  toolCallId?: string;
  filePaths?: string[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DigestEvalExpected {
  objectiveIncludes?: string[];
  headline?: string;
  status?: WorkStatus;
  nextStepEmpty?: boolean;
  factIncludes?: Array<{ kind?: SessionFactKind; textIncludes: string; eventId?: string }>;
  factExcludes?: string[];
  citationEventIds?: string[];
}

export interface DigestEvalCase {
  id: string;
  description?: string;
  events: DigestEvalEvent[];
  expected: DigestEvalExpected;
}

export interface DigestEvalSuite {
  version: number;
  cases: DigestEvalCase[];
}

export interface DigestEvalCheck {
  caseId: string;
  check: string;
  passed: boolean;
  detail: string;
}

export interface DigestEvalResult {
  suiteVersion: number;
  caseCount: number;
  passedCases: number;
  checkCount: number;
  passedChecks: number;
  passRate: number;
  checks: DigestEvalCheck[];
}

export const DEFAULT_DIGEST_EVAL_PATH = join(import.meta.dir, "../evals/session-digests.json");

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function loadDigestEvalSuite(path = DEFAULT_DIGEST_EVAL_PATH): DigestEvalSuite {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const root = objectValue(raw, "eval suite");
  if (!Number.isInteger(root.version) || Number(root.version) < 1) throw new Error("eval suite version must be a positive integer");
  if (!Array.isArray(root.cases) || root.cases.length === 0) throw new Error("eval suite cases must be a non-empty array");
  const cases = root.cases.map((entry, index) => {
    const value = objectValue(entry, `eval case ${index}`);
    if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`eval case ${index} has no id`);
    if (!Array.isArray(value.events) || value.events.length === 0) throw new Error(`eval case ${value.id} has no events`);
    return value as unknown as DigestEvalCase;
  });
  return { version: Number(root.version), cases };
}

function addCheck(checks: DigestEvalCheck[], caseId: string, name: string, passed: boolean, detail: string): void {
  checks.push({ caseId, check: name, passed, detail });
}

export async function runDigestEvalSuite(suite: DigestEvalSuite): Promise<DigestEvalResult> {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-eval-"));
  const database = new WorklogDatabase(join(root, "worklog.sqlite"));
  const sessionIds = new Map<string, string>();
  const eventIds = new Map<string, Map<string, string>>();
  try {
    for (const testCase of suite.cases) {
      const externalId = `eval:${testCase.id}`;
      const sourceFile = join(root, `${testCase.id}.jsonl`);
      const sessionId = database.upsertSession({ source: "codex", externalId, cwd: root, isSubagent: false, sourceFile });
      sessionIds.set(testCase.id, sessionId);
      const ids = new Map<string, string>();
      eventIds.set(testCase.id, ids);
      testCase.events.forEach((event, index) => {
        const id = `eval:${testCase.id}:${event.id || index + 1}`;
        ids.set(event.id || String(index + 1), id);
        database.upsertEvent({
          id,
          source: "codex",
          sessionExternalId: externalId,
          type: event.type,
          role: event.role,
          content: event.content,
          command: event.command,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          filePaths: event.filePaths,
          isError: event.isError,
          metadata: event.metadata,
          sourceFile,
          sourceLine: index + 1,
          timestamp: `2026-08-18T00:00:${String(index + 1).padStart(2, "0")}Z`,
          rawHash: sha256(JSON.stringify(event)),
        });
      });
    }
    await rebuildSessionDigests(database);
    const checks: DigestEvalCheck[] = [];
    for (const testCase of suite.cases) {
      const sessionId = sessionIds.get(testCase.id)!;
      const digest = database.db.query("SELECT objective,headline,status,next_step FROM session_digests WHERE session_id=?")
        .get(sessionId) as { objective: string; headline: string; status: string; next_step: string } | null;
      const facts = database.db.query("SELECT fact_kind,text,event_id FROM session_facts WHERE session_id=? ORDER BY rank")
        .all(sessionId) as Array<{ fact_kind: SessionFactKind; text: string; event_id: string }>;
      const expected = testCase.expected ?? {};
      if (!digest) {
        addCheck(checks, testCase.id, "digest_exists", false, "没有生成 SessionDigest");
        continue;
      }
      for (const value of expected.objectiveIncludes ?? []) {
        addCheck(checks, testCase.id, `objective_includes:${value}`, digest.objective.includes(value), `实际目标：${digest.objective}`);
      }
      if (expected.headline !== undefined) addCheck(checks, testCase.id, "headline", digest.headline === expected.headline, `实际标题：${digest.headline}`);
      if (expected.status !== undefined) addCheck(checks, testCase.id, "status", digest.status === expected.status, `实际状态：${digest.status}`);
      if (expected.nextStepEmpty !== undefined) addCheck(checks, testCase.id, "next_step_empty", (digest.next_step === "") === expected.nextStepEmpty, `实际下一步：${digest.next_step || "（空）"}`);
      for (const expectedFact of expected.factIncludes ?? []) {
        const match = facts.find((fact) => fact.text.includes(expectedFact.textIncludes)
          && (!expectedFact.kind || fact.fact_kind === expectedFact.kind)
          && (!expectedFact.eventId || eventIds.get(testCase.id)?.get(expectedFact.eventId) === fact.event_id));
        addCheck(checks, testCase.id, `fact_includes:${expectedFact.textIncludes}`, Boolean(match), `实际事实：${facts.map((fact) => `${fact.fact_kind}:${fact.text}`).join(" | ")}`);
      }
      for (const excluded of expected.factExcludes ?? []) {
        const match = facts.some((fact) => fact.text.includes(excluded));
        addCheck(checks, testCase.id, `fact_excludes:${excluded}`, !match, `实际事实中${match ? "存在" : "不存在"}该文本`);
      }
      for (const logicalEventId of expected.citationEventIds ?? []) {
        const actualEventId = eventIds.get(testCase.id)?.get(logicalEventId);
        const cited = actualEventId ? facts.some((fact) => fact.event_id === actualEventId) : false;
        addCheck(checks, testCase.id, `citation:${logicalEventId}`, cited, cited ? `引用事件 ${logicalEventId} 有对应事实` : `没有找到事件 ${logicalEventId} 的事实引用`);
      }
      const invalidReference = database.db.query(`
        SELECT COUNT(*) AS count FROM session_facts sf LEFT JOIN events e ON e.id=sf.event_id
        WHERE sf.session_id=? AND (e.id IS NULL OR e.session_id<>sf.session_id)
      `).get(sessionId) as { count: number };
      addCheck(checks, testCase.id, "citation_integrity", invalidReference.count === 0, `无效引用数：${invalidReference.count}`);
    }
    const passedChecks = checks.filter((check) => check.passed).length;
    const passedCaseIds = new Set(checks.filter((check) => check.passed).map((check) => check.caseId));
    const failedCaseIds = new Set(checks.filter((check) => !check.passed).map((check) => check.caseId));
    return {
      suiteVersion: suite.version,
      caseCount: suite.cases.length,
      passedCases: [...passedCaseIds].filter((id) => !failedCaseIds.has(id)).length,
      checkCount: checks.length,
      passedChecks,
      passRate: checks.length === 0 ? 1 : passedChecks / checks.length,
      checks,
    };
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
