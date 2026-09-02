# Agent Worklog

一个面向个人开发者的本地工作记录原型。它扫描 Codex 与 Claude Code 的本地 JSONL 历史，先理解每次会话做到了哪里，再按项目汇总工作事项、当前状态和下一步，并为每条总结保留可追溯引用。

完整的 Agent 生命周期、状态不变量和回退策略见 [AGENT_DESIGN.md](AGENT_DESIGN.md)。

默认不调用任何模型：扫描、SQLite 数据库、API 与 Web 页面都运行在本机。可以在设置页显式启用本机或远程 OpenAI-compatible Provider 来增强会话摘要，未配置时行为与原来的离线模式一致。

## 当前能力

- 增量扫描 `~/.codex/sessions`、`~/.codex/archived_sessions` 与 `~/.claude/projects`
- 排除 claude-mem observer、memory、系统上下文、IDE 提示、命令回显和审批转录
- 关联 Codex `call_id` 与 Claude Code `tool_use.id/tool_use_id`
- 根据 Git 根目录和工作目录自动归属项目
- 为每个会话生成结构化 `SessionDigest`：目标、当前进展、已完成、验证、阻塞、待处理和下一步
- 识别 Codex `commentary/final_answer`，进行中的对话不会因中途测试通过而提前标记完成
- 优先采用最近一条有效需求作为工作目标，忽略“开始”“继续”和会话续接提示
- 可选 LLM 增强会话目标、进展和下一步；模型失败、超时或引用非法时自动回退到确定性 Digest
- 会话 Digest 重建后运行工作事项 Agent 和项目级 Agent：三层调用会分别携带 `role=session/work_item/project`，使用职责不同的提示词；事项 Agent 基于真实事件重新判断每个事项的结论/状态，项目 Agent 基于增强后的事项生成项目叙事、完成/验证/阻塞/剩余事实和可追踪下一步，并分别按输入哈希缓存
- 模型只能引用本地索引里真实存在的事件 ID，不能生成虚构引用
- 将相似会话启发式合并为工作事项
- 推断计划中、进行中、部分完成、待验证、已验证、阻塞和已放弃状态
- 可人工纠正事项标题、进展摘要、状态与下一步；重新扫描后仍保留，也可随时恢复自动判断
- 可在事项详情标注“准确、标题不准、应拆分、应合并、状态错、摘要缺项、引用不对”，并保留可选备注
- 可从“待确认”页面导出已标注的脱敏真实历史评测集，供后续分段、标题、状态和引用规则回归
- 可把工作事项人工调整到已有项目；归属覆盖独立保存，重新扫描后仍生效，并可单独恢复自动归属
- 项目进度会聚合所有事项，展示当前阶段、当前推进、已完成、阻塞、下一步和引用置信度，不再只显示最近一条事项摘要
- 项目内会自动识别工作主线：按标题/摘要有效词、关联文件和 45 天时间窗归并事项，并保留主线级引用；结果明确标为“自动识别”，后续可人工确认或拆分
- 首页查看所有项目进展，生成跨项目工作总结；总结明确区分本时段真实活动与历史延续状态
- 每条工作总结带引用，可定位到脱敏后的原始 JSONL 文件与行号
- 设置页管理 Provider、隐私授权和单次扫描用量，并可用固定合成事件测试连接
- 首页显示 Agent 覆盖度（会话/事项/项目）与当前 Provider；未覆盖部分明确标为确定性统计，避免把旧规则结论误认为模型判断
- 提供 CLI、本地 API 和 Vue Web

## 快速开始

需要 [Bun](https://bun.sh/) 1.3 或更高版本。

```bash
bun install
bun run scan
bun run build
bun run start
```

打开 <http://127.0.0.1:4317>。

常用命令：

```bash
bun run scan             # 增量扫描并重建项目/工作事项
bun run status           # 在终端查看所有项目进展
bun run daily            # 生成今天的全项目总结
bun src/cli.ts discover-llm # 查看 ccswitch 当前模型的安全配置（不输出密钥）
bun src/cli.ts prompts      # 查看三层 Agent 当前实际使用的 system prompt
bun src/cli.ts daily 2026-08-12
bun run start            # 启动本地 API 与 Web
bun run dev              # 后台服务热重载
bun run dev:web          # Vite 前端开发服务器（http://127.0.0.1:4328）
bun test
bun run typecheck
bun run build
bun run eval              # 运行脱敏的摘要回归案例
bun run eval:score        # 统计真实工作事项反馈的覆盖率与错误类型
bun run eval:export       # 导出已标注的真实工作事项评测集到 .worklog/evals/work-items.json
bun src/cli.ts export-eval --all  # 导出全部事项（包括尚未标注的样本）
```

## 数据与隐私

- 默认只监听 `127.0.0.1`，不会把历史上传到外部服务。
- 数据库存放在当前目录的 `.worklog/worklog.sqlite`，目录已加入 `.gitignore`。
- 页面设置存放在 `.worklog/settings.json`，文件权限固定为 `0600`；API Key 只返回是否已配置，不返回明文。
- 索引前会过滤常见系统注入，并遮蔽 API Key、Bearer Token、password、secret 等常见敏感字段。
- 引用弹窗读取本机原始 JSONL 的相邻行，展示前再次执行敏感信息遮蔽。
- 扫描会读取项目仓库的只读 Git 元数据（分支、HEAD、工作区文件状态）；不读取文件内容，也不执行提交、推送或网络操作。
- 扫描、设置与人工纠正接口仅接受无 Origin 的本地客户端，或来自 localhost/127.0.0.1 的页面。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKLOG_DATA_DIR` | `./.worklog` | SQLite 数据目录 |
| `WORKLOG_CODEX_HOME` | `~/.codex` | Codex 历史根目录 |
| `WORKLOG_CLAUDE_HOME` | `~/.claude` | Claude Code 历史根目录 |
| `WORKLOG_HOST` | `127.0.0.1` | 服务监听地址 |
| `WORKLOG_PORT` | `4317` | 服务监听端口 |
| `WORKLOG_LLM_MODE` | `off` | `off`、`local` 或 `remote` |
| `WORKLOG_LLM_BASE_URL` | local 模式为 `http://127.0.0.1:11434/v1` | OpenAI-compatible API 根地址 |
| `WORKLOG_LLM_MODEL` | 空 | 启用 Provider 时必填的模型名 |
| `WORKLOG_LLM_PROTOCOL` | `chat_completions` | `chat_completions`、`responses` 或 `anthropic_messages`；ccswitch 会按当前 Provider 自动识别 |
| `WORKLOG_LLM_API_KEY` | 空 | 可选 Bearer Token；环境变量会覆盖本地设置 |
| `WORKLOG_LLM_ALLOW_REMOTE` | `0` | 远程模式必须显式设为 `1` |
| `WORKLOG_LLM_TIMEOUT_MS` | `60000` | 单会话模型调用超时 |
| `WORKLOG_LLM_MAX_INPUT_CHARS` | `24000` | 单会话发送给模型的最大字符数 |
| `WORKLOG_LLM_MAX_SESSIONS_PER_SCAN` | `20` | 每次扫描最多增强的会话数 |
| `WORKLOG_LLM_MAX_WORK_ITEMS_PER_SCAN` | `20` | 每次扫描最多增强的工作事项数；未处理事项会在后续扫描继续 |
| `WORKLOG_LLM_MAX_PROJECTS_PER_SCAN` | `10` | 每次扫描最多运行项目级 Agent 的项目数；未处理项目会在后续扫描继续 |
| `WORKLOG_LLM_RETRY_FAILED` | `0` | 设为 `1` 时重试已缓存的失败会话、事项和项目 Agent |
| `WORKLOG_LLM_IMPORT_CCSWITCH` | `0` | 设为 `1` 时，在没有其他 LLM 配置时读取 `~/.cc-switch/cc-switch.db` 当前 Codex/Claude Provider |

## 可选 LLM Provider

推荐在 Web 的“设置”页选择模式、填写 Provider 并测试连接。连接测试只发送固定合成事件，不会读取或发送历史对话；保存后从下一次扫描开始生效。配置优先级为：环境变量 > `.worklog/settings.json` > ccswitch（仅显式开启导入） > 默认值。ccswitch 仅读取当前 Codex/Claude Provider 的连接地址、模型、协议和认证字段，不修改其数据库。

本机兼容服务示例：

```bash
export WORKLOG_LLM_MODE=local
export WORKLOG_LLM_MODEL='your-local-model'
export WORKLOG_LLM_BASE_URL='http://127.0.0.1:11434/v1'
bun run scan
```

如果模型由 ccswitch 管理，可直接复用其当前 Codex/Claude Provider（首次使用需显式开启导入）：

```bash
export WORKLOG_LLM_IMPORT_CCSWITCH=1
bun run scan
```

远程服务需要两层显式配置：`remote` 模式和远程隐私授权。API Key 可保存在权限为 `0600` 且未纳入 Git 的本地设置中；生产环境也可使用进程环境覆盖：

```bash
export WORKLOG_LLM_MODE=remote
export WORKLOG_LLM_ALLOW_REMOTE=1
export WORKLOG_LLM_BASE_URL='https://your-provider.example/v1'
export WORKLOG_LLM_MODEL='your-model'
export WORKLOG_LLM_API_KEY='set-this-outside-git'
bun run scan
```

发送前会再次遮蔽常见凭据、把用户主目录替换为 `$HOME`，并按字符上限裁剪。本机端点只允许 loopback 且禁止 HTTP 重定向；远程端点必须使用 HTTPS，URL 不能内嵌账号密码。第一次启用不会一次处理全部历史：默认只增强最近 20 个会话，其余会在后续扫描继续。Provider 输出必须通过字段长度、状态跃迁和事件 ID 白名单校验，否则保留本地确定性结果。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/overview` | 项目总览、指标、Agent 覆盖度、需关注事项和扫描状态 |
| `POST` | `/api/scan` | 在后台启动增量扫描 |
| `GET` | `/api/scan/status` | 当前扫描进度 |
| `GET` | `/api/agent/runs?limit=20` | 最近 Agent 运行状态、scope（会话/事项/项目）、尝试次数和失败原因（不含原始提示词/密钥） |
| `GET` | `/api/agent/runs/:id` | 单次 Agent 的阶段轨迹详情（脱敏） |
| `GET` | `/api/agent/prompts` | 查看当前三层 Agent 的静态 system prompt 与版本；不包含任何历史事件或密钥 |
| `GET` | `/api/projects/:id` | 项目事项、引用与证据时间线 |
| `PUT` | `/api/work-items/:id/correction` | 保存事项标题、摘要、状态和下一步的人工纠正 |
| `DELETE` | `/api/work-items/:id/correction` | 删除人工纠正并恢复自动判断 |
| `PUT` | `/api/work-items/:id/project-correction` | 把事项人工调整到另一个已有项目 |
| `DELETE` | `/api/work-items/:id/project-correction` | 删除归属纠正并恢复自动项目归属 |
| `GET` | `/api/evidence/:id` | 证据详情及原始 JSONL 相邻行 |
| `GET` | `/api/reports/daily?date=YYYY-MM-DD` | 指定日期的全项目总结与引用 |
| `GET` | `/api/reports/work?range=today\|yesterday\|week` | 时间范围工作总结；每个项目同时返回本时段摘要、当前状态和历史延续事项 |
| `GET` | `/api/review` | 待确认工作事项与已有反馈 |
| `GET` | `/api/evals/score` | 统计评测覆盖率、确认准确数和高频错误类型 |
| `POST` | `/api/work-items/:id/feedback` | 保存事项反馈标签与备注 |
| `DELETE` | `/api/work-items/:id/feedback/:type` | 删除某个反馈标签 |
| `GET` | `/api/evals/export` | 导出已标注的脱敏真实评测样本；`includeUnreviewed=1` 可包含未标注事项 |
| `GET` | `/api/settings/llm` | 当前 Provider 设置；只返回 `hasApiKey` |
| `GET` | `/api/settings/llm/ccswitch` | 读取 ccswitch 当前 Codex/Claude Provider 的安全配置投影；不返回 API Key |
| `PUT` | `/api/settings/llm/ccswitch` | 在本机服务端导入当前 ccswitch Provider；API Key 不经过浏览器 |
| `PUT` | `/api/settings/llm` | 保存本机 Provider 设置并立即更新扫描配置 |
| `POST` | `/api/settings/llm/test` | 使用固定合成事件测试 Provider 连接 |

## 代码结构

```text
src/scanners/       Codex 与 Claude Code 适配器、增量 JSONL 读取
src/project-resolver.ts
                    Git/工作目录项目归属
src/repository-snapshots.ts
                    只读 Git 仓库快照与工作区证据
src/session-digests.ts
                    单会话进度理解、状态推断与证据选择
src/agent/worklog-agent.ts
                    Observe → Plan → Reason → Verify → Commit 的会话 Agent 编排；模型只负责推理，证据与状态约束仍由本地校验
src/agent/trace-store.ts
                    Agent run/step 轨迹持久化、失败记录与脱敏查询
src/work-items.ts   基于 Digest 合并工作事项
src/work-item-corrections.ts
                    跨扫描持久化的事项人工纠正
src/work-item-feedback.ts
                    事项反馈标签、待确认队列与标注持久化
src/work-item-eval-export.ts
                    脱敏真实历史评测集导出
src/project-corrections.ts
                    跨扫描持久化的项目归属纠正
src/services.ts     查询与日报服务
src/server.ts       Bun 本地 HTTP 服务
src/cli.ts          CLI
src/llm/provider.ts OpenAI Chat/Responses Provider、隐私保护与输出校验
src/agent/          会话/工作事项/项目 Agent、阶段轨迹与决策持久化
src/ccswitch.ts     只读读取 ccswitch 当前 Codex/Claude Provider 配置
src/settings.ts     Provider 设置校验、安全持久化与公开视图
web/                Vue 3 Dashboard
tests/              扫描、增量与上下文过滤测试
```

## 第一版边界

默认的 `SessionDigest`、标题合并、状态和项目摘要仍由确定性启发式规则生成，优点是本地、可复现、无需模型密钥；复杂语义可以选择由 Provider 增强。摘要用事件内容与 Provider 配置哈希做增量缓存，只有变化过的会话或尚未进入增强额度的会话才会重建。首页会显示各层 Agent 的增强覆盖数，未覆盖对象继续使用确定性结果，并在后续扫描按优先级进入 deferred 队列。

当前状态不是 Git 仓库的真实任务系统：`verified` 表示对话中存在可追溯的成功验证或明确结论，不代表代码已经提交、发布或部署。项目详情中的 Git 快照用于显示当前工作区证据。Agent 流程分为会话事实提取、工作事项判断和项目进度编排：会话 Agent 负责目标、事实、验证、阻塞与下一步；事项 Agent 基于事项关联的真实事件重新判断状态和摘要，并把决策写入 `work_item_agent_decisions`；项目 Agent 基于增强后的事项和真实事件引用重新判断项目叙事，并把决策写入 `project_agent_decisions`。每次模型调用最多进行一次暂时性错误重试（HTTP 408/409/425/429/5xx、超时、网络错误或明确的截断 JSON），失败后写入失败轨迹并回退到确定性摘要，不会阻断整次扫描。三种 Provider 协议统一请求 8192 个输出 Token，并对字段、列表和证据 ID 做本地约束；缓存键包含该预算，预算变化会自动触发重新增强。所有 Agent 阶段和错误详情只保存脱敏后的短文本；`verify` 阶段再次检查 evidenceIds，且进行中的会话不能被模型提前标记为 `verified`，普通进行中话术也不能升级事项状态。手动合并/拆分事项和 OpenCode/Hermes 适配器留到后续版本。

项目概览中的“正在推进”只统计以该项目最近活动为锚点、30 天内仍有活动的 `in_progress/partially_done` 事项；更早的历史事项仍保留在项目详情和证据链中，但不会继续放大当前进行中数量。

## 摘要评测

`bun run eval` 运行仓库内的合成、脱敏案例，检查目标、标题、状态、事实提取和引用完整性。真实历史不应提交到仓库；如果要建立个人评测集，请将相同格式的 JSON 放到 `.worklog/evals/` 后执行：

```bash
bun src/cli.ts eval .worklog/evals/session-digests.json
```

评测案例只保存最小事件和期望结果，不保存原始 JSONL 或凭据。
