import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorklogDatabase } from "../src/db";
import { objectiveTitle, rebuildSessionDigests } from "../src/session-digests";
import type { SessionDigestResult, WorklogModelProvider } from "../src/llm/provider";
import type { CanonicalEvent, EventType } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-worklog-digest-"));
  roots.push(root);
  const db = new WorklogDatabase(join(root, "worklog.sqlite"));
  const externalId = "session-digest-test";
  db.upsertSession({ source: "codex", externalId, cwd: root, isSubagent: false, sourceFile: join(root, "session.jsonl") });
  let line = 0;
  const add = (type: EventType, values: Partial<CanonicalEvent> = {}) => {
    line += 1;
    const id = `event-${line}`;
    db.upsertEvent({
      id,
      source: "codex",
      sessionExternalId: externalId,
      type,
      timestamp: `2026-08-12T00:00:${String(line).padStart(2, "0")}Z`,
      sourceFile: join(root, "session.jsonl"),
      sourceLine: line,
      rawHash: `hash-${line}`,
      ...values,
    });
    return id;
  };
  return { db, add, root };
}

describe("session digest", () => {
  test("turns verbose first prompts into concise work goals", () => {
    expect(objectiveTitle("当前项目里面有3个项目都是关于agent项目里的记忆的，你帮我分别解读一下"))
      .toBe("解读agent项目里的记忆相关项目");
    expect(objectiveTitle("这是ETF资金流的一个爬取脚本，你看看呢，你了解一下爬取逻辑"))
      .toBe("梳理ETF资金流爬取逻辑");
    expect(objectiveTitle("解释这个top的输出呢"))
      .toBe("解读这个top的输出");
    expect(objectiveTitle("给我clickhouse中的查询指令，来确保一年内的数据完整性"))
      .toBe("生成 ClickHouse 数据完整性查询指令");
    expect(objectiveTitle("sh脚本在项目里，不在data1中"))
      .toBe("修正定时任务脚本路径");
    expect(objectiveTitle("我如何查看当前mysql数据的一些配置，和每个数据的数据大小"))
      .toBe("查看 MySQL 配置与数据库大小");
    expect(objectiveTitle("给我脚本导入12-13号的数据"))
      .toBe("生成 12-13 日数据导入指令");
    expect(objectiveTitle("同花顺的数据接口当前项目的路由和数据源是啥"))
      .toBe("梳理同花顺接口路由与数据源");
    expect(objectiveTitle("你直接查clickhouse"))
      .toBe("查询 ClickHouse 数据");
  });

  test("turns a conversation into progress and ignores a failure fixed later", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "请帮我修复增量扫描问题" });
    add("tool_call", { toolName: "apply_patch", toolCallId: "edit-1", filePaths: ["src/scanner.ts"] });
    add("tool_result", { toolCallId: "edit-1", content: "Done" });
    add("tool_call", { toolName: "exec_command", toolCallId: "test-1", command: "bun test" });
    add("tool_result", { toolCallId: "test-1", content: "1 fail", isError: true });
    add("tool_call", { toolName: "exec_command", toolCallId: "test-2", command: "bun test" });
    add("tool_result", { toolCallId: "test-2", content: "6 pass" });
    add("assistant_message", { role: "assistant", content: "增量扫描已经修复，测试全部通过。" });

    expect(await rebuildSessionDigests(db)).toEqual({ rebuilt: 1, skipped: 0, enhanced: 0, fallback: 0, deferred: 0 });
    const digest = db.db.query("SELECT headline, progress_summary, status, blockers_json, validations_json FROM session_digests").get() as any;
    expect(digest.headline).not.toBe("请帮我修复增量扫描问题");
    expect(digest.progress_summary).toContain("增量扫描");
    expect(digest.status).toBe("verified");
    expect(JSON.parse(digest.blockers_json)).toEqual([]);
    expect(JSON.parse(digest.validations_json).join(" ")).toContain("bun test");
    expect(await rebuildSessionDigests(db)).toEqual({ rebuilt: 0, skipped: 1, enhanced: 0, fallback: 0, deferred: 0 });
    db.close();
  });

  test("stores source-linked atomic findings, changes and validations", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "实现并验证增量扫描" });
    const writeId = add("tool_call", { toolName: "apply_patch", toolCallId: "fact-edit", filePaths: ["src/scanner.ts"] });
    add("tool_result", { toolCallId: "fact-edit", content: "Done" });
    add("tool_call", { toolName: "exec_command", toolCallId: "fact-test", command: "bun test" });
    const validationResultId = add("tool_result", { toolCallId: "fact-test", content: "41 pass" });
    const conclusionId = add("assistant_message", {
      role: "assistant",
      content: "结论：增量扫描已经实现，41 项测试全部通过。",
      metadata: { phase: "final_answer" },
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const facts = db.db.query("SELECT fact_kind,text,event_id FROM session_facts ORDER BY rank").all() as Array<any>;
    expect(facts.some((fact) => fact.fact_kind === "finding" && fact.event_id === conclusionId)).toBeTrue();
    expect(facts.some((fact) => fact.fact_kind === "change" && fact.event_id === writeId && fact.text.includes("src/scanner.ts"))).toBeTrue();
    expect(facts.some((fact) => fact.fact_kind === "validation" && fact.event_id === validationResultId && fact.text.includes("bun test"))).toBeTrue();
    expect(db.db.query("SELECT COUNT(*) AS count FROM session_digest_evidence WHERE event_id=? AND digest_section='finding'").get(conclusionId)).toEqual({ count: 1 });
    db.close();
  });

  test("extracts concrete values from code blocks and markdown result tables", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查 Shibor 数据完整性" });
    add("assistant_message", {
      role: "assistant",
      content: "数据校验结果如下：\n\n当前数据目录：\n```text\n/data/shibor\n```\n\n| 表 | 行数 | 日期范围 | 质量 |\n|---|---:|---|---|\n| shibor_daily | 4,944 | 2006-10-08 ~ 2026-07-24 | 零 NULL |",
      metadata: { phase: "final_answer" },
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const findings = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank").all() as Array<{ text: string }>;
    expect(findings.some((fact) => fact.text.includes("当前数据目录：/data/shibor"))).toBeTrue();
    expect(findings.some((fact) => fact.text.includes("shibor_daily；4,944") && fact.text.includes("零 NULL"))).toBeTrue();
    expect((db.db.query("SELECT progress_summary FROM session_digests").get() as any).progress_summary).toContain("/data/shibor");
    db.close();
  });

  test("prioritizes the final conclusion over secondary structured metrics", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "分析 MySQL 数据量与缓存配置" });
    add("assistant_message", {
      role: "assistant",
      content: "结论：这台实例可见的约 383 GB 数据全部是 InnoDB，而 Buffer Pool 只有 128 MB，明显过小。\n\n粗略缓存命中率：\n```text\n1 - 202164532 / 23399688519 ≈ 99.14%\n```",
      metadata: { phase: "final_answer" },
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const findings = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank").all() as Array<{ text: string }>;
    expect(findings[0]?.text).toContain("383 GB 数据全部是 InnoDB");
    expect((db.db.query("SELECT progress_summary FROM session_digests").get() as any).progress_summary).toContain("Buffer Pool 只有 128 MB");
    db.close();
  });

  test("does not turn operational command blocks into findings", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "重启并检查本地服务" });
    add("assistant_message", {
      role: "assistant",
      content: [
        "停止旧进程：", "```bash", "kill -TERM 123", "```",
        "等待退出：", "```bash", "sleep 2", "```",
        "检查进程：", "```bash", "pgrep -a agent-worklog", "```",
        "查看定时任务：", "```bash", "crontab -l", "```",
        "结论：本地服务已经完成重启并恢复响应。",
      ].join("\n"),
      metadata: { phase: "final_answer" },
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const findings = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank").all() as Array<{ text: string }>;
    expect(findings[0]?.text).toContain("服务已经完成重启");
    expect(findings.some((fact) => /(?:kill|sleep|pgrep|crontab)\b/i.test(fact.text))).toBeFalse();
    db.close();
  });

  test("keeps a concrete result lead that introduces detailed output", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "龙虎榜接口有哪些" });
    add("assistant_message", {
      role: "assistant",
      content: "当前 `zsx-dev` 分支共有 3 个龙虎榜接口，均支持 GET 和 POST：\n\n1. 股票龙虎榜明细\n2. 股票龙虎榜汇总\n3. 东财期货龙虎榜",
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const fact = db.db.query("SELECT fact_kind,text FROM session_facts ORDER BY rank LIMIT 1").get() as any;
    expect(fact.fact_kind).toBe("finding");
    expect(fact.text).toContain("共有 3 个龙虎榜接口");
    db.close();
  });

  test("extracts an explicit audit result", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "审核新增文档" });
    add("assistant_message", { role: "assistant", content: "审核结果：4 份新增文档仍有发布前备注，暂不建议发布。" });
    add("task_completed");

    await rebuildSessionDigests(db);
    const finding = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank LIMIT 1").get() as { text: string };
    expect(finding.text).toContain("4 份新增文档");
    db.close();
  });

  test("extracts a short acknowledged conclusion without keeping the acknowledgement", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "港股行业需要新增定时任务吗" });
    add("user_message", { role: "user", content: "那就沿用现有批次" });
    add("assistant_message", { role: "assistant", content: "好的，港股行业表入 ClickHouse 全流程完成，定时任务沿用现有 clickhouse 批次自动覆盖，不需要额外配置。" });
    add("task_completed");

    await rebuildSessionDigests(db);
    const findings = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank").all() as Array<{ text: string }>;
    expect(findings.some((fact) => fact.text.includes("批次自动覆盖"))).toBeTrue();
    expect(findings.every((fact) => !fact.text.startsWith("好的"))).toBeTrue();
    db.close();
  });

  test("extracts a concrete data verdict that does not start with a conclusion label", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "当前机器不能查，你用 ssh 帮我看看" });
    add("tool_call", { toolName: "exec_command", toolCallId: "data-check", command: "ssh server check-data" });
    add("tool_result", { toolCallId: "data-check", content: "checked" });
    add("assistant_message", { role: "assistant", content: "查完了，7 月 10 日的空值比例与相邻交易日一致。" });
    add("user_message", { role: "user", content: "好的，懂了" });
    add("assistant_message", { role: "assistant", content: "好的。7 月 10 日的多头、空头平均价空值与对应方向未上榜严格一致，数据正常，不需要重爬或修改。" });

    await rebuildSessionDigests(db);
    const finding = db.db.query("SELECT text FROM session_facts WHERE fact_kind='finding' ORDER BY rank LIMIT 1").get() as { text: string };
    expect(finding.text).toContain("数据正常");
    expect(finding.text).toContain("不需要重爬或修改");
    expect(db.db.query("SELECT status FROM session_digests").get()).toEqual({ status: "verified" });
    db.close();
  });

  test("closes a tool-backed audit when the final verdict has no completion keyword", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查 sector 上周数据" });
    add("tool_call", { toolName: "exec_command", toolCallId: "sector-check", command: "ssh server check-sector" });
    add("tool_result", { toolCallId: "sector-check", content: "rows and null checks" });
    add("assistant_message", { role: "assistant", content: "上周 sector_daily_flow 全部完整，无缺口，写入时间符合预期，主力净流入在正常范围内。" });

    await rebuildSessionDigests(db);
    expect(db.db.query("SELECT status, next_step FROM session_digests").get()).toEqual({ status: "verified", next_step: "" });
    db.close();
  });

  test("keeps facts on the latest answer turn and ignores negated next steps", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查旧接口" });
    add("assistant_message", { role: "assistant", content: "结论：旧接口共有 12 条数据。", metadata: { phase: "final_answer" } });
    add("task_completed");
    add("user_message", { role: "user", content: "继续" });
    add("assistant_message", { role: "assistant", content: "当前正在核对新接口，没有明确下一步，保持为空。", metadata: { phase: "commentary" } });

    await rebuildSessionDigests(db);
    const facts = db.db.query("SELECT fact_kind,text FROM session_facts").all() as Array<any>;
    expect(facts.some((fact) => fact.text.includes("旧接口共有 12 条"))).toBeFalse();
    expect(facts.some((fact) => fact.fact_kind === "next_step")).toBeFalse();
    expect((db.db.query("SELECT next_step FROM session_digests").get() as any).next_step).toBe("");
    db.close();
  });

  test("marks only an unresolved final dependency as blocked", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "部署本地服务" });
    add("tool_call", { toolName: "exec_command", toolCallId: "serve-1", command: "bun run start" });
    add("tool_result", { toolCallId: "serve-1", content: "permission denied", isError: true });
    add("assistant_message", { role: "assistant", content: "当前缺少端口监听权限，无法继续，需要用户授权后再启动。" });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT status, blockers_json, next_step FROM session_digests").get() as any;
    expect(digest.status).toBe("blocked");
    expect(JSON.parse(digest.blockers_json).join(" ")).toContain("权限");
    expect(digest.next_step).toContain("权限");
    db.close();
  });

  test("ignores injected assistant noise after a useful conclusion", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查接口数据质量" });
    add("tool_call", { toolName: "exec_command", toolCallId: "check-1", command: "sqlite3 data.db 'select count(*) from rows'" });
    add("tool_result", { toolCallId: "check-1", content: "100" });
    add("assistant_message", { role: "assistant", content: "结论：接口数据检查完成，未发现重复或缺失。" });
    add("assistant_message", { role: "assistant", content: "API Error: 400 Your input exceeds the context window of this model." });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT progress_summary, status FROM session_digests").get() as any;
    expect(digest.progress_summary).toContain("未发现重复或缺失");
    expect(digest.progress_summary).not.toContain("API Error");
    expect(digest.status).toBe("verified");
    db.close();
  });

  test("does not use a one-word completion marker as the progress summary", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查压缩日志" });
    add("assistant_message", { role: "assistant", content: "done" });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT progress_summary,status FROM session_digests").get() as { progress_summary: string; status: string };
    expect(digest.progress_summary).not.toBe("done");
    expect(digest.status).toBe("verified");
    db.close();
  });

  test("ignores assistant transport wrappers and no-response markers", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查依赖编译权限" });
    add("assistant_message", { role: "assistant", content: "[external_agent_tool_result]\npermission probe\n[/external_agent_tool_result]" });
    add("assistant_message", { role: "assistant", content: "No response requested." });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT progress_summary,status FROM session_digests").get() as { progress_summary: string; status: string };
    expect(digest.progress_summary).not.toContain("external_agent");
    expect(digest.progress_summary).not.toContain("No response");
    expect(digest.status).toBe("planned");
    db.close();
  });

  test("does not treat a normal wait step as an external blocker", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "重启本地服务" });
    add("tool_call", { toolName: "exec_command", toolCallId: "stop-1", command: "kill 123" });
    add("tool_result", { toolCallId: "stop-1", content: "stopped" });
    add("assistant_message", { role: "assistant", content: "服务已停止，没有卡住，也不是硬阻塞。下一步等待两秒并确认进程退出，然后重新启动。" });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT status, blockers_json FROM session_digests").get() as any;
    expect(digest.status).not.toBe("blocked");
    expect(JSON.parse(digest.blockers_json)).toEqual([]);
    db.close();
  });

  test("marks an interrupted task as abandoned instead of open", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "重构扫描器" });
    add("task_started");
    add("tool_call", { toolName: "apply_patch", toolCallId: "edit-aborted", filePaths: ["src/scanner.ts"] });
    add("task_aborted", { content: "interrupted by user" });

    await rebuildSessionDigests(db);
    expect(db.db.query("SELECT status FROM session_digests").get()).toEqual({ status: "abandoned" });
    db.close();
  });

  test("keeps an open Codex turn in progress and uses the latest substantive request", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "当前项目里面有3个项目都是关于agent项目里的记忆的，你帮我分别解读一下" });
    add("assistant_message", { role: "assistant", content: "旧任务已完成并通过验证。", metadata: { phase: "final_answer" } });
    add("task_completed");
    add("user_message", { role: "user", content: "当前的解读都是对话标题，所以项目进度看起来不清晰" });
    add("user_message", { role: "user", content: "## My request: 开始" });
    add("task_started");
    add("tool_call", { toolName: "apply_patch", toolCallId: "edit-open", filePaths: ["src/session-digests.ts"] });
    add("tool_result", { toolCallId: "edit-open", content: "Done" });
    add("tool_call", { toolName: "exec", toolCallId: "nested-tools", command: 'const result = await tools.exec_command({cmd:"bun test"})' });
    add("tool_result", { toolCallId: "nested-tools", content: "Script completed" });
    add("assistant_message", { role: "assistant", content: "基础测试通过，接下来统计噪声和阻塞项，再继续真实历史验收。", metadata: { phase: "commentary" } });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT objective, headline, progress_summary, status, validations_json, blockers_json FROM session_digests").get() as any;
    expect(digest.objective).toContain("项目进度");
    expect(digest.headline).toBe("提升对话历史的项目进度解读");
    expect(digest.progress_summary).toContain("真实历史验收");
    expect(digest.status).toBe("partially_done");
    expect(JSON.parse(digest.validations_json)).toEqual([]);
    expect(JSON.parse(digest.blockers_json)).toEqual([]);
    db.close();
  });

  test("keeps pasted SQL as evidence instead of replacing the explicit goal", async () => {
    const { db, add } = fixture();
    const objectiveId = add("user_message", { role: "user", content: "给我clickhouse中的查询指令，来确保一年内的数据完整性" });
    add("assistant_message", { role: "assistant", content: "请执行下面的完整性查询。" });
    const outputId = add("user_message", {
      role: "user",
      content: "SELECT count(), min(date), max(date) FROM basedata.rows\nQuery id: query-1\n30 | 2026-06-11 | 2026-07-23\n1 row in set. Elapsed: 0.001 sec.",
    });
    add("assistant_message", { role: "assistant", content: "结论：数据完整性验证完成，共 30 行，日期范围为 2026-06-11 至 2026-07-23。" });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT objective,headline,progress_summary,status,next_step FROM session_digests").get() as any;
    expect(digest.objective).toContain("查询指令");
    expect(digest.headline).toBe("生成 ClickHouse 数据完整性查询指令");
    expect(digest.progress_summary).toContain("共 30 行");
    expect(digest.progress_summary).not.toContain(digest.headline);
    expect(digest.status).toBe("verified");
    expect(digest.next_step).toBe("");
    expect(db.db.query("SELECT event_id FROM session_digest_evidence WHERE digest_section='objective'").get()).toEqual({ event_id: objectiveId });
    expect(db.db.query("SELECT COUNT(*) AS count FROM session_digest_evidence WHERE event_id=? AND digest_section='objective'").get(outputId)).toEqual({ count: 0 });
    db.close();
  });

  test("starts a new work segment at the latest correction", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "修复旧扫描器" });
    add("tool_call", { toolName: "apply_patch", toolCallId: "old-edit", filePaths: ["src/old.ts"] });
    add("tool_result", { toolCallId: "old-edit", content: "Done" });
    add("tool_call", { toolName: "exec_command", toolCallId: "old-test", command: "bun test" });
    add("tool_result", { toolCallId: "old-test", content: "10 pass" });
    add("assistant_message", { role: "assistant", content: "旧扫描器已修复，测试通过。", metadata: { phase: "final_answer" } });
    add("task_completed");
    add("user_message", { role: "user", content: "z@server ➜ project git:(main)\npwd\n/home/z/project\nsh脚本在项目里，不在data1中" });
    add("assistant_message", { role: "assistant", content: "已改为使用项目内的 sh 脚本路径，定时任务指令已经修正。", metadata: { phase: "final_answer" } });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT objective,headline,status,completed_json,validations_json,progress_summary FROM session_digests").get() as any;
    expect(digest.objective).toBe("sh脚本在项目里，不在data1中");
    expect(digest.headline).toBe("修正定时任务脚本路径");
    expect(digest.status).toBe("verified");
    expect(JSON.parse(digest.completed_json).join(" ")).not.toContain("src/old.ts");
    expect(JSON.parse(digest.validations_json)).toEqual([]);
    expect(digest.progress_summary).toContain("定时任务指令已经修正");
    db.close();
  });

  test("marks a closed read-only answer as verified", async () => {
    const { db, add } = fixture();
    add("task_started");
    add("user_message", { role: "user", content: "解释这个top的输出呢：\nPID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND" });
    add("assistant_message", {
      role: "assistant",
      content: "这是 Linux top 的进程列表；RES 是实际物理内存，VIRT 不等于真实内存占用。",
      metadata: { phase: "final_answer" },
    });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT headline,status,progress_summary,next_step FROM session_digests").get() as any;
    expect(digest.headline).toBe("解读这个top的输出");
    expect(digest.status).toBe("verified");
    expect(digest.progress_summary).toContain("RES 是实际物理内存");
    expect(digest.next_step).toBe("");
    db.close();
  });

  test("uses task completion to close legacy read-only sessions without message phases", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "同花顺的数据接口当前项目的路由和数据源是啥" });
    add("tool_call", { toolName: "exec_command", toolCallId: "inspect-routes", command: "rg -n 'ths-' src" });
    add("tool_result", { toolCallId: "inspect-routes", content: "src/routes.rs:10:/ths-board-list" });
    add("assistant_message", { role: "assistant", content: "当前项目共有 3 个同花顺接口，数据来自本地板块 CSV 和 Redis 缓存。" });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT headline,status,progress_summary FROM session_digests").get() as any;
    expect(digest.headline).toBe("梳理同花顺接口路由与数据源");
    expect(digest.status).toBe("verified");
    expect(digest.progress_summary).toContain("3 个同花顺接口");
    db.close();
  });

  test("prefers a later natural-language question over an older request and pasted output", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "解释这个top的输出呢：\nPID USER PR NI VIRT RES" });
    add("assistant_message", { role: "assistant", content: "这是 top 的进程列表。", metadata: { phase: "final_answer" } });
    add("task_completed");
    add("user_message", { role: "user", content: "我如何查看当前mysql数据的一些配置，和每个数据的数据大小" });
    add("assistant_message", { role: "assistant", content: "先执行 SHOW VARIABLES 和 information_schema.tables 查询。", metadata: { phase: "final_answer" } });
    add("task_completed");
    add("user_message", { role: "user", content: "SELECT table_schema, SUM(data_length) FROM information_schema.tables\nQuery id: query-2\nwind | 193600" });
    add("assistant_message", { role: "assistant", content: "结论：wind 库约 193.6 GB，Buffer Pool 需要结合主机内存继续评估。", metadata: { phase: "final_answer" } });
    add("task_completed");

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT objective,headline,progress_summary,status FROM session_digests").get() as any;
    expect(digest.objective).toContain("mysql");
    expect(digest.headline).toBe("查看 MySQL 配置与数据库大小");
    expect(digest.progress_summary).toContain("193.6 GB");
    expect(digest.status).toBe("verified");
    db.close();
  });

  test("does not create a work item from greeting and continuation fragments", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "你好" });
    add("assistant_message", { role: "assistant", content: "你好，有什么可以帮你？" });
    add("user_message", { role: "user", content: "继续呢" });
    add("assistant_message", { role: "assistant", content: "请补充需要继续的具体工作。" });

    expect(await rebuildSessionDigests(db)).toEqual({ rebuilt: 0, skipped: 0, enhanced: 0, fallback: 0, deferred: 0 });
    expect(db.db.query("SELECT COUNT(*) AS count FROM session_digests").get()).toEqual({ count: 0 });
    db.close();
  });

  test("keeps a prior goal when a correction only introduces pasted data", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "你解释一下这个风控配置呢" });
    add("assistant_message", { role: "assistant", content: "请贴出需要解读的配置。" });
    add("user_message", { role: "user", content: "不是这个{\n  \"trade_date\": \"2026-07-20\",\n  \"remain_limit\": 20000\n}" });
    add("assistant_message", { role: "assistant", content: "结论：这份配置描述 2026-07-20 的风控剩余额度，remain_limit 为 20000。" });

    await rebuildSessionDigests(db);
    const digest = db.db.query("SELECT objective,headline,progress_summary FROM session_digests").get() as any;
    expect(digest.objective).toContain("风控配置");
    expect(digest.objective).not.toBe("不是这个{");
    expect(digest.progress_summary).toContain("remain_limit 为 20000");
    db.close();
  });

  test("enhances a digest with cited model output and caches it", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "梳理扫描器当前进度" });
    const evidenceId = add("assistant_message", { role: "assistant", content: "扫描器已完成增量读取，尚未运行全量回归。" });
    let calls = 0;
    const provider: WorklogModelProvider = {
      name: "fake:model",
      cacheKey: "fake-cache-v1",
      async digestSession(): Promise<SessionDigestResult> {
        calls += 1;
        return {
          headline: "完善历史扫描器",
          progressSummary: "增量读取已经完成，仍需运行全量回归。",
          completed: ["完成增量读取"], validations: [], blockers: [], remaining: ["运行全量回归"],
          status: "done_unverified", nextStep: "运行全量历史回归并检查重复数据。", evidenceIds: [evidenceId],
        };
      },
    };

    expect(await rebuildSessionDigests(db, { provider, maxModelSessions: 1 })).toEqual({
      rebuilt: 1, skipped: 0, enhanced: 1, fallback: 0, deferred: 0,
    });
    const digest = db.db.query("SELECT headline,progress_summary,status,provider FROM session_digests").get() as any;
    expect(digest).toEqual({
      headline: "完善历史扫描器", progress_summary: "增量读取已经完成，仍需运行全量回归。",
      status: "done_unverified", provider: "fake:model",
    });
    expect(db.db.query("SELECT COUNT(*) AS count FROM session_digest_evidence WHERE event_id=? AND digest_section='progress'").get(evidenceId)).toEqual({ count: 1 });
    expect(db.db.query("SELECT status,provider,attempts FROM agent_runs").get()).toEqual({ status: "completed", provider: "fake:model", attempts: 1 });
    expect(db.db.query("SELECT COUNT(*) AS count FROM agent_run_steps").get()).toEqual({ count: 7 });
    expect(await rebuildSessionDigests(db, { provider, maxModelSessions: 1 })).toEqual({
      rebuilt: 0, skipped: 1, enhanced: 0, fallback: 0, deferred: 0,
    });
    expect(calls).toBe(1);
    db.close();
  });

  test("persists Agent semantic facts ahead of deterministic fallback facts", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "分析接口返回异常的根因" });
    const evidenceId = add("assistant_message", { role: "assistant", content: "根因是上游字段为空导致解析分支报错。" });
    const provider: WorklogModelProvider = {
      name: "fake:facts", cacheKey: "fake-facts-v1",
      async digestSession(): Promise<SessionDigestResult> {
        return {
          headline: "定位接口异常根因", progressSummary: "已定位为空字段触发解析分支，仍需修复调用方。",
          completed: ["定位为空字段根因"], validations: [], blockers: [], remaining: ["修复调用方"],
          status: "done_unverified", nextStep: "修复调用方的空字段处理。", evidenceIds: [evidenceId],
          facts: [
            { kind: "finding", text: "上游空字段触发了解析分支异常", eventId: evidenceId },
            { kind: "next_step", text: "修复调用方的空字段处理", eventId: evidenceId },
          ],
        };
      },
    };
    await rebuildSessionDigests(db, { provider });
    const facts = db.db.query("SELECT fact_kind,text,event_id FROM session_facts ORDER BY rank").all() as Array<any>;
    expect(facts[0]).toEqual({ fact_kind: "finding", text: "上游空字段触发了解析分支异常", event_id: evidenceId });
    expect(facts.some((fact) => fact.fact_kind === "next_step" && fact.text.includes("空字段处理"))).toBeTrue();
    db.close();
  });

  test("allows the Agent to verify rule-derived progress with successful evidence", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "修复扫描器并运行测试" });
    add("tool_call", { toolName: "exec_command", toolCallId: "verify-test", command: "bun test" });
    const resultId = add("tool_result", { toolCallId: "verify-test", content: "12 pass" });
    let received: SessionDigestResult | undefined;
    const provider: WorklogModelProvider = {
      name: "fake:verifier", cacheKey: "fake-verifier-v1",
      async digestSession(input): Promise<SessionDigestResult> {
        received = {
          headline: "扫描器修复已验证", progressSummary: "修复已完成，测试全部通过。",
          completed: ["修复扫描器"], validations: ["bun test：12 pass"], blockers: [], remaining: [],
          status: "verified", nextStep: "", evidenceIds: [resultId],
        };
        expect(input.events.some((event) => event.id === resultId)).toBeTrue();
        return received;
      },
    };

    await rebuildSessionDigests(db, { provider });
    const digest = db.db.query("SELECT status, validations_json FROM session_digests").get() as any;
    expect(digest.status).toBe("verified");
    expect(JSON.parse(digest.validations_json)).toContain("bun test：12 pass");
    db.close();
  });

  test("does not verify from a generic assistant sentence without completion evidence", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查扫描器" });
    const proseId = add("assistant_message", { role: "assistant", content: "正在检查扫描器，请稍候。" });
    const provider: WorklogModelProvider = {
      name: "fake:overconfident", cacheKey: "fake-overconfident-v1",
      async digestSession(): Promise<SessionDigestResult> {
        return {
          headline: "扫描器已完成", progressSummary: "检查完成。", completed: [], validations: [], blockers: [],
          remaining: [], status: "verified", nextStep: "", evidenceIds: [proseId],
        };
      },
    };

    await rebuildSessionDigests(db, { provider });
    expect((db.db.query("SELECT status FROM session_digests").get() as any).status).not.toBe("verified");
    db.close();
  });

  test("falls back deterministically and caches a provider failure", async () => {
    const { db, add } = fixture();
    add("user_message", { role: "user", content: "检查扫描器" });
    add("assistant_message", { role: "assistant", content: "正在检查扫描器。" });
    let calls = 0;
    const provider: WorklogModelProvider = {
      name: "fake:failing", cacheKey: "fake-failing-v1",
      async digestSession(): Promise<SessionDigestResult> { calls += 1; throw new Error("offline"); },
    };

    expect(await rebuildSessionDigests(db, { provider })).toEqual({
      rebuilt: 1, skipped: 0, enhanced: 0, fallback: 1, deferred: 0,
    });
    expect((db.db.query("SELECT provider FROM session_digests").get() as any).provider).toBe("fallback:fake-failing-v1");
    expect(db.db.query("SELECT status,provider FROM agent_runs").get()).toEqual({ status: "failed", provider: "fake:failing" });
    expect(await rebuildSessionDigests(db, { provider })).toEqual({
      rebuilt: 0, skipped: 1, enhanced: 0, fallback: 0, deferred: 0,
    });
    expect(calls).toBe(1);
    db.close();
  });

  test("defers model work beyond the per-scan limit and continues next scan", async () => {
    const { db, add, root } = fixture();
    add("user_message", { role: "user", content: "处理第一个会话" });
    add("assistant_message", { role: "assistant", content: "第一个会话正在处理。" });
    const secondId = "session-digest-second";
    db.upsertSession({ source: "codex", externalId: secondId, cwd: root, isSubagent: false, sourceFile: join(root, "second.jsonl") });
    db.upsertEvent({
      id: "second-user", source: "codex", sessionExternalId: secondId, type: "user_message", role: "user",
      content: "处理第二个会话", timestamp: "2026-08-12T01:00:00Z", sourceFile: join(root, "second.jsonl"),
      sourceLine: 1, rawHash: "second-user-hash",
    });
    db.upsertEvent({
      id: "second-progress", source: "codex", sessionExternalId: secondId, type: "assistant_message", role: "assistant",
      content: "第二个会话正在处理。", timestamp: "2026-08-12T01:01:00Z", sourceFile: join(root, "second.jsonl"),
      sourceLine: 2, rawHash: "second-progress-hash",
    });
    let calls = 0;
    const provider: WorklogModelProvider = {
      name: "fake:limited", cacheKey: "fake-limited-v1",
      async digestSession(input): Promise<SessionDigestResult> {
        calls += 1;
        return {
          headline: "持续处理会话进度", progressSummary: "会话正在处理，尚未形成最终结论。",
          completed: [], validations: [], blockers: [], remaining: ["继续处理"], status: "in_progress",
          nextStep: "继续处理并形成可验证结果。", evidenceIds: [input.events.at(-1)!.id],
        };
      },
    };

    expect(await rebuildSessionDigests(db, { provider, maxModelSessions: 1 })).toEqual({
      rebuilt: 2, skipped: 0, enhanced: 1, fallback: 0, deferred: 1,
    });
    expect(await rebuildSessionDigests(db, { provider, maxModelSessions: 1 })).toEqual({
      rebuilt: 1, skipped: 1, enhanced: 1, fallback: 0, deferred: 0,
    });
    expect(calls).toBe(2);
    db.close();
  });
});
