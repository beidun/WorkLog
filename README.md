# Agent Worklog

一个面向个人开发者的本地工作记录原型。它扫描 Codex 与 Claude Code 的本地 JSONL 历史，按项目归档会话，从对话和工具调用中推断工作事项、当前状态、下一步，并为每条总结保留可追溯引用。

第一版不调用任何云端模型：扫描、SQLite 数据库、API 与 Web 页面都运行在本机。

## 当前能力

- 增量扫描 `~/.codex/sessions`、`~/.codex/archived_sessions` 与 `~/.claude/projects`
- 排除 claude-mem observer、memory、系统上下文、IDE 提示、命令回显和审批转录
- 关联 Codex `call_id` 与 Claude Code `tool_use.id/tool_use_id`
- 根据 Git 根目录和工作目录自动归属项目
- 将相似会话启发式合并为工作事项
- 推断计划中、进行中、部分完成、待验证、已验证、阻塞和已放弃状态
- 首页查看所有项目进展，生成当日跨项目工作总结
- 每条工作总结带引用，可定位到脱敏后的原始 JSONL 文件与行号
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
bun src/cli.ts daily 2026-08-12
bun run start            # 启动本地 API 与 Web
bun run dev              # 后台服务热重载
bun run dev:web          # Vite 前端开发服务器
bun test
bun run typecheck
bun run build
```

## 数据与隐私

- 默认只监听 `127.0.0.1`，不会把历史上传到外部服务。
- 数据库存放在当前目录的 `.worklog/worklog.sqlite`，目录已加入 `.gitignore`。
- 索引前会过滤常见系统注入，并遮蔽 API Key、Bearer Token、password、secret 等常见敏感字段。
- 引用弹窗读取本机原始 JSONL 的相邻行，展示前再次执行敏感信息遮蔽。
- `POST /api/scan` 仅接受无 Origin 的本地客户端，或来自 localhost/127.0.0.1 的页面。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKLOG_DATA_DIR` | `./.worklog` | SQLite 数据目录 |
| `WORKLOG_CODEX_HOME` | `~/.codex` | Codex 历史根目录 |
| `WORKLOG_CLAUDE_HOME` | `~/.claude` | Claude Code 历史根目录 |
| `WORKLOG_HOST` | `127.0.0.1` | 服务监听地址 |
| `WORKLOG_PORT` | `4317` | 服务监听端口 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/overview` | 项目总览、指标、需关注事项和扫描状态 |
| `POST` | `/api/scan` | 在后台启动增量扫描 |
| `GET` | `/api/scan/status` | 当前扫描进度 |
| `GET` | `/api/projects/:id` | 项目事项、引用与证据时间线 |
| `GET` | `/api/evidence/:id` | 证据详情及原始 JSONL 相邻行 |
| `GET` | `/api/reports/daily?date=YYYY-MM-DD` | 指定日期的全项目总结与引用 |

## 代码结构

```text
src/scanners/       Codex 与 Claude Code 适配器、增量 JSONL 读取
src/project-resolver.ts
                    Git/工作目录项目归属
src/work-items.ts   会话合并、状态推断、引用选择
src/services.ts     查询与日报服务
src/server.ts       Bun 本地 HTTP 服务
src/cli.ts          CLI
src/llm/provider.ts 后续模型提取接口占位
web/                Vue 3 Dashboard
tests/              扫描、增量与上下文过滤测试
```

## 第一版边界

当前标题合并、状态和摘要均由确定性启发式规则生成，优点是本地、可复现、无需模型密钥；缺点是对“是否真的完成”“只是讨论阻塞还是当前被阻塞”等语义判断还不够精确。Git diff/commit 校验、人工调整项目归属、OpenCode/Hermes 适配器和可选 LLM Provider 留到后续版本。
