import type { WorklogDatabase } from "./db";
import type { SessionDigestInput, SessionDigestResult, WorklogModelProvider } from "./llm/provider";
import { WorklogAgent } from "./agent/worklog-agent";
import { persistAgentFailure, persistAgentTrace } from "./agent/trace-store";
import type { SessionDigest, SessionFact, SessionFactKind, WorkStatus } from "./types";
import { normalizeWhitespace, safeJson, sha256 } from "./utils";

const DIGEST_VERSION = "deterministic-v20";
const WRITE_TOOL = /^(?:Edit|Write|MultiEdit|apply_patch)$/i;
const VALIDATION_COMMAND = /(?:^|\s)(?:cargo\s+(?:test|check|clippy|build)|bun\s+(?:test|run\s+(?:build|typecheck))|npm\s+(?:test|run\s+(?:build|test|typecheck))|pnpm\s+(?:test|run\s+(?:build|test|typecheck))|yarn\s+(?:test|build|typecheck)|pytest|python\s+-m\s+pytest|go\s+test|mvn\s+test|gradle\s+test|tsc\s+--noEmit|vue-tsc|vite\s+build)(?:\s|$)/i;
const COMPLETE_PATTERN = /(?:已完成|已经完成|完成了|已实现|已经实现|已修复|已经修复|已通过|测试.*通过|构建.*成功|验证.*通过|结论[:：]|结论如下|已检查|已梳理|查清楚|已确认|确认如下|整理完毕|分析完成|审查完成|核对完成|^(?:done|completed|fixed|implemented)\b)/i;
// Read-only investigations often end with a concrete verdict instead of the
// words “已完成”. These phrases close the work item when no pending action is
// stated, avoiding a large pile of stale in_progress items.
const RESULT_COMPLETION_PATTERN = /(?:全部完整|无缺口|符合预期|正常范围|未发现(?:问题|异常|缺失|错误)|没有(?:问题|缺失|异常|错误)|无需(?:额外|继续|再)(?:处理|配置|修改|检查|验证)?|不需要(?:额外|继续|再)(?:处理|配置|修改|检查|验证)?)/i;
const BLOCKER_PATTERN = /(?:缺少|缺乏|无法继续|不能继续|等待.{0,12}(?:用户|外部).{0,12}(?:授权|确认|输入)|需要用户.{0,20}(?:授权|确认|提供)|permission denied|access denied|\bblocked\b|(?:当前|仍然|仍|已经|已|处于|受到|受).{0,12}(?:阻塞|卡住)|(?:阻塞|卡住)(?:了|中|因为|原因|[:：]))/i;
const BLOCKER_NEGATION = /(?:无阻塞|没有阻塞|未受阻|不再阻塞|没有卡住|没卡住|未卡住|不是.{0,6}阻塞|并非.{0,6}阻塞|无需用户|无需等待)/i;
const REMAINING_PATTERN = /(?:尚未|还未|仍需|有待|待验证|待确认|未完成|下一步|接下来|剩余)/i;
const EXPLICIT_NEXT_PATTERN = /(?:下一步|接下来|后续(?:需要|应|要)|仍需|还需|待验证|待确认|需要用户.{0,20}(?:授权|确认|提供)|请(?:先|提供|确认|授权))/i;
const NEXT_NEGATION = /(?:没有|无|不得|不再|不需要|无需|不是).{0,10}(?:下一步|接下来|后续)/i;
const TOOL_ORCHESTRATION_COMMAND = /(?:await\s+tools\.|tools\.(?:exec_command|apply_patch)|const\s+\w+\s*=\s*await\s+tools\.)/;
const REQUEST_ACTION = /(?:^|[，,。；;\s])(?:请(?:你)?|麻烦你|能否|可以|你(?:直接)?)?\s*(?:帮我|你帮我|给我)?\s*(?:解释|解读|分析|检查|核查|排查|查|看看|查看|查询|修复|实现|新增|添加|修改|调整|合并|完善|提升|重构|优化|梳理|研究|迁移|导入|部署|启动|重启|停止|处理|生成|更新|补充|测试|同步|保存|设计|介绍|总结|审查|审核|定位|追踪|读取|扫描|统计|对比|规划|告诉)/i;
const REQUEST_QUESTION = /(?:为什么|为啥|怎么|如何|是否|是不是|有没有|会不会|能不能|可不可以|行不行|是什么|什么原因|怎么办)|(?:哪里|哪儿|哪个|哪些|多少|啥|吗|么|呢)[？?！!。；;\s]*$/i;
const REQUEST_NEED = /(?:我|我们|现在|当前).{0,12}(?:需要|想要|想|打算|准备|希望)/i;
const REQUEST_DELIVERABLE = /(?:^|[，,。；;\s])(?:那你|你)?\s*(?:直接)?\s*给我(?=.{4,})/i;
const REQUEST_CORRECTION = /(?:(?:^|[，,。；;\s])(?:不对|不是|并非|不要|不用|无需|不在|应该|应当|实际|改成|换成|只要|直接|漏了|缺少|缺失)|(?:看起来|显得|当前|结果).{0,10}(?:不清晰|不准确|有问题|很奇怪|缺失)|(?:脚本|文件).{0,12}(?:在项目|项目里))/i;
const HARD_USER_NOISE = /^(?:\[Request interrupted by user\]|Continue from where you left off|Updating git repository|This session is being continued|Your previous response had no visible output|Base directory for this skill|Another language model started to solve this problem)/i;
const OUTPUT_LINE = /^(?:```|~~~|Query id:|[┌└├│┬┴┼─]+|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b|(?:WARNING|INFO|ERROR|DEBUG|TRACE|Finished|Successfully installed|Process exited|Elapsed:|PID\s+USER\b)|(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SHOW|DESCRIBE|EXPLAIN)\b|\[[a-z0-9_.-]+\]\s+\w+\s*=|[A-Za-z_][\w.-]*\s*=\s*["'\d[{])/i;
const CHANGE_FACT_PATTERN = /(?:已|已经)(?:完成|实现|修复|修改|新增|添加|调整|更新|重构|移除|删除|生成|写入|部署|改为|切换)|(?:修改|实现|修复|调整|重构|迁移|部署).{0,24}(?:完成|落地|成功)/i;
const VALIDATION_FACT_PATTERN = /(?:(?:测试|构建|编译|类型检查|校验|验证|检查|clippy|pytest|cargo|bun test).{0,30}(?:通过|成功|完成|无误|\bpass(?:ed)?\b)|(?:\b\d+\s+pass\b|零\s*NULL|未发现(?:重复|缺失|错误)))/i;
const RISK_FACT_PATTERN = /(?:(?:当前|仍|存在|可能|发现|出现|有).{0,20}(?:风险|问题|阻塞|卡住|失败|报错|超时)|(?:尚未|还未|仍需|缺少|缺乏|无法继续|不能继续|未验证|待验证|需要用户))/i;
const RISK_FACT_NEGATION = /(?:没有|无|不会|未发现|无需|不是|并非|已解决|已修复|不再).{0,16}(?:风险|问题|阻塞|卡住|失败|报错|超时|污染)/i;
const FINDING_FACT_PATTERN = /^(?:结论|结果|审核结果|检查结果|测试结果|验证结果|初步发现|最终发现|发现|确认|查清楚|当前|实际|原因|根因|这是|这说明|说明|对[，,]|是的|不是|不会|会|可以)|(?:共|约|只有|包含|来自|使用|读取|写入|等于|说明|意味着).{0,80}(?:个|条|项|行|文件|接口|数据|配置|状态|原因|结果)/i;
const RESOLUTION_FACT_PATTERN = /(?:(?:全流程|本轮|本次|任务).{0,16}(?:已)?完成|(?:沿用|继续使用|复用).{0,48}(?:不需要|无需).{0,20}(?:配置|新增|修改)|自动覆盖|(?:数据|结果|状态).{0,24}(?:正常|异常|一致)|(?:不需要|无需).{0,20}(?:重爬|修改|处理|配置))/i;
const CONCRETE_RESULT_LEAD = /^(?:结论|结果|审核结果|检查结果|测试结果|验证结果|初步发现|最终发现|当前).*(?:\d|共|均|没有|无需|不需要|支持|完成|通过|失败|异常|接口|文档|数据|配置)/i;
const OPERATIONAL_COMMAND = /^(?:(?:[$#>]|sudo)\s*)?(?:sleep|pgrep|pkill|kill|killall|crontab|systemctl|service|launchctl|ps|free|df|du|lsof|ss|netstat|tail|head|grep|rg|find|chmod|chown|cp|mv|rm|mkdir|make|docker(?:-compose)?|kubectl|helm|ssh|scp|rsync|env|export|source|nohup|curl|wget|git|gh|cargo|bun|npm|pnpm|yarn|python\d*|pip\d*|go|mvn|gradle|java|node|deno|cd|ls|cat|sed|awk|SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SHOW|DESCRIBE|EXPLAIN)\b/i;
const CRON_ENTRY = /^(?:@(?:reboot|hourly|daily|weekly|monthly|yearly)|(?:\*|\d+(?:[-/,]\d+)*)\s+(?:\*|\d+(?:[-/,]\d+)*)\s+(?:\*|\d+(?:[-/,]\d+)*)\s+(?:\*|\d+(?:[-/,]\d+)*)\s+(?:\*|\d+(?:[-/,]\d+)*))\s+/i;

interface EventRow {
  id: string;
  event_type: string;
  timestamp: string | null;
  source_line: number;
  tool_name: string | null;
  tool_call_id: string | null;
  content: string | null;
  command: string | null;
  file_paths_json: string;
  is_error: number;
  raw_hash: string;
  metadata_json: string;
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[。！？!?])\s+|\n+/)
    .map((item) => normalizeWhitespace(item.replace(/^[-*#>\d.、\s]+/, "")))
    .filter((item) => item.length >= 4 && item.length <= 240);
}

function meaningfulAssistant(value: string | null): boolean {
  if (!value) return false;
  const text = value.trim();
  if (!text || /^\{\s*"(?:outcome|risk_level)"/.test(text)) return false;
  if (/^(?:API Error:|No response requested\.?$|\[external_agent_(?:tool_call|tool_result)\b|META-COGNITION ROUTING SYSTEM:|Do not use for |<invoke\b|<tool_use\b|🦀\s*Rust Skills Loaded|The following is the |You have \d+ weighted tokens|[A-Z]\)\s+.*\[Pick\])/i.test(text)) return false;
  if (/^(?:你好|您好)[！!，,]?.{0,48}(?:需要我|有什么|怎么帮)/.test(text)) return false;
  const genericOpening = /^(?:收到|好的|我来|开始处理|我先|正在)/;
  if (!genericOpening.test(text) || text.length > 50) return true;
  return COMPLETE_PATTERN.test(text) || /(?:自动覆盖|不需要|无需|已由|已经由|结论|结果)/.test(text);
}

function metadata(event: EventRow): Record<string, unknown> {
  try { return JSON.parse(event.metadata_json) as Record<string, unknown>; } catch { return {}; }
}

function messagePhase(event: EventRow): string | undefined {
  const phase = metadata(event).phase;
  return typeof phase === "string" ? phase : undefined;
}

function openTurn(events: EventRow[]): boolean {
  const userMessages = events.filter((event) => event.event_type === "user_message");
  const lastUserLine = userMessages.at(-1)?.source_line ?? 0;
  const assistantMessages = events.filter((event) => event.event_type === "assistant_message" && meaningfulAssistant(event.content));
  const currentTurnAssistants = assistantMessages.filter((event) => event.source_line > lastUserLine);
  const hasMessagePhases = assistantMessages.some((event) => messagePhase(event));
  const hasFinalAnswer = currentTurnAssistants.some((event) => !hasMessagePhases || messagePhase(event) === "final_answer");
  const lastTaskStarted = events.filter((event) => event.event_type === "task_started").at(-1)?.source_line ?? 0;
  const lastTaskCompleted = events.filter((event) => event.event_type === "task_completed").at(-1)?.source_line ?? 0;
  return lastTaskStarted > lastTaskCompleted || (hasMessagePhases && currentTurnAssistants.length > 0 && !hasFinalAnswer);
}

function normalizedUserRequest(value: string): string {
  return normalizeWhitespace(value
    .replace(/<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>/gi, " ")
    .replace(/<environment_context\b[\s\S]*?<\/environment_context>/gi, " "))
    .replace(/^##\s*My request:\s*/i, "")
    .replace(/^My request:\s*/i, "")
    .replace(/^\/goal\s+/i, "");
}

function hasRequestIntent(value: string): boolean {
  return REQUEST_ACTION.test(value) || REQUEST_QUESTION.test(value) || REQUEST_NEED.test(value)
    || REQUEST_DELIVERABLE.test(value) || REQUEST_CORRECTION.test(value);
}

function intentUserRequest(value: string): string {
  const withoutInjectedContext = value
    .replace(/<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>/gi, "\n")
    .replace(/<environment_context\b[\s\S]*?<\/environment_context>/gi, "\n")
    .replace(/^\s*##\s*My request:\s*/im, "")
    .replace(/^\s*My request:\s*/im, "")
    .replace(/^\s*\/goal\s+/im, "");
  const lines = withoutInjectedContext.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const intentLines = lines.filter((line) => {
    if (HARD_USER_NOISE.test(line)) return false;
    if (hasRequestIntent(line)) return true;
    if (OUTPUT_LINE.test(line) || /^\S+@\S+.*(?:➜|[$#])/.test(line) || /^\/(?:Users|home|data\d*)\//.test(line)) return false;
    return false;
  });
  if (intentLines.length > 0) {
    const conciseLines = intentLines.slice(-2).map((line) => line.replace(/^(.{4,120}?[：:])\s*(?=(?:PID\s+USER|SELECT\b|WITH\b|WARNING\b|INFO\b|ERROR\b|\[[a-z0-9_.-]+\]\s+\w+\s*=))([\s\S]*)$/i, "$1"));
    return normalizeWhitespace(conciseLines.join(" "));
  }
  return normalizedUserRequest(withoutInjectedContext);
}

function userRequestScore(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const normalized = normalizedUserRequest(value);
  if (!normalized || HARD_USER_NOISE.test(normalized)) return Number.NEGATIVE_INFINITY;
  if (/^(?:开始|继续|好的|好|可以|行|确认|没问题|先按|先按照|按你|就这样|弄吧|弄好|更新|不是这个|不对|kaihsi\d*)[呢吧。！!{\s]*$/i.test(normalized)) return 1;
  const intent = intentUserRequest(value);
  if (/^(?:不是这个|不对)[{：:]?$/.test(intent)) return 1;
  let score = 0;
  if (REQUEST_ACTION.test(intent)) score += 6;
  if (REQUEST_QUESTION.test(intent)) score += 5;
  if (REQUEST_NEED.test(intent)) score += 5;
  if (REQUEST_DELIVERABLE.test(intent)) score += 5;
  if (REQUEST_CORRECTION.test(intent)) score += 5;
  if (/^(?:请|麻烦|帮我|你帮我|给我)/.test(intent)) score += 2;
  if (/[？?]/.test(intent)) score += 1;
  if (intent.length >= 8 && intent.length <= 320 && /[\u3400-\u9fff]/.test(intent)) score += 1;
  const outputLike = OUTPUT_LINE.test(normalized)
    || /(?:Query id:|\d+ rows? in set|Elapsed:|Process exited with code|PID\s+USER\s+PR\s+NI)/i.test(normalized);
  if (outputLike && !hasRequestIntent(intent)) score -= 8;
  if (normalized.length > 1_500 && intent === normalized) score -= 5;
  return score;
}

function objectiveEventFrom(userMessages: EventRow[]): EventRow | null {
  for (const event of userMessages.slice().reverse()) {
    if (userRequestScore(event.content) >= 4) return event;
  }
  const fallback = userMessages.slice().sort((a, b) => userRequestScore(b.content) - userRequestScore(a.content))[0];
  return fallback && userRequestScore(fallback.content) >= 2 ? fallback : null;
}

function currentWorkSegment(events: EventRow[], objectiveEvent: EventRow): EventRow[] {
  const index = events.findIndex((event) => event.id === objectiveEvent.id);
  return index < 0 ? events : events.slice(index);
}

export interface SessionSegmentRange {
  ordinal: number;
  startLine: number;
  endLine: number;
  objectiveEventId: string;
}

function segmentBoundaryCandidate(event: EventRow): boolean {
  const content = event.content?.trim() ?? "";
  if (!content || userRequestScore(content) < 4) return false;
  const normalized = normalizedUserRequest(content);
  // Pasted JSON/SQL supplied as a correction belongs to the previous objective.
  if (/^(?:不是这个|不对)\s*[\[{]/i.test(normalized)) return false;
  if (OUTPUT_LINE.test(normalized) && !REQUEST_ACTION.test(normalized) && !REQUEST_QUESTION.test(normalized)) return false;
  return true;
}

export function detectSessionSegmentRanges(events: Array<Pick<EventRow, "id" | "event_type" | "content" | "source_line">>): SessionSegmentRange[] {
  const userMessages = events.filter((event): event is Pick<EventRow, "id" | "event_type" | "content" | "source_line"> & { content: string } =>
    event.event_type === "user_message" && Boolean(event.content?.trim()) && segmentBoundaryCandidate(event as EventRow));
  if (userMessages.length === 0) {
    const startLine = events[0]?.source_line ?? 1;
    const endLine = events.at(-1)?.source_line ?? startLine;
    return events.length > 0 ? [{ ordinal: 0, startLine, endLine, objectiveEventId: events[0]!.id }] : [];
  }
  return userMessages.map((event, index) => ({
    ordinal: index,
    startLine: event.source_line,
    endLine: userMessages[index + 1]?.source_line ? userMessages[index + 1]!.source_line - 1 : (events.at(-1)?.source_line ?? event.source_line),
    objectiveEventId: event.id,
  }));
}

export function inferSegmentDigest(sessionId: string, inputHash: string, events: EventRow[]): SessionDigest | null {
  return inferDigest(sessionId, inputHash, events);
}

export function segmentHash(events: EventRow[], ordinal: number): string {
  return sha256(`${DIGEST_VERSION}:segment:${ordinal}\n${events.map((event) => `${event.id}:${event.raw_hash}:${event.content ?? ""}:${event.command ?? ""}`).join("\n")}`);
}

export function objectiveTitle(value: string): string {
  let title = normalizeWhitespace(value)
    .replace(/^\/goal\s+/i, "")
    .replace(/^(?:请(?:你)?|麻烦你|能否|可以)?\s*(?:帮我|你帮我)?\s*/i, "")
    .replace(/[？?！!。；;：:]+$/g, "")
    .replace(/(?:一下|一下呢|呢|吧)$/g, "")
    .replace(/问题$/g, "");
  title = title.replace(/\/(?:Users|home|data\d*)\/\S+/g, "").replace(/^(?:参考现在的逻辑|按照现在的逻辑)?\s*(?:我现在)?(?:需要|想要|想)?\s*/i, "");
  const crawlerMatch = title.match(/^这是\s*(.+?)的(?:一个|个)?爬取脚本/);
  if (crawlerMatch) title = `梳理${crawlerMatch[1]}爬取逻辑`;
  if (/loader-log-analysis/.test(title) && /(?:探索|不了解|看不懂|优化)/.test(title)) title = "梳理 loader-log-analysis 架构与优化路径";
  const memoryProjects = title.match(/当前项目里(?:面)?有\d+个项目都是关于(.+?)的(?:，|,|你)/);
  if (memoryProjects) title = `解读${memoryProjects[1]}相关项目`;
  if (/(?:对话标题.*项目进度|项目进度.*对话标题)/.test(title)) title = "提升对话历史的项目进度解读";
  if (/工作记录.{0,30}(?:对话历史|codex|claude)/i.test(title)) title = "实现 AI 对话工作记录工具";
  if (/审核skill\.md.*审核/i.test(title)) title = "使用审核 Skill 检查项目文档";
  if (/git blame.*sql-query.*谁写/i.test(title)) title = "追踪 sql-query 接口作者";
  if (/^(?:为什么|为啥)/.test(title)) title = `分析${title.replace(/^(?:为什么|为啥)\s*/, "")}的原因`;
  if (/^你(?:现在)?是(?:什么模型|谁)/.test(title)) title = /模型/.test(title) ? "确认当前模型信息" : "确认 Agent 身份";
  if (/盘后和逐笔.+哪(?:拿|来|取)/.test(title)) title = "追踪盘后与逐笔数据来源";
  if (/前复权日\s*k.+(?:吗|么)/i.test(title)) title = "核查项目中的前复权日K爬虫";
  if (/^给这个表添加接口/.test(title)) title = "为目标数据表添加接口";
  if (/(?:如何|怎么).{0,12}(?:查看|查询).{0,20}mysql.{0,30}(?:配置|大小)/i.test(title)) title = "查看 MySQL 配置与数据库大小";
  if (/最早的时间/.test(title)) title = "查询最早时间";
  if (/https?:\/\/\S+.*工具箱/i.test(title)) title = "查看指定工具箱";
  if (/^如何配置/.test(title)) title = "梳理配置方法";
  if (/同花顺.{0,30}(?:路由|接口).{0,30}数据源/.test(title)) title = "梳理同花顺接口路由与数据源";
  if (/(?:直接)?查(?:一下)?clickhouse/i.test(title)) title = "查询 ClickHouse 数据";
  if (/(?:给我|生成|提供).{0,20}clickhouse.{0,20}(?:指令|命令)/i.test(title) && !/完整/.test(title)) title = "生成 ClickHouse 查询指令";
  if (/给我.{0,16}脚本.{0,16}导入.{0,16}(?:12\s*[-~至]\s*13|12-13)号?/i.test(title)) title = "生成 12-13 日数据导入指令";
  if (/(?:今天没有信息|没有数据).{0,30}(?:报错|失败).{0,60}(?:重复|去重)/.test(title)) title = "核查定时抓取的空数据与重复问题";
  if (/(?:clickhouse|clichhouse).{0,60}(?:curl|连通|访问).{0,30}(?:指令|命令|测试)/i.test(title)) title = "生成 ClickHouse 连通性测试指令";
  if (/(?:给我|生成|提供).{0,30}(?:clickhouse).{0,50}(?:查询指令|查询命令)/i.test(title)) title = /完整/.test(title)
    ? "生成 ClickHouse 数据完整性查询指令" : "生成 ClickHouse 查询指令";
  if (/(?:sh脚本|脚本).{0,30}(?:不在|不再data|在项目|项目里|路径|目录)/i.test(title)) title = "修正定时任务脚本路径";
  if (/(?:更新|补充|追加).{0,30}(?:changelog|change log)/i.test(title)) title = "补充项目 CHANGELOG";
  if (/^你?(?:解释|说明)/.test(title)) title = `解读${title.replace(/^你?(?:解释|说明)\s*/, "")}`;
  const instructionMatch = title.match(/^(?:给我|提供|生成)\s*(.{0,36}?)(?:的)?(?:指令|命令)/);
  if (instructionMatch) {
    const topic = instructionMatch[1].trim();
    title = `生成${/^[A-Za-z0-9]/.test(topic) ? " " : ""}${topic}指令`;
  }
  if (/^当前.+(?:吗|么)$/.test(title)) title = `核查${title.replace(/^当前/, "").replace(/[吗么]$/, "")}`;
  if (/^(?:是否|是不是|有没有|会不会|能不能|可不可以)/.test(title)) {
    title = `核查${title.replace(/^(?:是否|是不是|有没有|会不会|能不能|可不可以)\s*/, "").replace(/[吗么]$/, "")}`;
  }
  if (!/^(?:修复|修正|实现|新增|添加|修改|调整|合并|补充|完善|提升|重构|优化|排查|检查|核查|梳理|分析|解读|解释|理解|研究|迁移|导入|部署|启动|重启|停止|处理|生成|更新|测试|同步|保存|查询|查看|介绍|回答|确认|追踪|设计|规划|总结|审查|审核|定位|读取|扫描|统计|对比)/.test(title)) {
    title = REQUEST_QUESTION.test(title) ? `核查${title.replace(/^(?:那|那么|假如|如果|当前|现在)\s*/, "")}` : `梳理${title}`;
  }
  const clause = title.split(/[：:；;]/)[0];
  if (clause.length >= 6 && clause.length < title.length && title.length > 60) title = clause;
  return title.slice(0, 72) || "梳理当前工作";
}

function commandLabel(command: string | null): string | null {
  if (!command) return null;
  return normalizeWhitespace(command).slice(0, 100);
}

function factText(value: string): string {
  return normalizeWhitespace(value
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*(.*?)\*\*[:：]?\s*/, "$1："))
    .replace(/^(?:好的|收到)[，,。.!！]\s*(?=.{8})/, "")
    .replace(/[：:]$/, "")
    .slice(0, 240);
}

function usefulFactSentence(value: string): boolean {
  const text = factText(value);
  if (/[：:]\s*$/.test(value.trim()) && !CONCRETE_RESULT_LEAD.test(text)) return false;
  if (text.length < 8 || text.length > 240) return false;
  if (/^(?:开始|收到|好的|我先|我会|我来|正在|请执行|在服务器执行|运行下面|命令如下|例如|比如|```|\|)/.test(text)) return false;
  if (/^(?:https?:\/\/|\/(?:Users|home|data\d*)\/|SELECT\b|WITH\b|curl\b|cargo\b|bun\b|npm\b)/i.test(text)) return false;
  return true;
}

function explicitNextSentence(value: string): boolean {
  return EXPLICIT_NEXT_PATTERN.test(value) && !NEXT_NEGATION.test(value);
}

function operationalCommand(value: string): boolean {
  const text = factText(value);
  return OPERATIONAL_COMMAND.test(text) || CRON_ENTRY.test(text) || /^[A-Za-z_][A-Za-z0-9_]*=\S+/.test(text);
}

function operationalStatement(value: string): boolean {
  const text = factText(value);
  const trailing = text.match(/[：:]\s*(.+)$/)?.[1];
  return operationalCommand(text) || Boolean(trailing && operationalCommand(trailing));
}

function structuredAssistantFindings(value: string): string[] {
  const findings: string[] = [];
  for (const match of value.matchAll(/(?:^|\n)\s*([^\n`]{6,100}[：:])\s*\n?```(?:\w+)?\s*\n?([^`\n]{2,160})/g)) {
    const label = factText(match[1] ?? "");
    const result = factText(match[2] ?? "");
    if (!label || !result || /(?:执行|命令|查询|示例|例如|输出格式)/.test(label)) continue;
    if (operationalCommand(result)) continue;
    findings.push(`${label}：${result}`);
  }
  const tableRows = value.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  for (const line of tableRows) {
    const cells = line.split("|").slice(1, -1).map((cell) => factText(cell)).filter(Boolean);
    if (cells.length < 2 || cells.every((cell) => /^[-:]+$/.test(cell))) continue;
    if (!cells.some((cell) => /\d|✅|❌|通过|失败|完成|正常|异常|NULL/i.test(cell))) continue;
    findings.push(cells.slice(0, 5).join("；"));
    if (findings.length >= 4) break;
  }
  return findings;
}

function extractSessionFacts(options: {
  assistantMessages: EventRow[];
  finalAssistant?: EventRow;
  progressAssistant?: EventRow;
  writes: EventRow[];
  successfulValidations: EventRow[];
  failedValidations: EventRow[];
  resultByCall: Map<string, EventRow>;
  hasCompletion: boolean;
}): SessionFact[] {
  const facts: SessionFact[] = [];
  const seen = new Set<string>();
  const add = (kind: SessionFactKind, text: string, eventId: string, confidence: number) => {
    const normalized = factText(text);
    if (!normalized || normalized.length < 4) return;
    const key = `${kind}:${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ kind, text: normalized, eventId, confidence });
  };

  const selectedAssistants = [options.finalAssistant, options.progressAssistant, ...options.assistantMessages.slice(-6).reverse()]
    .filter((event): event is EventRow => Boolean(event));
  const uniqueAssistants = [...new Map(selectedAssistants.map((event) => [event.id, event])).values()];
  for (const [eventIndex, event] of uniqueAssistants.entries()) {
    const confidence = eventIndex === 0 ? 0.9 : 0.82;
    for (const finding of structuredAssistantFindings(event.content ?? "")) add("finding", finding, event.id, confidence - 0.03);
    for (const sentence of sentences(event.content ?? "").filter(usefulFactSentence).slice(0, 12)) {
      const candidate = factText(sentence);
      const isNext = explicitNextSentence(candidate);
      const isRisk = RISK_FACT_PATTERN.test(candidate) && !BLOCKER_NEGATION.test(candidate) && !RISK_FACT_NEGATION.test(candidate);
      const isValidation = VALIDATION_FACT_PATTERN.test(candidate);
      const supportedValidation = isValidation && options.successfulValidations.length > 0;
      const isChange = CHANGE_FACT_PATTERN.test(candidate);
      const isResolution = RESOLUTION_FACT_PATTERN.test(candidate);
      if (isChange) add("change", candidate, event.id, confidence);
      if (supportedValidation) add("validation", candidate, event.id, confidence);
      if (isValidation && !supportedValidation && options.hasCompletion) add("finding", candidate, event.id, confidence - 0.12);
      if (isRisk) add("risk", candidate, event.id, confidence - 0.04);
      if (isNext) add("next_step", candidate, event.id, confidence);
      if (!operationalStatement(candidate) && ((!isChange && !supportedValidation && !isRisk && !isNext) || FINDING_FACT_PATTERN.test(candidate) || isResolution)) {
        if (FINDING_FACT_PATTERN.test(candidate) || isResolution) add("finding", candidate, event.id, confidence);
      }
    }
  }

  const successfulWrites = options.writes.filter((event) => {
    const result = options.resultByCall.get(event.tool_call_id ?? "");
    return result?.is_error === 0 || (!result && options.hasCompletion);
  });
  for (const event of successfulWrites.slice(-6).reverse()) {
    const files = (() => { try { return JSON.parse(event.file_paths_json) as string[]; } catch { return []; } })();
    if (files.length > 0) add("change", `已修改文件：${files.slice(0, 4).join("、")}`, event.id, 0.98);
  }
  for (const event of options.successfulValidations.slice(-6).reverse()) {
    const label = commandLabel(event.command);
    const result = options.resultByCall.get(event.tool_call_id ?? "");
    if (label) add("validation", `验证通过：${label}`, result?.id ?? event.id, 0.99);
  }
  if (options.failedValidations.length > 0 && options.successfulValidations.length === 0) {
    const failed = options.failedValidations.at(-1)!;
    const label = commandLabel(failed.command);
    const result = options.resultByCall.get(failed.tool_call_id ?? "");
    if (label) add("risk", `验证失败：${label}`, result?.id ?? failed.id, 0.98);
  }
  const rankedFindings = facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => fact.kind === "finding")
    .sort((a, b) => b.fact.confidence - a.fact.confidence || a.index - b.index)
    .map(({ fact }) => fact);
  let findingIndex = 0;
  return facts.map((fact) => fact.kind === "finding" ? rankedFindings[findingIndex++]! : fact).slice(0, 18);
}

function inferDigest(sessionId: string, inputHash: string, events: EventRow[]): SessionDigest | null {
  const userMessages = events.filter((event) => event.event_type === "user_message" && event.content?.trim());
  if (userMessages.length === 0) return null;
  const objectiveEvent = objectiveEventFrom(userMessages);
  if (!objectiveEvent) return null;
  const currentEvents = currentWorkSegment(events, objectiveEvent);
  const currentUserMessages = currentEvents.filter((event) => event.event_type === "user_message" && event.content?.trim());
  const objective = intentUserRequest(objectiveEvent.content!).slice(0, 500);
  const headline = objectiveTitle(objective);
  const assistantMessages = currentEvents.filter((event) => event.event_type === "assistant_message" && meaningfulAssistant(event.content));
  const lastUserLine = currentUserMessages.at(-1)?.source_line ?? objectiveEvent.source_line;
  const currentTurnAssistants = assistantMessages.filter((event) => event.source_line > lastUserLine);
  const hasMessagePhases = assistantMessages.some((event) => messagePhase(event));
  const finalCandidates = currentTurnAssistants.filter((event) => !hasMessagePhases || messagePhase(event) === "final_answer");
  const rankAssistant = (candidates: EventRow[]) => candidates.slice(-8).map((event, index) => {
    const content = event.content ?? "";
    let score = index / 10;
    if (COMPLETE_PATTERN.test(content)) score += 4;
    if (/(?:结论|已完成|已修复|已实现|通过|下一步|尚未|仍需)/.test(content)) score += 2;
    if (content.length >= 20 && content.length <= 1200) score += 1;
    if (/[^\x00-\x7F]/.test(content)) score += 0.5;
    return { event, score };
  }).sort((a, b) => b.score - a.score)[0]?.event;
  const finalAssistant = rankAssistant(finalCandidates);
  const progressAssistant = rankAssistant(currentTurnAssistants) ?? finalAssistant ?? rankAssistant(assistantMessages);
  const finalText = finalAssistant?.content ?? "";
  const progressText = progressAssistant?.content ?? finalText;
  const finalSentences = sentences(finalText);
  const progressSentences = sentences(progressText);
  const completionSentence = finalSentences.find((sentence) => COMPLETE_PATTERN.test(sentence) && !/^(?:已检查的文件|当前状态|结论如下)[:：]?$/.test(sentence));

  const results = currentEvents.filter((event) => event.event_type === "tool_result");
  const successfulResults = results.filter((event) => event.is_error === 0);
  const writes = currentEvents.filter((event) => event.event_type === "tool_call" && WRITE_TOOL.test(event.tool_name ?? ""));
  const validationCalls = currentEvents.filter((event) => event.event_type === "tool_call"
    && !TOOL_ORCHESTRATION_COMMAND.test(event.command ?? "")
    && VALIDATION_COMMAND.test(event.command ?? ""));
  const resultByCall = new Map(results.filter((event) => event.tool_call_id).map((event) => [event.tool_call_id!, event]));
  const successfulValidations = validationCalls.filter((call) => resultByCall.get(call.tool_call_id ?? "")?.is_error === 0);
  const failedValidations = validationCalls.filter((call) => resultByCall.get(call.tool_call_id ?? "")?.is_error === 1);
  const lastResult = results.at(-1);
  const lastWriteLine = writes.at(-1)?.source_line ?? 0;
  const lastValidationLine = successfulValidations.at(-1)?.source_line ?? 0;
  const blockerSentences = BLOCKER_NEGATION.test(progressText)
    ? []
    : progressSentences.filter((sentence) => BLOCKER_PATTERN.test(sentence)).slice(0, 3);
  const remaining = progressSentences.filter((sentence) => REMAINING_PATTERN.test(sentence)).slice(0, 3);
  const aborted = currentEvents.at(-1)?.event_type === "task_aborted";
  const isOpenTurn = openTurn(currentEvents);
  const finalAnswerDelivered = Boolean(finalAssistant
    && currentEvents.some((event) => event.event_type === "task_completed" && event.source_line >= finalAssistant.source_line));
  const currentTurnToolCalls = currentEvents.filter((event) => event.event_type === "tool_call" && event.source_line > lastUserLine);
  const readOnlyAnswerDelivered = Boolean(finalAssistant && !hasMessagePhases && currentTurnAssistants.length > 0
    && currentTurnToolCalls.length === 0);
  const hasConclusiveAnswer = /^(?:是的|不是|没错|对[，,]|你说得对|结论|查清楚|确认|已)/.test(finalText.trim()) && finalText.trim().length >= 16;
  const hasResolvedAnswer = RESOLUTION_FACT_PATTERN.test(factText(finalText));
  const hasCompletion = COMPLETE_PATTERN.test(finalText) || RESULT_COMPLETION_PATTERN.test(finalText)
    || hasConclusiveAnswer || hasResolvedAnswer || finalAnswerDelivered || readOnlyAnswerDelivered;
  // A tool-backed read-only turn with a substantive final answer and no
  // pending work is complete even when the source adapter did not emit an
  // explicit task_completed marker (common in older Claude/Codex logs).
  const implicitReadOnlyCompletion = Boolean(finalAssistant && writes.length === 0 && successfulResults.length > 0
    && remaining.length === 0 && blockerSentences.length === 0 && finalText.trim().length >= 20);
  const effectiveCompletion = hasCompletion || implicitReadOnlyCompletion;
  const latestScopeAfterValidation = lastUserLine > Math.max(lastWriteLine, lastValidationLine) && (finalAssistant?.source_line ?? 0) > lastUserLine && !effectiveCompletion;
  const finalConclusion = completionSentence && completionSentence.length >= 12
    ? completionSentence
    : (hasConclusiveAnswer ? finalSentences.find((sentence) => sentence.length >= 12) : undefined);
  const validationAfterLastWrite = successfulValidations.length > 0 && lastValidationLine >= lastWriteLine;
  const unresolvedFailure = lastResult?.is_error === 1 && !effectiveCompletion;
  let status: WorkStatus;
  let confidence: number;
  if (aborted) {
    status = "abandoned"; confidence = 0.88;
  } else if (isOpenTurn) {
    status = writes.length > 0 ? "partially_done" : "in_progress"; confidence = 0.9;
  } else if (blockerSentences.length > 0 && (unresolvedFailure || !hasCompletion)) {
    status = "blocked"; confidence = 0.88;
  } else if (latestScopeAfterValidation) {
    status = writes.length > 0 ? "partially_done" : "in_progress"; confidence = 0.76;
  } else if ((finalAnswerDelivered || readOnlyAnswerDelivered) && writes.length === 0) {
    status = "verified"; confidence = 0.9;
  } else if (validationAfterLastWrite && (writes.length > 0 || hasCompletion)) {
    status = "verified"; confidence = 0.92;
  } else if (writes.length === 0 && effectiveCompletion && successfulResults.length > 0) {
    status = "verified"; confidence = 0.84;
  } else if (writes.length > 0 && hasCompletion) {
    status = "done_unverified"; confidence = 0.84;
  } else if (writes.length > 0 && unresolvedFailure) {
    status = "partially_done"; confidence = 0.8;
  } else if (currentEvents.some((event) => event.event_type === "tool_call")) {
    status = "in_progress"; confidence = 0.74;
  } else if (hasCompletion) {
    status = "done_unverified"; confidence = 0.7;
  } else {
    status = "planned"; confidence = 0.66;
  }

  const extractedFacts = extractSessionFacts({
    assistantMessages: currentTurnAssistants,
    finalAssistant,
    progressAssistant: currentTurnAssistants.some((event) => event.id === progressAssistant?.id) ? progressAssistant : undefined,
    writes, successfulValidations, failedValidations,
    resultByCall, hasCompletion,
  });
  const facts = extractedFacts.filter((fact) => fact.kind !== "risk" || !["verified", "abandoned"].includes(status));
  const files = [...new Set(writes.flatMap((event) => {
    try { return JSON.parse(event.file_paths_json) as string[]; } catch { return []; }
  }))];
  const validationLabels = successfulValidations.map((event) => commandLabel(event.command)).filter((item): item is string => Boolean(item));
  const completed = facts.filter((fact) => fact.kind === "change").map((fact) => fact.text);
  const factValidations = facts.filter((fact) => fact.kind === "validation").map((fact) => fact.text);
  if (completed.length === 0 && finalConclusion && CHANGE_FACT_PATTERN.test(finalConclusion)) completed.push(finalConclusion);
  if (failedValidations.length > 0 && successfulValidations.length > 0) completed.push(`早期 ${failedValidations.length} 次验证失败，后续已重新验证通过`);

  const fallbackSummary = status === "verified" ? (files.length > 0 ? `已完成 ${files.length} 个文件的修改并通过验证。` : "已形成明确结论并完成本轮处理。")
    : status === "done_unverified" ? (files.length > 0 ? `已完成 ${files.length} 个文件的修改，尚缺少最终验证。` : "已完成主要处理，尚缺少最终验证。")
    : status === "blocked" ? "当前工作受已识别的外部条件阻塞。"
    : status === "partially_done" ? "已完成部分工作，当前仍有明确的未完成项。"
    : status === "in_progress" ? "当前任务正在处理，尚未形成最终结论。"
    : "当前任务仍处于讨论或规划阶段。";
  const currentProgress = progressSentences.find((sentence) => sentence.length >= 12 && !/^(?:开始|收到|好的|我先|我会)/.test(sentence));
  const factPriority: SessionFactKind[] = status === "blocked"
    ? ["risk", "finding", "next_step", "change", "validation"]
    : ["in_progress", "partially_done"].includes(status)
      ? ["finding", "next_step", "risk", "change", "validation"]
      : ["finding", "change", "validation", "risk", "next_step"];
  const primaryFact = factPriority.map((kind) => facts.find((fact) => fact.kind === kind)).find(Boolean);
  const progressSummary = (primaryFact?.text ?? finalConclusion ?? currentProgress ?? fallbackSummary).slice(0, 240);
  const explicitNext = progressSentences.find((sentence) => explicitNextSentence(sentence))
    ?? facts.find((fact) => fact.kind === "next_step")?.text;
  const nextStep = (explicitNext ?? "").slice(0, 240);
  const effectiveRemaining = ["verified", "abandoned"].includes(status) ? [] : remaining;

  const evidence: SessionDigest["evidence"] = [{ eventId: objectiveEvent.id, section: "objective" }];
  if (progressAssistant) evidence.push({ eventId: progressAssistant.id, section: "progress" });
  for (const event of writes.slice(-3)) evidence.push({ eventId: event.id, section: "completed" });
  for (const event of successfulValidations.slice(-3)) {
    evidence.push({ eventId: event.id, section: "validation" });
    const result = resultByCall.get(event.tool_call_id ?? "");
    if (result) evidence.push({ eventId: result.id, section: "validation" });
  }
  if (progressAssistant && blockerSentences.length > 0) evidence.push({ eventId: progressAssistant.id, section: "blocker" });
  if (progressAssistant && effectiveRemaining.length > 0) evidence.push({ eventId: progressAssistant.id, section: "remaining" });
  const factSection: Record<SessionFactKind, SessionDigest["evidence"][number]["section"]> = {
    finding: "finding", change: "completed", validation: "validation", risk: "risk", next_step: "next_step",
  };
  for (const fact of facts) evidence.push({ eventId: fact.eventId, section: factSection[fact.kind] });

  return {
    sessionId, inputHash, objective, headline, progressSummary, completed: [...new Set(completed)].slice(0, 6),
    validations: [...new Set([...factValidations, ...validationLabels])].slice(0, 6), blockers: blockerSentences, remaining: effectiveRemaining,
    facts,
    status, confidence, nextStep, lastEventAt: currentEvents.at(-1)?.timestamp ?? undefined,
    provider: DIGEST_VERSION, evidence: [...new Map(evidence.map((item) => [`${item.eventId}:${item.section}`, item])).values()],
  };
}

function eventText(event: EventRow): string {
  if (event.event_type === "tool_call") {
    const files = (() => { try { return JSON.parse(event.file_paths_json) as string[]; } catch { return []; } })();
    return [event.tool_name, event.command, files.length ? `files: ${files.join(", ")}` : ""].filter(Boolean).join(" · ");
  }
  return event.content ?? event.command ?? event.tool_name ?? event.event_type;
}

function modelInput(sessionId: string, projectName: string, baseline: SessionDigest, events: EventRow[]): SessionDigestInput {
  return {
    sessionId,
    projectName,
    objective: baseline.objective,
    baseline: {
      headline: baseline.headline,
      progressSummary: baseline.progressSummary,
      completed: baseline.completed,
      validations: baseline.validations,
      blockers: baseline.blockers,
      remaining: baseline.remaining,
      facts: baseline.facts.map((fact) => ({ kind: fact.kind, text: fact.text, eventId: fact.eventId })),
      status: baseline.status,
      nextStep: baseline.nextStep,
      openTurn: openTurn(events),
    },
    events: events.filter((event) => ["user_message", "assistant_message", "tool_call", "tool_result", "task_completed", "task_aborted"].includes(event.event_type))
      .map((event) => ({ id: event.id, kind: event.event_type, text: eventText(event), timestamp: event.timestamp ?? undefined, isError: event.is_error === 1 })),
  };
}

function supportedModelStatus(result: SessionDigestResult, baseline: SessionDigest, events: EventRow[]): WorkStatus {
  if (openTurn(events)) return ["in_progress", "partially_done"].includes(result.status) ? result.status : baseline.status;
  if (result.status === "verified" && baseline.status !== "verified" && !hasVerifiedEvidence(result, events)) return baseline.status;
  if (result.status === "abandoned" && baseline.status !== "abandoned") return baseline.status;
  if (result.status === "blocked") {
    const selected = new Set(result.evidenceIds);
    const supported = events.some((event) => selected.has(event.id)
      && BLOCKER_PATTERN.test(eventText(event)) && !BLOCKER_NEGATION.test(eventText(event)));
    if (!supported) return baseline.status;
  }
  const transitions: Record<WorkStatus, WorkStatus[]> = {
    planned: ["planned", "in_progress"],
    in_progress: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
    partially_done: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
    done_unverified: ["in_progress", "partially_done", "done_unverified", "verified", "blocked"],
    verified: ["verified", "done_unverified"],
    blocked: ["blocked", "in_progress", "partially_done", "verified"],
    abandoned: ["abandoned"],
  };
  return transitions[baseline.status].includes(result.status) ? result.status : baseline.status;
}

/**
 * A model is allowed to close a rule-derived item only when it cites a
 * completion-bearing event. This keeps the Agent authoritative for status
 * while preventing a generic prose response from upgrading stale work.
 */
function hasVerifiedEvidence(result: SessionDigestResult, events: EventRow[]): boolean {
  const selected = new Set(result.evidenceIds);
  return events.some((event) => {
    if (!selected.has(event.id)) return false;
    if (event.event_type === "task_completed") return true;
    if (event.event_type === "tool_result") {
      return event.is_error === 0 && !/(?:\b(?:error|failed|failure|timeout)\b|失败|错误|超时|报错)/i.test(eventText(event));
    }
    if (event.event_type === "assistant_message") {
      return COMPLETE_PATTERN.test(eventText(event))
        || RESULT_COMPLETION_PATTERN.test(eventText(event))
        || VALIDATION_FACT_PATTERN.test(eventText(event));
    }
    return false;
  });
}

function modelFacts(result: SessionDigestResult, baseline: SessionDigest): SessionFact[] {
  const facts: SessionFact[] = (result.facts ?? []).map((fact, index) => ({
    kind: fact.kind,
    text: fact.text,
    eventId: fact.eventId,
    // Model facts are semantic interpretations, but remain below the hard
    // evidence gate. Deterministic facts are retained only as a fallback for
    // fields the provider did not return.
    confidence: Math.max(0.82, 0.96 - index * 0.015),
  }));
  const seen = new Set(facts.map((fact) => `${fact.kind}:${fact.text.toLocaleLowerCase()}`));
  for (const fact of baseline.facts) {
    const key = `${fact.kind}:${fact.text.toLocaleLowerCase()}`;
    if (!seen.has(key)) {
      facts.push(fact);
      seen.add(key);
    }
  }
  return facts.slice(0, 24);
}

function applyModelResult(baseline: SessionDigest, result: SessionDigestResult, events: EventRow[], provider: WorklogModelProvider): SessionDigest {
  const status = supportedModelStatus(result, baseline, events);
  const facts = modelFacts(result, baseline).filter((fact) => {
    if (["verified", "abandoned"].includes(status) && ["risk", "next_step"].includes(fact.kind)) return false;
    return true;
  });
  const factCompleted = facts.filter((fact) => fact.kind === "change").map((fact) => fact.text);
  const factValidations = facts.filter((fact) => fact.kind === "validation").map((fact) => fact.text);
  const evidence = [...baseline.evidence, ...result.evidenceIds.map((eventId) => ({ eventId, section: "progress" as const }))];
  return {
    ...baseline,
    headline: result.headline,
    progressSummary: result.progressSummary,
    completed: [...new Set([...result.completed, ...factCompleted])].slice(0, 6),
    validations: [...new Set([...baseline.validations, ...result.validations, ...factValidations])].slice(0, 6),
    blockers: status === "blocked" ? result.blockers : [],
    remaining: ["verified", "abandoned"].includes(status) ? [] : result.remaining,
    status,
    confidence: Math.max(baseline.confidence, 0.82),
    nextStep: result.nextStep,
    facts,
    provider: provider.name,
    evidence: [...new Map(evidence.map((item) => [`${item.eventId}:${item.section}`, item])).values()],
  };
}

function saveDigest(database: WorklogDatabase, digest: SessionDigest): void {
  const db = database.db;
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.query(`
      INSERT INTO session_digests(session_id,input_hash,objective,headline,progress_summary,completed_json,validations_json,blockers_json,remaining_json,status,confidence,next_step,last_event_at,provider,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET input_hash=excluded.input_hash,objective=excluded.objective,
        headline=excluded.headline,progress_summary=excluded.progress_summary,completed_json=excluded.completed_json,
        validations_json=excluded.validations_json,blockers_json=excluded.blockers_json,remaining_json=excluded.remaining_json,
        status=excluded.status,confidence=excluded.confidence,next_step=excluded.next_step,last_event_at=excluded.last_event_at,
        provider=excluded.provider,updated_at=excluded.updated_at
    `).run(digest.sessionId,digest.inputHash,digest.objective,digest.headline,digest.progressSummary,
      safeJson(digest.completed),safeJson(digest.validations),safeJson(digest.blockers),safeJson(digest.remaining),
      digest.status,digest.confidence,digest.nextStep,digest.lastEventAt ?? null,digest.provider,now,now);
    db.query("DELETE FROM session_digest_evidence WHERE session_id=?").run(digest.sessionId);
    digest.evidence.forEach((item, rank) => db.query("INSERT OR IGNORE INTO session_digest_evidence(session_id,event_id,digest_section,rank) VALUES (?,?,?,?)")
      .run(digest.sessionId,item.eventId,item.section,rank));
    db.query("DELETE FROM session_facts WHERE session_id=?").run(digest.sessionId);
    digest.facts.forEach((fact, rank) => db.query(`
      INSERT INTO session_facts(id,session_id,event_id,fact_kind,text,confidence,rank,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(sha256(`fact:${digest.sessionId}:${fact.eventId}:${fact.kind}:${fact.text}`), digest.sessionId,
      fact.eventId, fact.kind, fact.text, fact.confidence, rank, now));
  });
  transaction();
}

export interface DigestRebuildOptions {
  provider?: WorklogModelProvider | null;
  /** Restrict model enhancement to one project without sending other projects' events. */
  projectId?: string;
  maxModelSessions?: number;
  retryFailed?: boolean;
  /** Maximum attempts per Agent run. Kept at one by default for deterministic callers. */
  agentMaxAttempts?: number;
  /** Delay between transient Agent retries. */
  agentRetryDelayMs?: number;
  onAgentTrace?: (step: import("./agent/worklog-agent").AgentTraceStep) => void;
}

export interface DigestRebuildStats {
  rebuilt: number;
  skipped: number;
  enhanced: number;
  fallback: number;
  deferred: number;
}

export async function rebuildSessionDigests(database: WorklogDatabase, options: DigestRebuildOptions = {}): Promise<DigestRebuildStats> {
  const db = database.db;
  const sessions = db.query(`
    SELECT s.id, COALESCE(p.name, 'Unknown project') AS project_name FROM sessions s
    LEFT JOIN projects p ON p.id=s.project_id
    WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id=s.id AND e.event_type='user_message' AND e.content IS NOT NULL AND trim(e.content)<>'')
      AND (? IS NULL OR s.project_id=?)
    -- Spend the bounded model budget on uncertain work first. A pure
    -- newest-first order wastes all 20 slots on already verified audits and
    -- leaves the genuinely unfinished sessions on deterministic fallback.
    ORDER BY CASE WHEN EXISTS (
      SELECT 1 FROM session_digests previous
      WHERE previous.session_id=s.id
        AND previous.status IN ('in_progress','partially_done','blocked','done_unverified')
    ) THEN 0 ELSE 1 END,
    COALESCE(s.ended_at,s.started_at) DESC
  `).all(options.projectId ?? null, options.projectId ?? null) as Array<{ id: string; project_name: string }>;
  let rebuilt = 0;
  let skipped = 0;
  let enhanced = 0;
  let fallback = 0;
  let deferred = 0;
  let modelAttempts = 0;
  const provider = options.provider ?? null;
  const maximum = options.maxModelSessions ?? Number.POSITIVE_INFINITY;
  const fallbackMarker = provider ? `fallback:${provider.cacheKey}` : "";
  const deferredMarker = provider ? `deferred:${provider.cacheKey}` : "";

  for (const session of sessions) {
    const events = db.query(`
      SELECT id,event_type,timestamp,source_line,tool_name,tool_call_id,content,command,file_paths_json,is_error,raw_hash,metadata_json
      FROM events WHERE session_id=? ORDER BY source_line,id
    `).all(session.id) as EventRow[];
    const inputHash = sha256(`${DIGEST_VERSION}:${provider?.cacheKey ?? "off"}\n${events.map((event) => `${event.id}:${event.raw_hash}:${event.content ?? ""}:${event.command ?? ""}`).join("\n")}`);
    const existing = db.query("SELECT input_hash,provider FROM session_digests WHERE session_id=?").get(session.id) as { input_hash: string; provider: string } | null;
    const cacheHit = existing?.input_hash === inputHash && (!provider
      || existing.provider === provider.name
      || (existing.provider === fallbackMarker && !options.retryFailed));
    if (cacheHit) { skipped += 1; continue; }

    let digest = inferDigest(session.id, inputHash, events);
    if (!digest) {
      db.query("DELETE FROM session_digests WHERE session_id=?").run(session.id);
      continue;
    }
    const objectiveEventId = digest.evidence.find((item) => item.section === "objective")?.eventId;
    const objectiveEvent = events.find((event) => event.id === objectiveEventId);
    const digestEvents = objectiveEvent ? currentWorkSegment(events, objectiveEvent) : events;
    if (provider && modelAttempts < maximum) {
      modelAttempts += 1;
      let runId: string | undefined;
      let attempts = 0;
      try {
        const result = await new WorklogAgent(provider, {
          maxAttempts: options.agentMaxAttempts,
          retryDelayMs: options.agentRetryDelayMs,
          onTrace: (step) => {
            runId = step.runId;
            attempts = Math.max(attempts, step.attempt);
            persistAgentTrace(database, step);
            options.onAgentTrace?.(step);
          },
        })
          .run(modelInput(session.id, session.project_name, digest, digestEvents));
        digest = applyModelResult(digest, result.result, digestEvents, provider);
        enhanced += 1;
      } catch (error) {
        if (runId) persistAgentFailure(database, runId, session.id, error, provider.name, attempts);
        digest.provider = fallbackMarker;
        fallback += 1;
      }
    } else if (provider) {
      digest.provider = deferredMarker;
      deferred += 1;
    }
    saveDigest(database, digest);
    rebuilt += 1;
  }
  db.run("DELETE FROM session_digests WHERE session_id NOT IN (SELECT id FROM sessions)");
  return { rebuilt, skipped, enhanced, fallback, deferred };
}
