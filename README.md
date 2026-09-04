# WorkLog

> 一个 local-first 的个人工作记录工具：把 Codex 与 Claude Code 的本地对话，整理成可追踪的项目进展、工作事项和证据链。

WorkLog 面向需要回顾开发过程、了解项目进度，或希望让 Agent 结论可验证的个人开发者。它默认只在本机扫描和保存数据，不依赖模型即可运行；需要时可以接入 OpenAI-compatible Provider，增强对会话语义的理解。

## 项目简介

AI 编程助手会产生大量对话和工具记录，但这些记录通常难以回答“项目推进到哪里了”“哪些工作已经完成”“结论依据是什么”。WorkLog 将本地会话转换为结构化的工作记录，并按项目和时间范围进行归纳。

```text
Codex / Claude Code 本地会话
            ↓
      增量扫描与脱敏
            ↓
    会话摘要与工作事项
            ↓
       项目进度与总结
```

## 核心能力

- **本地优先**：默认读取本地历史和 Git 元数据，数据保存在本机，不上传对话。
- **多来源归纳**：支持 Codex 会话、归档会话和 Claude Code 项目历史。
- **证据可追溯**：重要结论关联原始事件、来源文件和位置，便于回看上下文。
- **状态更可靠**：区分进行中、部分完成、待验证、已验证、阻塞等状态，减少误判。
- **跨会话整理**：将相关会话归并为工作事项，再汇总为项目进展和阶段总结。
- **可选模型增强**：未配置模型时使用本地确定性规则；启用 Provider 后由模型辅助语义分析，失败时自动回退。
- **隐私保护**：索引和展示前过滤常见系统内容并遮蔽 API Key、Token、password 等敏感字段。
- **本地 Web 与 CLI**：提供浏览器工作台和命令行入口，适合个人开发环境使用。

## 快速开始

需要 [Bun](https://bun.sh/) 1.3 或更高版本。

```bash
git clone https://github.com/beidun/WorkLog.git
cd WorkLog

bun install
bun run scan
bun run build
bun run start
```

启动后访问 <http://127.0.0.1:4317>。首次扫描会读取当前用户的 Codex 与 Claude Code 历史目录；如果本机没有历史记录，项目列表会为空，但服务仍可正常启动。

## 环境变量

所有配置都可以通过环境变量调整。未设置时使用下表默认值；LLM 相关配置也可以保存到 `.worklog/settings.json`，环境变量优先级更高。

### 基础配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WORKLOG_DATA_DIR` | `./.worklog` | SQLite 数据库和本地设置目录 |
| `WORKLOG_CODEX_HOME` | `~/.codex` | Codex 历史根目录 |
| `WORKLOG_CLAUDE_HOME` | `~/.claude` | Claude Code 历史根目录 |
| `WORKLOG_CCSWITCH_HOME` | `~/.cc-switch` | ccswitch 配置目录（仅启用导入时使用） |
| `WORKLOG_HOST` | `127.0.0.1` | 服务监听地址 |
| `WORKLOG_PORT` | `4317` | 服务监听端口 |

### 可选 LLM 配置

Provider 默认关闭。启用远程 Provider 前，需要同时设置 `WORKLOG_LLM_MODE=remote` 和 `WORKLOG_LLM_ALLOW_REMOTE=1`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WORKLOG_LLM_MODE` | `off` | `off`、`local` 或 `remote` |
| `WORKLOG_LLM_BASE_URL` | local 模式为 `http://127.0.0.1:11434/v1` | Provider 根地址 |
| `WORKLOG_LLM_MODEL` | 空 | 启用 Provider 时使用的模型名 |
| `WORKLOG_LLM_PROTOCOL` | `chat_completions` | `chat_completions`、`responses` 或 `anthropic_messages` |
| `WORKLOG_LLM_API_KEY` | 空 | 可选 API Key；不要提交到 Git |
| `WORKLOG_LLM_ALLOW_REMOTE` | `0` | 是否允许访问远程 Provider，使用 `1` 开启 |
| `WORKLOG_LLM_TIMEOUT_MS` | `60000` | 单次模型调用超时时间（毫秒） |
| `WORKLOG_LLM_MAX_INPUT_CHARS` | `24000` | 单次发送给模型的最大字符数 |
| `WORKLOG_LLM_MAX_SESSIONS_PER_SCAN` | `20` | 每次扫描最多增强的会话数 |
| `WORKLOG_LLM_MAX_WORK_ITEMS_PER_SCAN` | `20` | 每次扫描最多增强的工作事项数 |
| `WORKLOG_LLM_MAX_PROJECTS_PER_SCAN` | `10` | 每次扫描最多增强的项目数 |
| `WORKLOG_LLM_RETRY_FAILED` | `0` | 使用 `1` 重试已缓存的失败 Agent 运行 |
| `WORKLOG_LLM_IMPORT_CCSWITCH` | `0` | 使用 `1` 读取 ccswitch 当前 Provider 配置 |

本机 Provider 示例：

```bash
export WORKLOG_LLM_MODE=local
export WORKLOG_LLM_MODEL=your-local-model
export WORKLOG_LLM_BASE_URL=http://127.0.0.1:11434/v1
bun run scan
```

## 数据与隐私

- 默认监听 `127.0.0.1`，离线模式不会访问外部服务。
- 数据库和设置保存在 `.worklog/`，该目录不应提交到仓库。
- 扫描会过滤常见系统注入、命令回显和审批转录，并在展示证据前再次脱敏。
- 扫描只读取项目仓库的 Git 元数据，不读取代码文件内容，也不执行提交、推送或其他网络操作。
- 远程 Provider 只有在显式配置并授权后才会使用；API Key 只用于本地配置，不会返回明文。

## License

当前仓库尚未附带 `LICENSE` 文件。公开发布前，请根据使用和分发需求补充合适的开源许可证。
