# tupigcode

[![CI](https://img.shields.io/github/actions/workflow/status/Tupig/tupigcode/ci.yml?branch=main&label=CI)](https://github.com/Tupig/tupigcode/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-black?logo=nodedotjs&logoColor=white)](#快速开始)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript&logoColor=white)](#项目结构)
[![vitest](https://img.shields.io/badge/vitest-1126%20%E7%BB%BF-brightgreen?logo=vitest&logoColor=white)](#测试与-ci)
[![gameqa](https://img.shields.io/badge/gameqa-Unity%20%E6%B5%8B%E8%AF%95%E5%B9%B3%E5%8F%B0-orange?logo=unity&logoColor=white)](#gameqa--unity-自动化测试平台)

> 全 TypeScript 的本地研发工具集，四个部分：
> 编码代理（tupigcode）、Unity 测试平台（gameqa）、MLX 本地推理层（llm）、单端口三协议代理。
> 全部自托管，数据不出本机，本文档是唯一文档。

> An all-TypeScript local R&D toolkit, four parts:
> coding agent (tupigcode), Unity testing platform (gameqa), MLX local inference layer (llm), single-port three-protocol proxy.
> All self-hosted, data never leaves this machine, this document is the only document.

## 目录 / Table of Contents

- [这是什么](#这是什么)
- [快速开始](#快速开始)
  - [命令入口](#命令入口)
- [架构](#架构)
- [tupigcode — AI 编码代理](#tupigcode--ai-编码代理)
  - [能力清单（20+ 工具）](#能力清单20-工具)
  - [上下文与压缩](#上下文与压缩)
  - [容错与路由](#容错与路由)
  - [Hooks](#hooks)
  - [工具执行与并行](#工具执行与并行)
  - [权限、审查与护栏](#权限审查与护栏)
  - [会话与状态](#会话与状态)
  - [MCP](#mcp)
  - [工作模式与观测](#工作模式与观测)
- [gameqa — Unity 自动化测试平台](#gameqa--unity-自动化测试平台)
  - [任务类型（Agent 侧，`extra.job_type`）](#任务类型agent-侧extrajob_type)
  - [内置执行器（服务端，`platform=web`，无需 Agent）](#内置执行器服务端platformweb无需-agent)
  - [结果解析与报告](#结果解析与报告)
  - [服务端 API（31 路由）](#服务端-api31-路由)
  - [关键环境变量](#关键环境变量)
  - [运维脚本与部署](#运维脚本与部署)
- [MLX 本地推理 + 协议代理](#mlx-本地推理--协议代理)
  - [模型清单（`mlx/models.json`）](#模型清单mlxmodelsjson)
- [项目结构](#项目结构)
- [配置与环境变量](#配置与环境变量)
  - [tupigcode / 引擎](#tupigcode--引擎)
  - [MLX / 代理](#mlx--代理)
- [开发流程（PROCESS）](#开发流程process)
  - [Bug / 优化 · Issue 强制流程](#bug--优化--issue-强制流程)
  - [提交信息规范](#提交信息规范)
- [测试与 CI](#测试与-ci)
- [常见问题](#常见问题)
- [演进里程碑](#演进里程碑)

- [What Is This](#这是什么)
- [Quick Start](#快速开始)
  - [Command Entry Points](#命令入口)
- [Architecture](#架构)
- [tupigcode — AI Coding Agent](#tupigcode--ai-编码代理)
  - [Capability List (20+ Tools)](#能力清单20-工具)
  - [Context and Compaction](#上下文与压缩)
  - [Fault Tolerance and Routing](#容错与路由)
  - [Hooks](#hooks)
  - [Tool Execution and Parallelism](#工具执行与并行)
  - [Permissions, Review and Guardrails](#权限审查与护栏)
  - [Sessions and State](#会话与状态)
  - [MCP](#mcp)
  - [Work Modes and Observability](#工作模式与观测)
- [gameqa — Unity Automated Testing Platform](#gameqa--unity-自动化测试平台)
  - [Task Types (Agent side, `extra.job_type`)](#任务类型agent-侧extrajob_type)
  - [Built-in Executors (server side, `platform=web`, no Agent)](#内置执行器服务端platformweb无需-agent)
  - [Result Parsing and Reports](#结果解析与报告)
  - [Server API (31 Routes)](#服务端-api31-路由)
  - [Key Environment Variables](#关键环境变量)
  - [Operations Scripts and Deployment](#运维脚本与部署)
- [MLX Local Inference + Protocol Proxy](#mlx-本地推理--协议代理)
  - [Model List (`mlx/models.json`)](#模型清单mlxmodelsjson)
- [Project Structure](#项目结构)
- [Configuration and Environment Variables](#配置与环境变量)
  - [tupigcode / Engine](#tupigcode--引擎)
  - [MLX / Proxy](#mlx--代理)
- [Development Process (PROCESS)](#开发流程process)
  - [Bug / Optimization · Mandatory Issue Workflow](#bug--优化--issue-强制流程)
  - [Commit Message Conventions](#提交信息规范)
- [Tests and CI](#测试与-ci)
- [FAQ](#常见问题)
- [Evolution Milestones](#演进里程碑)

## 这是什么 / What Is This

跑在自己机器上的研发工具台，由四个部分组成：

A development workbench running on your own machine, composed of four parts:

| 组件 | 说明 | 入口 |
| --- | --- | --- |
| **tupigcode-agent** | 编码代理，参照 Claude Code 架构实现：读代码、改文件、跑命令、多步规划，全链路可本地运行 | `tupigcode` |
| **gameqa** | Unity3D 游戏自动化测试编排：HTTPS 看板 + 任务队列 + 跨机 Agent + Unity batchmode 真执行，NUnit3 全量用例解析与双报告出口（详见 gameqa 章），API 与数据格式兼容原 gpt-visual-platform（Go 版） | `gameqa serve` / `gameqa agent` |
| **MLX 推理层** | 在 Apple Silicon（M4）上用 MLX 跑本地大模型，管理服务生命周期，单端口暴露给任意客户端 | `llm` |
| **协议代理** | 一个端口同时说 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议，互相转换后转本地后端 | `:4100`（由 `llm` 拉起） |

English summary: **tupigcode-agent** is a coding agent modeled on the Claude Code architecture — read code, edit files, run commands, multi-step planning, the whole chain runs locally, entry `tupigcode`; **gameqa** is Unity3D game automated test orchestration — HTTPS dashboard + task queue + cross-machine Agent + real Unity batchmode execution, full NUnit3 case parsing with two report outlets (see the gameqa chapter), API and data format compatible with the original gpt-visual-platform (Go), entries `gameqa serve` / `gameqa agent`; **MLX inference layer** runs local large models on Apple Silicon (M4) with MLX, manages the service lifecycle, exposes a single port to any client, entry `llm`; **protocol proxy** speaks OpenAI Chat, OpenAI Responses and Anthropic Messages on one port, converts between them and forwards to the local backend, `:4100` (brought up by `llm`).

设计原则：

Design principles:

- **一种语言**：全仓 TypeScript（含脚本、代理、测试），无 Python / Go / Rust 残留
- **自托管**：代码、模型、测试数据不出本机；云端 Provider 是可选项，不是依赖
- **客户端开放**：任何支持 OpenAI 或 Anthropic 协议的工具（opencode / Claude Code / codex 等）都能直连本机
- **一份文档**：本 README 即项目全部文档，随代码同步更新，历史看 git 记录

- **One language**: the whole repo is TypeScript (scripts, agents, tests included), no Python / Go / Rust remnants
- **Self-hosted**: code, models and test data never leave this machine; cloud providers are optional, not a dependency
- **Open clients**: any tool that speaks the OpenAI or Anthropic protocol (opencode / Claude Code / codex, etc.) can connect directly to this machine
- **One document**: this README is the entire project documentation, updated in sync with the code, history in the git records

## 快速开始 / Quick Start

```bash
git clone https://github.com/Tupig/tupigcode.git && cd tupigcode
npm ci                # 安装依赖（Node ≥ 20，构建需 Node 22+）
npm run build         # tsc 编译 + 拷贝 gameqa 看板静态资源 + 入口 chmod
npm test              # 131 文件 / 1126 用例（tsc + vitest 是 CI 双门槛）
```

构建后 `dist/cli/*.js` 即 7 个可执行入口。常用命令：

After building, `dist/cli/*.js` are the 7 executable entry points. Common commands:

```bash
# 1) 本地对话（先 llm start 起 MLX 服务，见下文）
llm "解释闭包"

# 2) AI 编码代理（在任意代码仓里）
tupigcode                      # 交互式 REPL
tupigcode "把 src/utils 里的重复逻辑抽出来"

# 3) Unity 测试平台（HTTPS 自签名，看板 https://localhost:9111）
gameqa serve -p 9111 -d data
PLATFORM_URL=https://localhost:9111 AGENT_ID=agent-1 PLATFORM=mac \
  AGENT_SKILLS=PlayMode PLATFORM_INSECURE_TLS=1 gameqa agent
# 报告出口：https://localhost:9111/report（轻量+趋势） /allure（Allure 风格）
```

> [!IMPORTANT]
> - 开发态可用 `npm run dev:tupigcode` / `npm run gameqa:serve`（tsx 直跑，免构建）。
> - gameqa 默认全站 HTTPS（自签名证书自动生成于 `data/tls/`）；浏览器首次访问点「高级 → 继续前往」，macOS 可执行 `./scripts/trust-cert-macos.sh` 完成信任。
> - 跑 MLX 需要 Apple Silicon；`llm doctor` 自检环境。

> [!IMPORTANT]
> - In development mode you can use `npm run dev:tupigcode` / `npm run gameqa:serve` (tsx runs directly, no build needed).
> - gameqa is HTTPS site-wide by default (self-signed certificate is generated automatically in `data/tls/`); on first browser visit click "Advanced → Proceed", on macOS you can run `./scripts/trust-cert-macos.sh` to complete the trust.
> - Running MLX requires Apple Silicon; `llm doctor` checks the environment.

### 命令入口 / Command Entry Points

| 命令 | 用途 | 典型用法 |
| --- | --- | --- |
| `tupigcode` | 编码代理主入口 | `tupigcode "重构这个模块"` / `tupigcode`（REPL） |
| `llm` | MLX 本地服务管理 + 对话 | `llm start` / `llm use 8b` / `llm "问题"` / `llm doctor` |
| `gameqa` | 测试平台 serve / agent 双子命令 | `gameqa serve --tls off` / `gameqa agent` |
| `opencode-local` | 走本机代理的 opencode 入口 | `opencode-local "写个快排"` |
| `claude-local` | 走本机代理的 Claude Code 入口 | `claude-local "重构这个函数"` |
| `codex-local` | 走本机代理的 Codex 入口 | `codex-local exec "跑测试"` |
| `mlx-local` | MLX 模型直连入口 | `mlx-local "补全这段"` |

English summary: `tupigcode` is the main coding-agent entry (`tupigcode "重构这个模块"` / `tupigcode` for REPL); `llm` manages the MLX local service and chat (`llm start` / `llm use 8b` / `llm "问题"` / `llm doctor`); `gameqa` is the test-platform serve / agent double subcommand (`gameqa serve --tls off` / `gameqa agent`); `opencode-local` is the opencode entry through the local proxy (`opencode-local "写个快排"`); `claude-local` is the Claude Code entry through the local proxy (`claude-local "重构这个函数"`); `codex-local` is the Codex entry through the local proxy (`codex-local exec "跑测试"`); `mlx-local` is the direct MLX model entry (`mlx-local "补全这段"`).

开发态脚本：`npm run dev`（index）、`dev:tupigcode`、`dev:llm`、`gameqa:serve`、`gameqa:agent`、`test`、`test:watch`。

Development-mode scripts: `npm run dev` (index), `dev:tupigcode`, `dev:llm`, `gameqa:serve`, `gameqa:agent`, `test`, `test:watch`.

## 架构 / Architecture

```
                         ┌─────────────────────────────────────────┐
   tupigcode / gameqa /      │  src/engine      QueryEngine 主链路      │
   *-local 客户端  ──────▶│  src/tools       20+ 工具（读写/检索/执行）│
                         │  src/session     会话/检查点/轨迹         │
                         │  src/context     压缩/预算/RepoMap        │
                         │  src/knowledge   记忆/技能/反思           │
                         │  src/modes       plan·act + spec         │
                         │  src/agents      子代理                  │
                         │  src/services    API/沙箱/权限/容错       │
                         └─────────────────────────────────────────┘

   gameqa serve ── HTTPS :9111 ── 看板 static + REST API + 内置执行器 worker
        ▲  poll / 上报（X-Platform-Token 可选）
   gameqa agent ── Unity batchmode · Airtest · AI 探索 · ADB/性能/日志
   （跨 Mac/Linux/Windows/iOS/Android；PLATFORM_INSECURE_TLS 信任自签名）

   任意 OpenAI/Anthropic 客户端 ──▶ :4100 代理（三协议互转）──▶ :8080 mlx_lm.server
```

## tupigcode — AI 编码代理 / tupigcode — AI Coding Agent

### 能力清单（20+ 工具） / Capability List (20+ Tools)

| 类别 | 工具 |
| --- | --- |
| 读写 | `Read`（文本 + 图片多模态输入，png/jpg/webp/gif ≤5MB）`Write` `Edit`（精确匹配，失败时模糊回退，容忍缩进/空白/单字符漂移，唯一命中才替换）`MultiEdit`（多组替换原子落盘，失败报「第 N 处不匹配」）`DocRead` `ImageRead`（后 3 项为 extras） |
| 检索 | `Grep`（ripgrep 主路径 + 内置降级；`offset` / `head_limit` 分页，截断带续取提示）`Glob` `RepoMap`（全仓地图） |
| 执行 | `Bash`（沙箱 + 安全护栏）`RunTests`（auto-test 自验证循环）`PackageInstall` `PackageUninstall` `PackageList` `RunScript`（后 4 项 extras） |
| 规划 | `TodoWrite`（任务清单）`Question`（向用户澄清）`Agent`（子代理派发）`CompactContext`（手动压缩）`ToolSearch`（延迟装载元工具） |
| Git | `GitStatus` `GitDiff`（默认）`GitCommit` `GitUndo`（extras） |
| 联网 | `WebSearch`（默认）`WebFetch`（extras） |
| 分析与重构（extras） | `CodeStats` `ListFunctions` `DependencyAnalysis` `ComplexityAnalysis` `RenameSymbol` `ExtractFunction` `MoveFile` `InlineVariable` `ExtractConstant` |
| 扩展 | **MCP 客户端**：接入外部 MCP server，工具桥接为 `mcp_<server>_<tool>`，配置、审批、OAuth 与断线自愈见下文 MCP 节 |

English summary: the capability list covers 读写 (read/write) — `Read` (text + image multimodal input, png/jpg/webp/gif ≤5MB), `Write`, `Edit` (exact match with fuzzy fallback, tolerating indentation/whitespace/single-character drift, replaced only on a unique hit), `MultiEdit` (multi-group replacement written atomically, reports 「第 N 处不匹配」 on failure), `DocRead`, `ImageRead` (the last 3 are extras); 检索 (retrieval) — `Grep` (ripgrep main path + built-in fallback; `offset` / `head_limit` paging, truncation comes with a continuation hint), `Glob`, `RepoMap` (whole-repo map); 执行 (execution) — `Bash` (sandbox + safety guardrails), `RunTests` (auto-test self-verification loop), `PackageInstall`, `PackageUninstall`, `PackageList`, `RunScript` (the last 4 are extras); 规划 (planning) — `TodoWrite`, `Question`, `Agent`, `CompactContext`, `ToolSearch`; Git — `GitStatus`, `GitDiff` (default), `GitCommit`, `GitUndo` (extras); 联网 (web) — `WebSearch` (default), `WebFetch` (extras); 分析与重构 analysis & refactoring extras — `CodeStats`, `ListFunctions`, `DependencyAnalysis`, `ComplexityAnalysis`, `RenameSymbol`, `ExtractFunction`, `MoveFile`, `InlineVariable`, `ExtractConstant`; 扩展 (extensions) — the **MCP client** connects external MCP servers and bridges their tools as `mcp_<server>_<tool>`, with configuration, approval, OAuth and disconnect self-healing covered in the MCP section below.

默认 16 + extras 19 = **35 工具**；extras 池经 `ToolSearch` 或 `TUPIG_EXTRA_TOOLS` 挂载。**内建机制（非独立工具）**：`Edit`/`Write` 失败的 Levenshtein 相近行反馈、编辑后自动 lint 检查、写盘失败回滚、写组分区并行——由读写工具内部调用。

16 default + 19 extras = **35 tools**; the extras pool is mounted via `ToolSearch` or `TUPIG_EXTRA_TOOLS`. **Built-in mechanisms (not standalone tools)**: Levenshtein near-line feedback on `Edit`/`Write` failures, automatic lint check after an edit, rollback on write failure, write-group partitioned parallelism — invoked internally by the read/write tools.

### 上下文与压缩 / Context and Compaction

- **压缩**：预算制，含阈值梯子与熔断；micro/snip 无变化时跳过（不计数、不误报、不触发熔断）；force 档 LLM 摘要三条链路可用（openai 本地非流式、anthropic 均 30s 超时、mock），失败回退预算削减且保留首条消息。`TUPIG_MAX_CONTEXT_TOKENS` 自适应窗口 30k ~ 10M
- **轨迹记录**：事件环形上限 2000 条（超出计 dropped）、tool_result 截断 2000 字符、每会话落盘滚动保留 8 份
- **token 估算**：`estimateTokens` 计入 system prompt 与 tool schema（chars/4 同口径）；messages 段增量缓存，数组尾部追加只序列化新增部分，换引用或缩短时全量重算，结果与全量 `JSON.stringify` 等值
- **usage 入账**：末帧优先，`message_start` 首帧记 input，`input + cache_read + cache_creation` 全量入账；OpenAI 直连注入 `stream_options.include_usage` 并解析末帧 usage-only chunk，与 proxy 注入口径一致
- **prompt cache 稳定前缀**：system 分两层，稳定层带 `cache_control` 断点，lineage / 工具状态 / todo 等易变层排在断点之后，前缀字节不变即不失效。Anthropic 请求在 tools 末项、末条消息末 content block 同打 block 级断点（MessageParam 顶层无此字段），每轮重建、历史断点先清理，不超过 4 个上限；OpenAI / mock 路径把 blocks 展平为字符串，不外泄字段
- **变更史注入**：`git log` 近 30 条由模型压成短摘要，缓存于 `.tupigcode/cache/lineage.json`（HEAD 变更才重算），以「## 近期变更」注入 system prompt 尾部；预算截断取最近（`TUPIG_LINEAGE_MAX_CHARS` 默认 800）；无 git、无模型、超时（5s）时静默跳过
- **手动压缩**：`/compact [focusing on X]` 走既有流水线（snip → micro → collapse → LLM 摘要），焦点指令透传；`/context` 分段明细（系统提示 / 对话消息 / 工具结果 / 工具 schema / 记忆，各段 token 与条数，求和等于总量）
- **压缩保留工具调用史**：摘要 prompt 要求三要素（文件路径 / 关键命令 / 结果结论）；压缩时抽取 `tool_use` 线索附在摘要尾部（上限 10 条去重）；二次压缩检测到首条为旧摘要时，旧摘要并入新摘要并回收旧线索区段
- **压缩丢弃可见**：每次压缩落 `lastCompaction`（前后消息数、估 token、source、at），阈值梯度与溢出恢复路径打印「丢 N 条消息 / 省约 M tokens」，`/context` 展示最近一次
- **上下文溢出自动恢复**：API 报 prompt too long 时不直接失败，走压缩流水线重建 messages 后重试本轮（限 2 次，触发 PreCompact/PostCompact，`compactionCount+1`），与 max_tokens 输出额度升级互不干扰；该类错误 `failoverEligible=false`（切 provider 解决不了超限）
- **子代理自动压缩**：子代理循环每轮前估算上下文，超过 `MAX_CONTEXT_TOKENS×0.6` 走既有压缩流水线重建后继续，失败回退 budgetReduction；`SubAgentResult.compactions` 计数对父代理与轨迹可见

- **Compaction**: budget-based, with a threshold ladder and circuit breaker; micro/snip are skipped when there is no change (not counted, no false positives, does not trip the breaker); the force tier has three available LLM summary paths (openai local non-streaming, anthropic both with 30s timeout, mock), and on failure it falls back to budget reduction while keeping the first message. `TUPIG_MAX_CONTEXT_TOKENS` adaptive window 30k ~ 10M
- **Trajectory recording**: event ring buffer capped at 2000 entries (overflow counted as dropped), tool_result truncated to 2000 characters, persisted per session with 8 rolling copies kept
- **Token estimation**: `estimateTokens` counts the system prompt and tool schema (same chars/4 basis); the messages segment is cached incrementally — an append at the array tail only serializes the new part, a reference change or shortening triggers a full recompute, and the result equals a full `JSON.stringify`
- **Usage accounting**: last frame wins, the `message_start` first frame records input, and `input + cache_read + cache_creation` is accounted in full; direct OpenAI injects `stream_options.include_usage` and parses the trailing usage-only chunk, consistent with the proxy injection basis
- **prompt cache stable prefix**: the system prompt has two layers — the stable layer carries a `cache_control` breakpoint, while volatile layers (lineage / tool state / todo, etc.) come after it, so the prefix stays valid as long as its bytes do not change. Anthropic requests set block-level breakpoints on the last tools item and on the last content block of the last message (MessageParam has no such top-level field), rebuilt every turn with historical breakpoints cleaned first, capped at 4; the OpenAI / mock paths flatten blocks into a string and do not leak the field
- **Change-history injection**: the last 30 `git log` entries are compressed by the model into a short summary, cached at `.tupigcode/cache/lineage.json` (recomputed only when HEAD changes), and injected at the end of the system prompt as 「## 近期变更」; budget truncation keeps the most recent (`TUPIG_LINEAGE_MAX_CHARS` default 800); silently skipped when there is no git, no model, or a timeout (5s)
- **Manual compaction**: `/compact [focusing on X]` goes through the existing pipeline (snip → micro → collapse → LLM summary) with the focus instruction passed through; `/context` gives a per-segment breakdown (system prompt / conversation messages / tool results / tool schema / memory, tokens and counts per segment, summing to the total)
- **Compaction preserves tool-call history**: the summary prompt requires three elements (file paths / key commands / result conclusions); on compaction, `tool_use` clues are extracted and appended to the end of the summary (capped at 10, deduplicated); on a second compaction, when the first entry is detected as an old summary, the old summary is merged into the new one and the old clue section is reclaimed
- **Compaction drops are visible**: every compaction writes `lastCompaction` (message counts before/after, estimated token, source, at), and the threshold ladder and overflow-recovery paths print 「丢 N 条消息 / 省约 M tokens」, with `/context` showing the most recent one
- **Automatic context-overflow recovery**: when the API reports prompt too long it does not fail directly — it rebuilds messages through the compaction pipeline and retries the current turn (limited to 2 attempts, firing PreCompact/PostCompact, `compactionCount+1`), which does not interfere with max_tokens output-quota escalation; such errors carry `failoverEligible=false` (switching provider cannot fix the overflow)
- **Sub-agent auto-compaction**: before each sub-agent loop iteration the context is estimated; past `MAX_CONTEXT_TOKENS×0.6` it rebuilds through the existing compaction pipeline and continues, falling back to budgetReduction on failure; `SubAgentResult.compactions` counts are visible to the parent agent and the trajectory

### 容错与路由 / Fault Tolerance and Routing

- **多 Provider 容错**：Anthropic / OpenAI / 本地代理统一接入，`TUPIG_FAILOVER` 链式降级。错误分类见 `services/errors.ts`（rate_limit / auth / context_too_long / overloaded / server / network / invalid_request），429/529/5xx/断连触发切换，401 与业务错误不切换；`TUPIG_ROLE_MODELS` 按角色选模型
- **重试退避**：`callWithRetry` 用 full-jitter 退避 `rand(0, min(10s, 1s·2^n))`，总预算 `TUPIG_RETRY_BUDGET_MS`（默认 60s）超限抛最后错误，401/403 立即抛
- **结果语义与截断保真（fix #95/#96）**：错误与中断路径只产出一条 `error` result，`route.log` feedback 记真实成败；Anthropic `stop_reason=max_tokens` 与 OpenAI `finish_reason=length` 进入输出额度升级重试（基线跟随 `maxTokens`，阶梯 `[8192,16384,32768,65536]`，耗尽才报错）
- **failover 状态回滚（fix #97）**：主源中途断流切换兜底前回滚 `fullText` / `toolBuffers` / 早派发遗留与 `events`，assistant 消息只含兜底全量输出
- **兜底模型接线（fix #98）**：`config.fallbackModel` 优先，缺省按兜底 provider 解析云模型（`TUPIG_CLOUD_MODEL` / `OPENAI_MODEL`，anthropic 默认 `claude-sonnet-4-20250514`），避免把本地模型名打到云端 404
- **Ctrl+C 中断**：turn 进行中 SIGINT 调 `interrupt()`（`interruptActiveTurn` 活跃注册表），信号接入 LLM 流（`streamMessage` 收 signal），在途工具 per-call controller 联动 abort（取消文案、不 fire PostToolUseFailure）；`AbortError` 不切兜底，收尾 fire `Stop(output=任务已中断)` 与单条 error result；空闲时同步落盘 + exit(130)，二按强制退出
- **流式空闲看门狗**：`withIdleWatchdog` 包装流式消费，距上一个内容事件超过阈值（默认 120s，`TUPIG_STREAM_IDLE_MS` 覆盖，0 关闭）抛「流式响应空闲超时」并回收内层迭代器；字节级 keepalive 不产生事件不重置计时；错误归类 network，复用既有 retry/failover 通道
- **流式早期派发**：`tool_use` 输入收完（`tool_use_stop`）即执行只读且并发安全的工具，与模型尾部生成重叠以降低首工具延迟；流结束后结果直接复用不重复执行（权限只进一次），写工具、未知工具、JSON 非法仍走既有批次路径；max_tokens 与溢出重试前清空在途派发与遗留结果
- **结果路由修复（fix #102）**：`contextTokens` 接进 `routeTask`（resume 大上下文可命中 `easy-ctx>=14k→8b`）；输入 JSON 非法的 tool_use 补发 `tool_use` 事件以配对后续 `tool_result`；流结束缺 `finish_reason` 按不完整响应记 `stopReason=error`；请求侧工具集统一为 `activeRequestTools()`（`modeManager.filterTools(promptTools(tools))`），init 事件、请求 `tools`、system 工具目录三处同源，plan 模式下模型看不到 Write/Edit/Bash

- **Multi-provider fault tolerance**: Anthropic / OpenAI / local proxy are accessed through a unified layer, with `TUPIG_FAILOVER` chained degradation. Error classification lives in `services/errors.ts` (rate_limit / auth / context_too_long / overloaded / server / network / invalid_request); 429/529/5xx/disconnects trigger a switch, while 401 and business errors do not; `TUPIG_ROLE_MODELS` selects models by role
- **Retry backoff**: `callWithRetry` uses full-jitter backoff `rand(0, min(10s, 1s·2^n))`, and once the total budget `TUPIG_RETRY_BUDGET_MS` (default 60s) is exceeded it throws the last error; 401/403 throw immediately
- **Result semantics and truncation fidelity (fix #95/#96)**: error and interruption paths produce only a single `error` result, and `route.log` feedback records the real outcome; Anthropic `stop_reason=max_tokens` and OpenAI `finish_reason=length` enter the output-quota escalation retry (baseline follows `maxTokens`, ladder `[8192,16384,32768,65536]`, reporting an error only when exhausted)
- **failover state rollback (fix #97)**: before switching to the fallback when the primary source drops mid-stream, `fullText` / `toolBuffers` / early-dispatch leftovers and `events` are rolled back, and the assistant message contains only the fallback's full output
- **Fallback model wiring (fix #98)**: `config.fallbackModel` takes priority; when absent, the cloud model is resolved through the fallback provider (`TUPIG_CLOUD_MODEL` / `OPENAI_MODEL`, anthropic defaults to `claude-sonnet-4-20250514`), avoiding sending a local model name to the cloud and getting a 404
- **Ctrl+C interruption**: while a turn is in progress, SIGINT calls `interrupt()` (`interruptActiveTurn` active registry), the signal is fed into the LLM stream (`streamMessage` receives the signal), and in-flight tools abort via their per-call controller linkage (cancellation text, no PostToolUseFailure fired); `AbortError` does not switch to the fallback, finishing by firing `Stop(output=任务已中断)` and a single error result; when idle it flushes synchronously + exit(130), a second press forces exit
- **Streaming idle watchdog**: `withIdleWatchdog` wraps streaming consumption, and once the gap since the last content event exceeds the threshold (default 120s, overridable by `TUPIG_STREAM_IDLE_MS`, 0 disables) it throws 「流式响应空闲超时」 and reclaims the inner iterator; byte-level keepalives that produce no event do not reset the timer; errors are classified as network and reuse the existing retry/failover channels
- **Early streaming dispatch**: as soon as the `tool_use` input is complete (`tool_use_stop`), read-only concurrency-safe tools are executed, overlapping with the model's tail generation to reduce first-tool latency; after the stream ends results are reused directly without re-executing (permissions only run once), while write tools, unknown tools and invalid JSON still go through the existing batch path; in-flight dispatches and leftover results are cleared before max_tokens and overflow retries
- **Result routing fixes (fix #102)**: `contextTokens` is wired into `routeTask` (a resumed large context can hit `easy-ctx>=14k→8b`); a tool_use with invalid input JSON gets a `tool_use` event re-emitted to pair with the subsequent `tool_result`; a stream ending without `finish_reason` is recorded as `stopReason=error` for an incomplete response; the request-side tool set is unified as `activeRequestTools()` (`modeManager.filterTools(promptTools(tools))`), with the init event, request `tools` and the system tool catalog sharing one source, and in plan mode the model cannot see Write/Edit/Bash

### Hooks

- **TOFU 信任**：shell hook 首次触发询问，确认后写 `.tupigcode/hook-trust.json`（规则 hash 覆盖 event/matcher/command/timeout，任一变更重询）；拒绝不持久化，异常与超时 fail-closed；非 TTY 与 `TUPIG_HOOK_TRUST=0` 不打断；`/hooks` 查看、`/hooks clear` 清除、`/hooks reload` 手动重载，`/doctor` 列信任清单
- **信任询问输入解析（fix #101）**：`promptHookTrust` 复用审批的 `parseApprovalAnswer` 首行解析（粘贴 `y⏎杂散内容` 不误拒）；30s 超时显式移除 data/close/end 三处 stdin listener，不残留吞后续输入
- **并行执行与合并**：同事件多 handler 用 `Promise.all` 并行（总耗时约等于最慢者，单点异常隔离）。合并规则：block 任一为真即 block，message 不被后续覆盖；未 block 时取注册序第一个非空 message/replacement，additionalContext 拼接。并行下 block 不短路后续 handler。两处有意收紧（issue #70）：block 者未带 replacement 时不保留前面 handler 的 replacement；block 之后 handler 的 additionalContext 仍被收集，但 UserPromptSubmit 整体丢弃不注入
- **matcher 正则化**：`tool_name` 全串锚定正则 `^(?:p)$`（`Edit|Write` 命中两工具不误伤 MultiEdit），子串用 `.*X.*`，非法正则回退精确匹配；shell hooks.json 解析透传 `matcher.decision` / `matcher.modeTo`；TOFU `hashRule` 纳入 matcher 全字段
- **hooks.json 热加载**：shell hooks 按工厂注册，`submitMessage` 入口检测 mtime 变更才整批重载（文件未变零动作，删除即失效）；代码注册（`hookSystem.register`）不受重载影响；REPL `/hooks reload` 忽略 mtime 强制重载并打印数量
- **生命周期事件**：`Stop`（自然结束）、`SessionStart`（submitMessage 入口）、`PreCompact` + `PostCompact`（阈值梯度、溢出恢复、手动 /compact 三处压缩点）均已落地；压缩事件带 `source: manual|auto` 供 matcher 过滤，shell hooks.json 支持 `matcher.source`；hook 异常一律隔离不阻塞
- **UserPromptSubmit**：prompt 进模型前触发（mode 命令之后、init 之前）。`block`（exit 2 或 JSON block）拒绝本轮不发请求并输出原因；`additionalContext`（平铺 JSON 或 Claude Code `hookSpecificOutput` 嵌套）以独立 user 消息注入本轮上下文，多 hook 拼接不覆盖；`turnNumber` 为该条输入的 0-based 序号（`appStore.userPromptCount`，block 也递增）
- **Notification hook**：`permission_prompt`（`promptUserDecision` 弹问前 fire-and-forget，非 TTY 不 fire）与 `idle_prompt`（REPL 输入空闲，`TUPIG_IDLE_NOTIFY_MS` 默认 300s、0 关闭，prompt 布防 / line 重置 / 一轮一次）；`matcher.notificationType` 过滤，shell hooks.json 解析透传，TOFU hash 覆盖
- **PostToolUseFailure**：工具执行错误与超时（含 Bash 超时改为 reject 的真实失败语义）触发，携带 `output + durationMs`；校验失败与 doom 拒绝不触发
- **PostToolUse 带耗时**：hook 上下文含 `durationMs`（纯工具执行时间，不含权限询问与 PreToolUse），shell hook 经 stdin JSON 同步可见
- **PermissionResult**：allow/deny/always 决策后携带 `decision + ruleSource` 触发供审计，matcher 可按 decision 过滤
- **ModeChange**：`/plan`、`/act` 实际发生切换时携带 `modeFrom/modeTo` 触发（同模式不触发），matcher 可按 modeTo 过滤
- **PostRewind**：回滚成功后携带 `checkpointId + mode` 触发，失败不触发
- **PreClear/PostClear**：`/clear` 序列为 Pre hook → 重置状态 → Post hook，hook 异常隔离，重置失败原样上抛

- **TOFU trust**: a shell hook prompts on first trigger and, once confirmed, writes `.tupigcode/hook-trust.json` (the rule hash covers event/matcher/command/timeout, and any change re-prompts); a rejection is not persisted, exceptions and timeouts fail closed; non-TTY and `TUPIG_HOOK_TRUST=0` do not interrupt; `/hooks` to view, `/hooks clear` to clear, `/hooks reload` to reload manually, `/doctor` lists the trust entries
- **Trust-prompt input parsing (fix #101)**: `promptHookTrust` reuses the approval `parseApprovalAnswer` first-line parsing (pasting `y⏎杂散内容` is not wrongly rejected); on a 30s timeout it explicitly removes the data/close/end stdin listeners so nothing lingers to swallow later input
- **Parallel execution and merging**: multiple handlers on the same event run in parallel via `Promise.all` (total time ≈ the slowest, single-point exceptions isolated). Merge rules: if any block is truthy the result is blocked, and a message is not overwritten by later handlers; when not blocked, the first non-empty message/replacement in registration order is taken and additionalContext is concatenated. Under parallelism block does not short-circuit subsequent handlers. Two spots are intentionally tightened (issue #70): when the blocker carries no replacement, an earlier handler's replacement is not kept; additionalContext from handlers after the block is still collected, but the whole UserPromptSubmit is dropped and not injected
- **matcher regexification**: `tool_name` uses a full-string anchored regex `^(?:p)$` (an `Edit|Write` hit matches both tools without hurting MultiEdit), substrings use `.*X.*`, and an invalid regex falls back to exact matching; shell hooks.json parsing passes `matcher.decision` / `matcher.modeTo` through; the TOFU `hashRule` covers all matcher fields
- **hooks.json hot reload**: shell hooks are registered by factory, and the `submitMessage` entry point reloads the whole batch only when it detects an mtime change (zero action if the file is unchanged, deletion takes effect immediately); code registration (`hookSystem.register`) is unaffected by reload; REPL `/hooks reload` ignores mtime, forces a reload and prints the count
- **Lifecycle events**: `Stop` (natural end), `SessionStart` (submitMessage entry), `PreCompact` + `PostCompact` (threshold ladder, overflow recovery, manual /compact — the three compaction points) are all implemented; compaction events carry `source: manual|auto` for matcher filtering, shell hooks.json supports `matcher.source`; hook exceptions are always isolated and never block
- **UserPromptSubmit**: fires before the prompt reaches the model (after mode commands, before init). `block` (exit 2 or a JSON block) rejects the turn, sends no request and prints the reason; `additionalContext` (flat JSON or Claude Code's nested `hookSpecificOutput`) is injected as a standalone user message into this turn's context, concatenated across hooks without being overwritten; `turnNumber` is the 0-based index of that input (`appStore.userPromptCount`, incremented even when blocked)
- **Notification hook**: `permission_prompt` (fire-and-forget before `promptUserDecision` prompts, not fired on non-TTY) and `idle_prompt` (REPL input idle, `TUPIG_IDLE_NOTIFY_MS` default 300s, 0 disables, armed by prompt / reset by line / once per turn); filtered by `matcher.notificationType`, parsed and passed through by shell hooks.json, covered by the TOFU hash
- **PostToolUseFailure**: fired by tool execution errors and timeouts (including Bash timeouts turned into rejects with real failure semantics), carrying `output + durationMs`; validation failures and doom rejections do not fire it
- **PostToolUse with duration**: the hook context includes `durationMs` (pure tool execution time, excluding permission prompting and PreToolUse), synchronously visible to shell hooks via stdin JSON
- **PermissionResult**: after an allow/deny/always decision it fires with `decision + ruleSource` for auditing, and the matcher can filter by decision
- **ModeChange**: fires with `modeFrom/modeTo` when `/plan`, `/act` actually switch (not fired for the same mode), and the matcher can filter by modeTo
- **PostRewind**: fires with `checkpointId + mode` after a successful rollback, not fired on failure
- **PreClear/PostClear**: the `/clear` sequence is Pre hook → reset state → Post hook, hook exceptions are isolated, and a reset failure is rethrown as-is

### 工具执行与并行 / Tool Execution and Parallelism

- **并行批 fail-soft**：同批只读工具并发执行不被全局 `streaming` 互斥误伤（不安全项由 `partitionRuns` 独立成批，批间顺序执行天然互斥）；`mapWithConcurrency` 为 settled 语义，批内单任务异常只产生自己的 error tool_result 并触发 PostToolUseFailure，兄弟结果保留
- **写工具按文件分组并行**：带 `file_path` 的写（Write/Edit/MultiEdit）相邻项合并为写组批——同文件保序串行（组内逐项 fail-soft，前项失败不连坐），异文件组间并行（并发 `TUPIG_WRITE_CONCURRENCY`，默认 4）；批段间仍顺序，非写不安全项（Bash 等）保持独立成批
- **工具超时**：`withTimeout` 超时即 abort 本次调用的 controller 并附副作用提示（写类操作可能已部分落盘）；子代理内 tool.call 与主循环同享 `TOOL_TIMEOUT_MS`（含 `TUPIG_TOOL_TIMEOUT_MS` 覆盖），挂死工具超时返回 is_error tool_result 后任务继续；实现于 `engine/time.ts` 供两侧共用
- **工具结果语义（fix #99）**：工具返回 `isError` 或 `output.type=error` 时 `tool_result.is_error=true` 并触发 PostToolUseFailure，不按成功处理、不快照；流报错返回前 await 在途早期派发，events 与 toolResults 不脱钩
- **doom loop 批内去重（fix #100）**：同一批、同一轮内相同只读调用只计一次（轮界清批内集合），并行同参检索不受影响；detector 在 `submitMessage` 入口 reset，跨轮连续 ≥3 次同动作仍拦截
- **截断续取**：统一文案 `已截断 total=N，本次显示 x~y，用 offset=… 续取`（`truncation-hint`，unit 条/字符可配）；Grep 支持 `offset` 分页（越界返回「无更多结果」），WebFetch 按字符窗口 `offset` + `maxLength` 续取
- **Bash 输出裁剪**：超长输出 head+tail 双端保留（both 默认 60/40，`keep=head|tail` 单端），预算 `TUPIG_BASH_OUTPUT_CHARS`（默认 50000）可调；截断标注原始大小、省略量、keep 模式，预算内原样返回
- **auto-test**：`RunTests` 工具（默认集，只读），探测 `TUPIG_TEST_CMD` / npm test（跳过占位）/ pytest / cargo / go，失败输出回喂修复后复跑；超时 `TUPIG_TEST_TIMEOUT_MS`，输出尾部截断 4000 字符
- **工具延迟装载**：核心集（Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Question）与 `ToolSearch` 元工具常驻，其余（git / 测试 / 网页 / 子代理 / 仓库地图等）按需检索挂载，下一轮生效；`TUPIG_EXTRA_TOOLS` 显式指定与 MCP 工具保持常驻；`TUPIG_LAZY_TOOLS=0` 回退全量注入
- **模型主动压缩**：只读工具 CompactContext，阶段完成后模型自行请求折叠（focus 透传摘要）；QueryEngine 下一轮循环前执行压缩流水线（source=model，PreCompact/PostCompact 同步触发，`/context` 可见）

- **Parallel batches fail soft**: read-only tools in the same batch run concurrently without being hurt by the global `streaming` mutex (unsafe items are split into their own batches by `partitionRuns`, and sequential execution across batches is naturally mutually exclusive); `mapWithConcurrency` has settled semantics — an exception of a single task in a batch only produces its own error tool_result and triggers PostToolUseFailure, while sibling results are kept
- **Write tools are parallelized grouped by file**: writes carrying `file_path` (Write/Edit/MultiEdit) merge adjacent items into write-group batches — same file keeps order and runs serially (fail-soft per item within the group, a failed item does not take the rest down), different files run in parallel between groups (concurrency `TUPIG_WRITE_CONCURRENCY`, default 4); batch segments remain sequential, and non-write unsafe items (Bash, etc.) stay in their own batches
- **Tool timeout**: on timeout `withTimeout` aborts that call's controller and attaches a side-effect hint (write operations may already be partially on disk); inside a sub-agent, tool.call shares `TOOL_TIMEOUT_MS` with the main loop (including the `TUPIG_TOOL_TIMEOUT_MS` override), and a hung tool times out, returns an is_error tool_result, after which the task continues; implemented in `engine/time.ts` and shared by both sides
- **Tool result semantics (fix #99)**: when a tool returns `isError` or `output.type=error`, `tool_result.is_error=true` is set and PostToolUseFailure is triggered — not treated as success and not snapshotted; before returning on a stream error it awaits in-flight early dispatches, so events and toolResults never decouple
- **Doom-loop in-batch dedup (fix #100)**: within the same batch and the same turn, an identical read-only call is counted only once (the in-batch set is cleared at turn boundaries), and parallel same-argument retrievals are unaffected; the detector resets at the `submitMessage` entry point, and ≥3 consecutive identical actions across turns are still intercepted
- **Truncated continuation**: a unified message `已截断 total=N，本次显示 x~y，用 offset=… 续取` (`truncation-hint`, unit items/characters configurable); Grep supports `offset` paging (out of range returns 「无更多结果」), and WebFetch continues through the character window `offset` + `maxLength`
- **Bash output trimming**: overlong output keeps both head and tail (both keeps 60/40 by default, `keep=head|tail` keeps a single end), with an adjustable budget `TUPIG_BASH_OUTPUT_CHARS` (default 50000); truncation is annotated with the original size, the omitted amount and the keep mode, and within budget it is returned as-is
- **auto-test**: the `RunTests` tool (default set, read-only) probes `TUPIG_TEST_CMD` / npm test (skipping placeholders) / pytest / cargo / go, feeds the failure output back for a fix and re-runs; timeout `TUPIG_TEST_TIMEOUT_MS`, output tail truncated to 4000 characters
- **Lazy tool loading**: the core set (Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Question) and the `ToolSearch` meta-tool are always resident, while the rest (git / tests / web / sub-agents / repo map, etc.) are searched and mounted on demand and take effect on the next turn; `TUPIG_EXTRA_TOOLS` explicitly specified and MCP tools stay resident; `TUPIG_LAZY_TOOLS=0` falls back to injecting everything
- **Model-initiated compaction**: the read-only CompactContext tool lets the model request folding itself after a stage completes (focus passed through to the summary); QueryEngine runs the compaction pipeline before the next loop iteration (source=model, PreCompact/PostCompact fired in sync, visible in `/context`)

### 权限、审查与护栏 / Permissions, Review and Guardrails

- **三级 diff 审查**：每轮写操作聚合为结构化 diff（自研 LCS，上下文 3），REPL 全局 a/r/s → 文件 y/n/h/q → 块 y/n 三级判定；拒绝按文件回滚（同文件多次修改回到首次之前）；超大 diff 降级为仅文件级；`TUPIG_DIFF_REVIEW=0` 关闭。plan 模式改动暂存 `.tupigcode/staging/`，`/apply` 才落盘（越界条目拒绝，落盘前自动建 `before:apply` 检查点）
- **审批「总是允许」持久化**：审批 prompt `y/N/a`，选 `a` 推导模式（Bash 首词前缀如 `Bash(npm *)`、写工具按工具级）写入项目级 `.tupigcode/permissions.json`，后续同前缀自动放行；deny 规则、敏感路径、自修改面仍优先（敏感路径检查在规则链之前）；`/permissions [clear]` 查看与清除
- **审批 diff 预览**：ask 弹问时 Edit/Write 渲染真实变更（复用 LCS 三级审查的 mini 渲染，含新建/覆盖、diff 行着色），定位失败、内容无变化、其他工具回退 JSON 截断 500 字符
- **弹问串行化（issue #64）**：审批弹问与 hook 信任询问共用一把进程内锁，同一时刻只占一个 readline，后续并发调用按到达序排队，前一个 settle 后才提示下一个；非 TTY 快速拒绝不入队
- **风险分类器**：mutate 命令自动放行、系统敏感路径 deny、git push/publish 恒询问，判定入 trajectory
- **自修改面复审**：写 `.tupigcode/skills|mcp.json|config.json` 与 hooks 文件时绕过 allow 规则强制确认
- **写路径沙箱**：`TUPIG_SANDBOX_WRITE` 白名单 / `TUPIG_SANDBOX_DENY` 黑名单

- **Three-level diff review**: each turn's write operations are aggregated into a structured diff (in-house LCS, context 3), with three levels of decisions in the REPL — global a/r/s → per-file y/n/h/q → per-hunk y/n; a rejection rolls back by file (multiple edits to the same file return to before the first); oversized diffs degrade to file-level only; `TUPIG_DIFF_REVIEW=0` disables it. In plan mode changes are staged in `.tupigcode/staging/` and only written by `/apply` (out-of-scope entries are rejected, and a `before:apply` checkpoint is created automatically before writing)
- **Approval "always allow" persistence**: the approval prompt is `y/N/a`; choosing `a` derives a mode (Bash first-word prefix such as `Bash(npm *)`, write tools at tool level) and writes it to the project-level `.tupigcode/permissions.json`, after which the same prefix is auto-approved; deny rules, sensitive paths and the self-modification surface still take precedence (the sensitive-path check runs before the rule chain); `/permissions [clear]` views and clears
- **Approval diff preview**: when the ask prompt pops, Edit/Write render the real change (reusing the LCS three-level review's mini rendering, including create/overwrite and diff line coloring); on location failure, unchanged content, or other tools it falls back to JSON truncated to 500 characters
- **Prompt serialization (issue #64)**: approval prompts and hook trust prompts share one in-process lock, occupying a single readline at a time, with subsequent concurrent calls queued in arrival order and the next prompted only after the previous one settles; non-TTY quick rejections are not queued
- **Risk classifier**: mutate commands are auto-allowed, system sensitive paths are denied, git push/publish always prompt, and the verdict goes into the trajectory
- **Self-modification surface review**: writing `.tupigcode/skills|mcp.json|config.json` and hooks files bypasses allow rules and forces confirmation
- **Write-path sandbox**: `TUPIG_SANDBOX_WRITE` allowlist / `TUPIG_SANDBOX_DENY` denylist

### 会话与状态 / Sessions and State

- **会话恢复**：session / checkpoint 单命令回滚；自动快照（每轮与写类工具成功后，防抖 5s、上限 20 滚动，`TUPIG_AUTOSNAPSHOT=0` 关）；`/rewind [chat|code|all] [id]` 三档回卷（回对话 / 回代码 / 全回），跨进程续跑
- **检查点按名称回滚**：`/rewind` 参数为 id-or-label，id 精确优先，label 精确匹配（同名取最新），回滚消息标注匹配方式
- **SIGINT 同步落盘**：Ctrl+C / SIGTERM 同步落盘当前历史并打 `interrupted` 标记（空会话不写）；下次启动扫描孤儿会话打印「恢复：/resume \<id\>」提示；正常 turn 结束的保存不带标记自然清除，也可手动 `clearInterruptedFlag`；会话文件 temp+rename 原子写（中断不半写），sessionId 白名单校验拒绝含 `/` 的穿越 id
- **会话列表**：`/resume`（无 id）与 `/sessions` 统一行格式：id + 相对时间 + 条数 + 首条用户 prompt 预览（截断 60 字，空会话显示「无预览」占位），按 updatedAt 倒序
- **REPL 输入防重入（issue #86）**：line handler 持 `TurnGate` 门闩，turn 进行中的行直接丢弃；审批弹问的裸 stdin 监听与 readline 共挂同一输入流，一次 y⏎ 双路分发不再产生幻影 prompt 或并发 query
- **知识沉淀**：memory（长期记忆）、skills（技能库，`.tupigcode/skills/` 先审后存）、reflexion（反思入库）
- **内置技能包（10 个）**：git-workflow / git-log / gitingest / shell-command-engager / code-review / debugging / test-first / docs-sync / release-check / refactor-safe，`src/knowledge/skills/` 静态装载（build 拷贝到 dist），用户 `.tupigcode/skills/` 同名覆盖、无效回落内置，三重门禁与 3000 字目录预算对内置同样生效

- **Session recovery**: session / checkpoint rollback in a single command; automatic snapshots (after every turn and after a successful write tool, 5s debounce, rolling cap of 20, `TUPIG_AUTOSNAPSHOT=0` disables); `/rewind [chat|code|all] [id]` with three rewind levels (conversation / code / all), resumable across processes
- **Checkpoint rollback by name**: the `/rewind` argument is id-or-label — exact id first, then exact label match (newest wins for duplicates), with the rollback message noting which matched
- **SIGINT synchronous flush**: Ctrl+C / SIGTERM flushes the current history synchronously and sets the `interrupted` flag (not written for empty sessions); the next startup scans orphan sessions and prints the 「恢复：/resume \<id\>」 hint; a save at the end of a normal turn carries no flag and clears it naturally, and `clearInterruptedFlag` can also be called manually; session files are written atomically with temp+rename (an interruption never leaves a half write), and a sessionId whitelist check rejects traversal ids containing `/`
- **Session list**: `/resume` (no id) and `/sessions` share one row format — id + relative time + count + a preview of the first user prompt (truncated to 60 chars, empty sessions show the 「无预览」 placeholder), sorted by updatedAt descending
- **REPL input re-entrancy guard (issue #86)**: the line handler holds a `TurnGate` latch and drops lines arriving while a turn is in progress; the approval prompt's raw stdin listener and readline are attached to the same input stream, so one y⏎ is dispatched to both paths without producing phantom prompts or concurrent queries
- **Knowledge deposition**: memory (long-term memory), skills (skill library, review-then-store in `.tupigcode/skills/`), reflexion (reflections written back)
- **Built-in skill pack (10)**: git-workflow / git-log / gitingest / shell-command-engager / code-review / debugging / test-first / docs-sync / release-check / refactor-safe, loaded statically from `src/knowledge/skills/` (copied to dist by the build), user `.tupigcode/skills/` entries with the same name override and invalid ones fall back to the built-ins, the triple gate and the 3000-character catalog budget apply to built-ins too

### MCP

- **接入**：`.tupigcode/mcp.json`（Claude Code 兼容）接入外部 MCP server，工具桥接为 `mcp_<server>_<tool>`，桥接工具直接采用 server 声明的 `inputSchema`，单 server 失败降级不阻塞
- **双重审批**：server/tool 级 `approval` 白名单 + `TUPIG_MCP_APPROVAL=off|ask` 全局开关，未配置时按 mcp.json 白名单与 readOnlyHint 分级
- **ToolAnnotations**：`readOnlyHint` → 只读分级；显式 `destructiveHint=true` 且非只读时审批升为 ask 强制确认（deny 优先、allow 被覆盖）；`title` 进 description 展示
- **list_changed 动态刷新**：server 发 `notifications/tools/list_changed` 或手动 `refresh()` 时重拉 tools/list，diff 出增删与同名定义变更（description / schema / annotations 签名比较），变更即同步工具集与搜索池，刷新失败保留旧工具只告警
- **白名单过滤**：`includeTools` / `excludeTools`（MCP 原始名白/黑名单，exclude 优先），首连与 list_changed 重拉共用
- **远程传输与 OAuth**：`url` + `transport: http|sse` + `headers`，`oauth:false` 关闭；`FileOAuthProvider` 本地回调收 code 后 `finishAuth` 自动重连，tokens 落 `~/.tupigcode/mcp-auth/`；`states` 暴露 connected/failed/needs_auth
- **超时与断线自愈**：`mcp.json` 每 server 可配 `timeout`（毫秒，callTool 单次超时）；stdio 断开立即摘除该 server 的死工具，指数退避自动重连（1s→2s→…→30s 封顶，最多 5 次，同 server 不并发叠加），成功恢复工具，耗尽告警放弃，connection close 后不再重连

- **Integration**: `.tupigcode/mcp.json` (Claude Code compatible) connects external MCP servers and bridges their tools as `mcp_<server>_<tool>`; bridged tools adopt the `inputSchema` declared by the server, and a single server failure degrades without blocking
- **Dual approval**: server/tool level `approval` allowlist + the `TUPIG_MCP_APPROVAL=off|ask` global switch; when not configured, grading follows the mcp.json allowlist and readOnlyHint
- **ToolAnnotations**: `readOnlyHint` → read-only grading; when `destructiveHint=true` is explicit and the tool is not read-only, approval is escalated to ask for forced confirmation (deny wins, allow is overridden); `title` goes into the description display
- **list_changed dynamic refresh**: when the server emits `notifications/tools/list_changed` or `refresh()` is called manually, tools/list is re-fetched and the diff reports additions/removals and same-name definition changes (signature comparison of description / schema / annotations); any change syncs the tool set and search pool immediately, and a failed refresh keeps the old tools and only warns
- **Allowlist filtering**: `includeTools` / `excludeTools` (MCP raw-name allow/deny lists, exclude wins), shared by the first connection and list_changed re-fetches
- **Remote transport and OAuth**: `url` + `transport: http|sse` + `headers`, turned off with `oauth:false`; `FileOAuthProvider` receives the code on the local callback and `finishAuth` reconnects automatically, with tokens stored in `~/.tupigcode/mcp-auth/`; `states` exposes connected/failed/needs_auth
- **Timeout and disconnect self-healing**: in `mcp.json` each server can configure `timeout` (milliseconds, per-callTool timeout); when stdio drops, that server's dead tools are removed immediately and exponential-backoff reconnection kicks in (1s→2s→…→30s cap, at most 5 attempts, no concurrent stacking for the same server), tools are restored on success, and after exhaustion it warns and gives up — no reconnection after connection close

### 工作模式与观测 / Work Modes and Observability

- **工作模式**：plan / act 双模式 + spec 规格驱动开发（`n8-spec`）
- **工程护栏**：`/doctor` 自诊断、`/init` 项目初始化、`/review` 代码评审（沙箱、权限、hooks 细节见上文对应子节）
- **wire.jsonl 原始报文**：`TUPIG_WIRE=1` 开启（默认关，零开销）——pilot 侧 `streamMessage` 记录请求与流式合并后正文，proxy 侧透传观测，JSONL 落 `.tupigcode/wire.jsonl`（`TUPIG_WIRE_FILE` / `TUPIG_WIRE_MAX_BYTES` 可调，默认 5MB 滚动裁剪），request/response 共享 `req_id`

- **Work modes**: plan / act dual modes + spec-driven development (`n8-spec`)
- **Engineering guardrails**: `/doctor` self-diagnosis, `/init` project initialization, `/review` code review (sandbox, permissions and hooks details in the corresponding subsections above)
- **wire.jsonl raw frames**: enabled by `TUPIG_WIRE=1` (off by default, zero overhead) — on the pilot side `streamMessage` records the request and the post-stream-merge body, the proxy side passes frames through for observation, JSONL is written to `.tupigcode/wire.jsonl` (`TUPIG_WIRE_FILE` / `TUPIG_WIRE_MAX_BYTES` adjustable, default 5MB rolling trim), request/response share `req_id`

## gameqa — Unity 自动化测试平台 / gameqa — Unity Automated Testing Platform

跨环境（Mac / Linux / Windows / iOS / Android）的 Unity3D 游戏自动化测试编排与结果收集，
`data/` 数据格式与原 gpt-visual-platform（Go server + Rust agent）完全兼容；原蓝本文档已删，历史见 git。

Cross-environment (Mac / Linux / Windows / iOS / Android) Unity3D game automated test orchestration and result collection;
the `data/` data format is fully compatible with the original gpt-visual-platform (Go server + Rust agent); the original
blueprint document has been deleted, see git for history.

### 任务类型（Agent 侧，`extra.job_type`） / Task Types (Agent side, `extra.job_type`)

| job_type | 执行内容 |
| --- | --- |
| （缺省）/ `generate_and_run` | Unity batchmode 真执行：`-runTests -testPlatform PlayMode/EditMode -testResults xml`，解析 NUnit3 XML。`generate_and_run` 先把 `extra.generated_test_csharp` 写入 `Assets/Tests/Generated/` 再带 `-testFilter Generated` 执行（默认执行后清理，`extra.keep_generated` 保留） |
| `use_mcp: true` | 直连 Unity MCP `/tools/run_tests` |
| `self_check` | Agent 环境自检 |
| `airtest` | Airtest CLI 跑 `.air` 图像识别脚本（Android/Windows 设备 URI） |
| `ai_exploratory` | 视觉大模型「截图 → 决策 → 执行」循环（Android；动作校验防 shell 注入） |
| `game_perf` | 帧率/卡顿/内存采样 + 阈值断言（dumpsys gfxinfo / meminfo） |
| `unity_log_scan` | Unity Player.log 错误/异常扫描（阈值 `max_errors`） |
| `device_inventory` | ADB 设备清单（型号/版本/分辨率/电量） |

English summary: (default) / `generate_and_run` runs real Unity batchmode (`-runTests -testPlatform PlayMode/EditMode -testResults xml`) and parses NUnit3 XML, with `generate_and_run` first writing `extra.generated_test_csharp` into `Assets/Tests/Generated/` and then executing with `-testFilter Generated` (cleaned up after execution by default, kept with `extra.keep_generated`); `use_mcp: true` talks directly to Unity MCP `/tools/run_tests`; `self_check` is the Agent environment self-check; `airtest` runs `.air` image-recognition scripts via the Airtest CLI (Android/Windows device URI); `ai_exploratory` is the vision-model 「截图 → 决策 → 执行」 loop (Android, action validation guards against shell injection); `game_perf` samples frame rate/jank/memory with threshold assertions (dumpsys gfxinfo / meminfo); `unity_log_scan` scans Unity Player.log for errors/exceptions (threshold `max_errors`); `device_inventory` lists ADB devices (model/version/resolution/battery).

### 内置执行器（服务端，`platform=web`，无需 Agent） / Built-in Executors (server side, `platform=web`, no Agent)

`web_check`（网站可用性）/ `api_check`（接口断言）/ `api_load`（k6 式性能冒烟）/
`api_flow`（多步接口流程）/ `self_check` / `port_check` / `cert_check` / `dns_check`；
`extra.repeat_minutes` 开启循环监控（蓝本的断链 bug 已修，服务端 worker 直读 `extra`）。

`web_check` (website availability) / `api_check` (API assertions) / `api_load` (k6-style performance smoke) /
`api_flow` (multi-step API flow) / `self_check` / `port_check` / `cert_check` / `dns_check`;
`extra.repeat_minutes` enables loop monitoring (the blueprint's broken-chain bug is fixed, the server worker reads `extra` directly).

### 结果解析与报告 / Result Parsing and Reports

NUnit3 结果解析保留全量用例明细（`summary.cases`，含 classname/duration/message/stack/stdout，上限 2000 条、单字段 4KB）。两个报告出口：`GET /report` 轻量单文件（汇总卡片 + 近 20 次通过率 SVG 趋势 + 历史表）、`GET /allure?job=N` Allure 风格报告（Overview/Suites/Categories 三个 tab + 用例树与失败详情 + 历史切换，无外部依赖）。

NUnit3 result parsing keeps the full case details (`summary.cases`, including classname/duration/message/stack/stdout, capped at 2000 entries and 4KB per field). Two report outlets: `GET /report`, a lightweight single file (summary cards + a pass-rate SVG trend of the last 20 runs + history table), and `GET /allure?job=N`, an Allure-style report (Overview/Suites/Categories three tabs + case tree and failure details + history switching, no external dependencies).

### 服务端 API（31 路由） / Server API (31 Routes)

注册 / 心跳 / 领任务（`GET /api/jobs/poll/{platform}`）/ 结果上报（3 次重试，poll 只认 pending）/
产物上传（截尾 64KB，`ARTIFACT_MAX_BYTES`）/ 任务 CRUD / 取消 / Agent 列表 / 技能表 /
MCP 代理 / OpenAI 用例生成 / Webhook 通知 / 看板静态资源；可选 `X-Platform-Token` 认证（`PLATFORM_TOKEN`）。

Registration / heartbeat / task pickup (`GET /api/jobs/poll/{platform}`) / result reporting (3 retries, poll only accepts pending) /
artifact upload (truncated at 64KB, `ARTIFACT_MAX_BYTES`) / task CRUD / cancel / agent list / skill table /
MCP proxy / OpenAI case generation / Webhook notification / dashboard static assets; optional `X-Platform-Token` authentication (`PLATFORM_TOKEN`).

### 关键环境变量 / Key Environment Variables

| 变量 | 侧 | 说明 |
| --- | --- | --- |
| `PORT` / `DATA_DIR` / `STATIC_DIR` | serve | 端口（默认 9111）/ 数据目录 / 看板目录（缺省自动定位） |
| `GAMEQA_HOST` | serve | 监听地址（默认 `127.0.0.1` 仅环回；跨机访问须设 `0.0.0.0`） |
| `GAMEQA_INSECURE` | serve | `1` = 豁免「非环回必须带 `PLATFORM_TOKEN`」启动闸（仅限可信内网） |
| `TLS_MODE` | serve | `auto`（自签名/用户证书，默认）\| `off`（明文，仅限可信内网） |
| `TLS_CERT` / `TLS_KEY` | serve | 用户证书（优先；自签名存 `data/tls/`，跨重启复用，key 0600） |
| `PLATFORM_TOKEN` | serve | `X-Platform-Token` 认证（覆盖 `/api/*` 与 `/report` `/allure`）；`GAMEQA_HOST` 非环回时必设 |
| `STALE_MINUTES` | serve | running 任务超时判 Agent 失联标失败（默认 30） |
| `PLATFORM_URL` | agent | 编排服务地址（默认 `http://localhost:9111`） |
| `AGENT_ID` / `AGENT_SKILLS` / `AGENT_WORKDIR` | agent | 标识 / 技能（逗号分隔，任务 `required_skills` 须为其子集）/ 工作目录 |
| `PLATFORM_INSECURE_TLS` | agent | `1` = 信任自签名服务端；或 `PLATFORM_TLS_CERT=<cert.pem>` 指定 CA |
| `UNITY_PATH` | agent | Unity 可执行文件（缺省探测 Unity Hub 最高版本 / PATH） |
| `GAMEQA_SAFE_PATHS` | agent | 可选：`extra.log_path` 路径白名单（冒号/逗号分隔多前缀）；未设置 = 不限制（fix #126） |
| `AGENT_UNITY_ROOTS` | agent | 可选：`unity_project_path` 路径白名单（冒号/逗号分隔多前缀）；未设置 = 不限制（fix #126） |
| `ADB_PATH` / `ANDROID_SERIAL` | agent | adb 可执行覆盖 / 默认设备序列号 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_VISION_MODEL` | agent | `ai_exploratory` 视觉模型 |

English summary: on the serve side, `PORT` / `DATA_DIR` / `STATIC_DIR` are the port (default 9111) / data directory / dashboard directory (auto-located when absent), `GAMEQA_HOST` is the listen address (default `127.0.0.1`, loopback only; set `0.0.0.0` for cross-machine access), `GAMEQA_INSECURE=1` waives the "non-loopback must carry `PLATFORM_TOKEN`" startup gate (trusted LAN only), `TLS_MODE` is `auto` (self-signed/user certificate, default) | `off` (plaintext, trusted LAN only), `TLS_CERT` / `TLS_KEY` are the user certificate (preferred; self-signed is stored in `data/tls/` and reused across restarts, key 0600), `PLATFORM_TOKEN` enables `X-Platform-Token` auth (covers `/api/*` and `/report` `/allure`) and is required when `GAMEQA_HOST` is non-loopback, `STALE_MINUTES` marks a running task failed as Agent-lost on timeout (default 30); on the agent side, `PLATFORM_URL` is the orchestration service address (default `http://localhost:9111`), `AGENT_ID` / `AGENT_SKILLS` / `AGENT_WORKDIR` are the identity / skills (comma-separated, the task's `required_skills` must be a subset) / working directory, `PLATFORM_INSECURE_TLS=1` trusts the self-signed server or `PLATFORM_TLS_CERT=<cert.pem>` specifies the CA, `UNITY_PATH` is the Unity executable (probes the highest Unity Hub version / PATH by default), `GAMEQA_SAFE_PATHS` / `AGENT_UNITY_ROOTS` are optional colon/comma-separated path-prefix whitelists for `extra.log_path` / `unity_project_path` (unset = unrestricted), `ADB_PATH` / `ANDROID_SERIAL` override the adb executable / default device serial, and `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_VISION_MODEL` configure the `ai_exploratory` vision model.

### 运维脚本与部署 / Operations Scripts and Deployment

```bash
./scripts/e2e.sh              # 全链路冒烟（HTTPS + Agent + 内置执行器 + 取消/删除 + 落盘）
./scripts/start.sh            # 前台启动（已注册系统服务则转 launchd/systemd）
./scripts/install-service.sh  # 注册开机自启（macOS launchd / Linux systemd）
./scripts/stop.sh / status.sh / uninstall-service.sh / trust-cert-macos.sh
```

## MLX 本地推理 + 协议代理 / MLX Local Inference + Protocol Proxy

Apple M4 上跑本地大模型，架构：

Running local large models on an Apple M4, the architecture:

```
CLI（llm / *-local / 任意 OpenAI/Anthropic 客户端）
   → :4100  TS 统一协议代理（src/proxy/，三协议互转）
      → :8080  mlx_lm.server（MLX 推理）
```

- **llm**：`llm start|stop|status|doctor`（服务生命周期）、`llm use 8b`（切模型，`mlx/models.json` 管清单）、`llm "问题"`（直连对话）
- **mlx-local 全命令**：`start [模型]` / `restart [模型]` / `stop` / `status` / `logs server|proxy` / `healthcheck` / `model list|info` / `metrics`
- **代理三协议**：`/v1/chat/completions`（OpenAI Chat）、`/v1/responses`（OpenAI Responses）、`/v1/messages`（Anthropic Messages）互转（`src/proxy/convert.ts`），后端统一 `mlx_lm.server`；流式自动注入 `stream_options.include_usage`，三协议末事件均透传 token usage；`:4100` 对外，`:8080` 仅本地内部调用
- **客户端接入**：`opencode-local` / `claude-local` / `codex-local` 三个 shim 已配好本机 provider；配到别的工具只需把 base URL 指到 `:4100`
- 模型目录 `mlx/models/`、虚拟环境 `mlx/venv/`、日志与状态均运行时生成（gitignore）

- **llm**: `llm start|stop|status|doctor` (service lifecycle), `llm use 8b` (switch model, `mlx/models.json` manages the list), `llm "问题"` (direct chat)
- **mlx-local full commands**: `start [模型]` / `restart [模型]` / `stop` / `status` / `logs server|proxy` / `healthcheck` / `model list|info` / `metrics`
- **Proxy three protocols**: `/v1/chat/completions` (OpenAI Chat), `/v1/responses` (OpenAI Responses), `/v1/messages` (Anthropic Messages) are converted into each other (`src/proxy/convert.ts`), with the backend uniformly `mlx_lm.server`; streaming automatically injects `stream_options.include_usage` and all three protocols pass token usage through in the final event; `:4100` is the external port, `:8080` is for local internal calls only
- **Client integration**: the three shims `opencode-local` / `claude-local` / `codex-local` are already configured with the local provider; to use other tools just point the base URL at `:4100`
- The model directory `mlx/models/`, virtual environment `mlx/venv/`, logs and state are all generated at runtime (gitignore)

### 模型清单（`mlx/models.json`） / Model List (`mlx/models.json`)

| 别名 | 模型 | 大小 | 定位 |
| --- | --- | --- | --- |
| `14b` | Qwen3-14B-4bit | 7.8G | 默认，性能均衡 |
| `8b` | Qwen3-8B-4bit | 4.3G | 轻量快速 |
| `30b` | Qwen3-Coder-30B-A3B-Instruct-4bit | 16G | 代码专精，需提高 GPU 上限 |
| `qwen-vl-8b` | Qwen3-VL-8B-Instruct-4bit | 5.5G | 视觉语言模型 |

English summary: `14b` = Qwen3-14B-4bit, 7.8G, the default with balanced performance; `8b` = Qwen3-8B-4bit, 4.3G, lightweight and fast; `30b` = Qwen3-Coder-30B-A3B-Instruct-4bit, 16G, code-specialized and needs a raised GPU limit; `qwen-vl-8b` = Qwen3-VL-8B-Instruct-4bit, 5.5G, a vision-language model.

> [!WARNING]
> 24GB 内存机器 GPU 上限约 16GB：30B 模型需调高 MLX GPU 上限；超长上下文（5 万+ token）请求可能 OOM，长任务建议切云端 Provider（`TUPIG_PROVIDER`）。

> [!WARNING]
> On a 24GB-memory machine the GPU limit is about 16GB: the 30B model needs the MLX GPU limit raised; very long context (5 万+ token) requests may OOM, and long tasks are better served by switching to a cloud Provider (`TUPIG_PROVIDER`).

## 项目结构 / Project Structure

```
tupigcode/
├── AGENTS.md                  # AI 协作约定（工作流/issue 闭环/README 维护规则）
├── README.md                  # 本文件——项目唯一文档，随代码同步更新
├── package.json               # 7 bin + 构建/开发脚本
├── scripts/                   # gameqa 运维：e2e/start/stop/status/install-service…
│
├── src/
│   ├── index.ts               # CLI 入口（配置走环境变量，无配置文件读取）
│   ├── engine/                # 主链路：QueryEngine prompt tool-registry router harness mcp
│   ├── tools/                 # 20+ 工具实现
│   ├── services/              # api bash-safety permissions sandbox failover errors
│   ├── session/               # session session-state checkpoint trajectory
│   ├── context/               # compact rules repomap
│   ├── knowledge/             # memory skills reflexion
│   ├── modes/                 # plan/act + spec
│   ├── agents/                # 子代理
│   ├── commands/              # /doctor /init /review + REPL
│   ├── proxy/                 # 统一协议代理（convert 三协议转换 + server SSE relay）
│   ├── gameqa/                # Unity 测试平台（store/server/builtin/agent/unity/
│   │                          #   airtest/gameperf/ai/tls + report/allure 报告 + static 看板）
│   ├── cli/                   # 7 个入口（tupigcode llm gameqa *-local mlx-local）
│   └── git/ state/ utils/
│
├── tests/                     # vitest 131 文件 / 1126 用例，按子域分 14 目录
│   ├── engine/ context/ routing/ hooks/ tools/ session/ permission/
│   ├── mcp/ execution/ knowledge/ prompt/ commands/
│   └── gameqa/ proxy/ fixtures/
├── mlx/                       # 推理服务层（models/venv/logs/state 运行时 + models.json）
├── .tupigcode/                # 运行时技能库（先审后存）
└── .github/                   # workflows/ci.yml 统一 CI：build → type-check-test → codeql 串行链
                               #   actions/setup-node-npm 复用（Node 22 + npm 缓存 + npm ci）
```

## 配置与环境变量 / Configuration and Environment Variables

### tupigcode / 引擎 / tupigcode / Engine

| 变量 | 说明 |
| --- | --- |
| `TUPIG_PROVIDER` / `TUPIG_MODEL` | Provider（`anthropic` / `openai` / `proxy`…）与模型 |
| `TUPIG_CLOUD_MODEL` / `TUPIG_ROLE_MODELS` | 云端模型 / 按角色（读码、改码…）分模型 |
| `TUPIG_MAX_CONTEXT_TOKENS` | 上下文窗口 30_000 ~ 10_000_000，自适应压缩迭代 |
| `TUPIG_FAILOVER` | Provider 链式降级 |
| `TUPIG_SANDBOX_WRITE` / `TUPIG_SANDBOX_DENY` | 写沙箱白名单 / 黑名单 |
| `TUPIG_MCP_APPROVAL` | MCP 审批全局开关：`off`=全部放行 / `ask`=全部强制询问（未设置=按 mcp.json 白名单与 readOnlyHint 分级） |
| `TUPIG_HOOKS_FILE` / `TUPIG_HOOKS_FAIL_OPEN` | hooks 配置 / 失败是否放行 |
| `TUPIG_IDLE_NOTIFY_MS` | REPL 输入空闲 Notification 阈值（默认 300000，0 关闭） |
| `TUPIG_BASH_OUTPUT_CHARS` | Bash 输出裁剪预算（默认 50000，正整数） |
| `TUPIG_WRITE_CONCURRENCY` | 写组并行度（默认 4，1~16；同文件仍保序串行） |
| `TUPIG_HARNESS` / `TUPIG_DEBUG` / `TUPIG_MOCK` / `TUPIG_PROMPT_OPT` / `TUPIG_EXTRA_TOOLS` | harness、调试、Mock、prompt 优化、额外工具 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 云端 Provider 凭证（可选） |

English summary: `TUPIG_PROVIDER` / `TUPIG_MODEL` set the provider (`anthropic` / `openai` / `proxy`…) and model; `TUPIG_CLOUD_MODEL` / `TUPIG_ROLE_MODELS` are the cloud model and per-role (read code, edit code, …) models; `TUPIG_MAX_CONTEXT_TOKENS` is the context window 30_000 ~ 10_000_000 with adaptive compaction iteration; `TUPIG_FAILOVER` is chained provider failover; `TUPIG_SANDBOX_WRITE` / `TUPIG_SANDBOX_DENY` are the write-sandbox allowlist / denylist; `TUPIG_MCP_APPROVAL` is the MCP approval global switch (`off` = allow all / `ask` = always ask; unset = graded by the mcp.json allowlist and readOnlyHint); `TUPIG_HOOKS_FILE` / `TUPIG_HOOKS_FAIL_OPEN` are the hooks config / whether failure fails open; `TUPIG_IDLE_NOTIFY_MS` is the REPL idle Notification threshold (default 300000, 0 disables); `TUPIG_BASH_OUTPUT_CHARS` is the Bash output trimming budget (default 50000, positive integer); `TUPIG_WRITE_CONCURRENCY` is write-group parallelism (default 4, 1~16; same file still stays ordered and serial); `TUPIG_HARNESS` / `TUPIG_DEBUG` / `TUPIG_MOCK` / `TUPIG_PROMPT_OPT` / `TUPIG_EXTRA_TOOLS` are harness, debug, Mock, prompt optimization and extra tools; `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` are optional cloud Provider credentials.

### MLX / 代理 / MLX / Proxy

| 变量 | 说明 |
| --- | --- |
| `MLX_HOME` / `MLX_VENV` / `MLX_LOGS` / `MLX_STATE` | MLX 根目录/虚拟环境/日志/状态 |
| `MLX_MODELS` / `MLX_MODEL` / `MLX_DEFAULT_MODEL` | 模型清单 / 当前模型 / 默认模型 |
| `MLX_SERVER_PORT` / `MLX_UNIFIED_PORT` | 后端推理端口（8080）/ 统一代理端口（4100） |
| `MLX_BACKEND` / `MLX_AUTH_TOKEN` / `MLX_REQUEST_TIMEOUT` | 后端选择 / 鉴权 / 超时 |

English summary: `MLX_HOME` / `MLX_VENV` / `MLX_LOGS` / `MLX_STATE` are the MLX root directory / virtualenv / logs / state; `MLX_MODELS` / `MLX_MODEL` / `MLX_DEFAULT_MODEL` are the model list / current model / default model; `MLX_SERVER_PORT` / `MLX_UNIFIED_PORT` are the backend inference port (8080) / unified proxy port (4100); `MLX_BACKEND` / `MLX_AUTH_TOKEN` / `MLX_REQUEST_TIMEOUT` configure backend selection / authentication / timeout.

gameqa 环境变量见上文 [gameqa 节](#gameqa--unity-自动化测试平台)。

See the [gameqa section](#gameqa--unity-自动化测试平台) above for gameqa environment variables.

## 开发流程（PROCESS） / Development Process (PROCESS)

每个功能单元走完六步，不允许跳步：

Each feature unit goes through six steps, skipping steps is not allowed:

```
① 调研 → ② 测试（先写测试，必须红） → ③ 落盘（最小实现转绿）
      → ④ 审查 → ⑤ 全量回归 → ⑥ 验收
```

| 步 | 出口条件 |
| --- | --- |
| ① 调研 | 读本仓代码 + git 历史 + 同类开源实现，边界写清 |
| ② 测试 | 测试文件落盘，跑一次确认按预期红——没有测试不许改代码 |
| ③ 落盘 | 相关用例绿；只改本功能代码 |
| ④ 审查 | 正确性/边界/错误路径/安全（注入、路径逃逸、命令盲执行）/无死代码；边界用例以独立于实现的预期行为写成测试（不复刻实现，红了先质疑测试再质疑实现）；发现的问题按下方 Issue 流程先上报再修，审查点进提交信息 |
| ⑤ 回归 | `npx tsc --noEmit` + `npx vitest run` 全绿 |
| ⑥ 验收 | AC 全过才算完成 |

English summary: ① 调研 (research) — read this repo's code + git history + similar open-source implementations, write the boundaries clearly; ② 测试 (test) — land the test file first and run it once to confirm it goes red as expected, no code changes without a test; ③ 落盘 (land) — related cases go green, change only this feature's code; ④ 审查 (review) — correctness/boundaries/error paths/security (injection, path escape, blind command execution)/no dead code, boundary cases written as tests asserting expected behavior independent of the implementation (do not replicate the implementation; when red, question the test before the implementation), issues found are reported via the Issue workflow below before being fixed and review points go into the commit message; ⑤ 回归 (regression) — `npx tsc --noEmit` + `npx vitest run` all green; ⑥ 验收 (acceptance) — done only when all ACs pass.

### Bug / 优化 · Issue 强制流程 / Bug / Optimization · Mandatory Issue Workflow

本地发现的任何 bug 或优化点，先上报 GitHub issue 再动手修：

Any bug or optimization point found locally is first reported as a GitHub issue before fixing:

1. `gh issue create` 上报（现象/根因/影响面/复现）——无 issue 不许改代码
2. 修复提交必须引用 issue 号：`fix #<N>: ...`
3. 回归全绿 + 推送后 CI 绿 → `gh issue close <N>`（留一句修复摘要）

1. report it with `gh issue create` (symptom/root cause/impact/repro) — no issue, no code change
2. the fix commit must reference the issue number: `fix #<N>: ...`
3. regression all green + CI green after pushing → `gh issue close <N>` (leave a one-line fix summary)

历史 bug 查询：`gh issue list --state all`；过往决策用 `git log`。工作区不留待办文档。

For historical bugs: `gh issue list --state all`; for past decisions use `git log`. No to-do documents are left in the working tree.

### 提交信息规范 / Commit Message Conventions

前缀对齐 `git log` 实际口径：`fix`（修 bug，正文必须带 `fix #<N>` 引用 issue）、`feat`（新功能）、`chore`（工程杂务、依赖、配置）、`docs`（文档）、`test`（测试）。审查要点写进提交信息正文。

Prefixes match the actual `git log` convention: `fix` (fix a bug, the body must carry a `fix #<N>` issue reference), `feat` (new feature), `chore` (engineering chores, dependencies, configuration), `docs` (documentation), `test` (tests). Review points are written into the commit message body.

## 测试与 CI / Tests and CI

```bash
 npm test              # = npx vitest run，131 文件 / 1126 用例
 npx tsc --noEmit      # 类型门槛
 npm run build         # 构建门槛（含 gameqa 静态资源拷贝 + 入口 chmod）
 ```

**目录结构**（按子域分，`vitest.config.ts` 的 `tests/**` 递归匹配，分目录无需改配置）：

**Directory structure** (split by subdomain, matched recursively via `tests/**` in `vitest.config.ts`, no config change needed for the split):

| 目录 | 覆盖 |
| --- | --- |
| `engine/` | 跨域回归与冒烟：端到端、防卡死、wire 报文、深度审查批次、issue 清理、死常量接线、子代理、harness、`smoke` |
| `context/` | 压缩（阈值梯子/熔断/线索/模型主动）、token 估算、prompt cache、lineage、上下文溢出、10M 窗口 |
| `routing/` | provider 抽象、错误分类、failover、重试预算、路由分流、兜底模型 |
| `hooks/` | 生命周期事件、matcher 正则、TOFU 信任、热加载、并行合并、失败/耗时/权限/模式 hook |
| `tools/` | 文件编辑（模糊回退/MultiEdit）、检索（Grep/Glob/RepoMap）、Bash 裁剪、auto-test、工具延迟装载 |
| `session/` | 会话持久化、检查点、rewind、resume、SIGINT 落盘、轨迹治理、REPL 输入防重入 |
| `permission/` | 三级 diff 审查、审批持久化与预览、沙箱、敏感路径 |
| `mcp/` | MCP 客户端、双重审批、ToolAnnotations、动态刷新、超时重连、HTTP/OAuth |
| `execution/` | 并行批 fail-soft、写组按文件并行、流式早期派发与看门狗、doom 去重 |
| `knowledge/` | 记忆、技能（内置包/披露预算）、反思写回 |
| `prompt/` | 系统提示渲染、提示优化、询问串行化 |
| `commands/` | CLI 启动器、`/todo` `/spec` `/diag`、运行参数接线 |
| `gameqa/` | 编排服务、存储、内置执行器、Unity 真执行全链路、airtest·性能·AI 集成、TLS·CLI、轻量报告、Allure 报告 |
| `proxy/` | 三协议转换、SSE relay、流式 usage 透传 |

English summary: the 14 test subdomain directories are `engine/` (cross-domain regression and smoke: end-to-end, anti-hang, wire frames, deep review batches, issue cleanup, dead constant wiring, sub-agents, harness, `smoke`), `context/` (compaction threshold ladder/circuit breaker/clues/model-initiated, token estimation, prompt cache, lineage, context overflow, 10M window), `routing/` (provider abstraction, error classification, failover, retry budget, route dispatch, fallback model), `hooks/` (lifecycle events, matcher regex, TOFU trust, hot reload, parallel merging, failure/duration/permission/mode hooks), `tools/` (file editing fuzzy fallback/MultiEdit, retrieval Grep/Glob/RepoMap, Bash trimming, auto-test, lazy tool loading), `session/` (session persistence, checkpoints, rewind, resume, SIGINT flush, trajectory governance, REPL input re-entrancy guard), `permission/` (three-level diff review, approval persistence and preview, sandbox, sensitive paths), `mcp/` (MCP client, dual approval, ToolAnnotations, dynamic refresh, timeout reconnect, HTTP/OAuth), `execution/` (parallel fail-soft batches, per-file write grouping, early streaming dispatch and watchdog, doom dedup), `knowledge/` (memory, skills built-in pack/disclosure budget, reflection write-back), `prompt/` (system prompt rendering, prompt optimization, ask serialization), `commands/` (CLI launcher, `/todo` `/spec` `/diag`, runtime wiring), `gameqa/` (orchestration service, storage, built-in executors, full Unity real-execution pipeline, airtest·performance·AI integration, TLS·CLI, lightweight reports, Allure reports), `proxy/` (three-protocol conversion, SSE relay, streaming usage passthrough).

**命名规则**：新测试放对应子域目录，文件名用主题描述（如 `session-atomic-write.test.ts`），不强制序号；历史前缀只反映批次不反映子域——`e<N>` issue 驱动引擎批次（E1–E93 对应 issue #N）、`n<N>`/`i<N>`/`f*` 早期 A 批（内核能力/知识集成/压缩与权限）、`g<N>` gameqa 移植回归、`proxy-*` 协议代理平移——保留用于 git 与 issue 溯源。

**Naming rules**: new tests go in the corresponding subdomain directory, filenames describe the topic (e.g. `session-atomic-write.test.ts`), sequence numbers are not required; historical prefixes reflect batches, not subdomains — `e<N>` issue-driven engine batches (E1–E93 correspond to issue #N), `n<N>`/`i<N>`/`f*` early batch A (kernel capabilities/knowledge integration/compaction and permissions), `g<N>` gameqa porting regressions, `proxy-*` protocol-proxy ports — kept for git and issue traceability.

**CI**（`.github/workflows/ci.yml` 单工作流，ubuntu-24.04 + Node 22 + ripgrep）串行链：
`build`（`npm run build` + dist artifact 保留 7 天）→ `type-check-test`（`tsc --noEmit` + `vitest run`）→ `codeql`（javascript 扫描）。纯 `*.md` 变更不触发；fork PR 跳过 codeql；同 PR 连续推送由 concurrency 取消陈旧运行。本地全绿但 CI 红 → 先建 issue 再修。

**CI** (`.github/workflows/ci.yml`, a single workflow, ubuntu-24.04 + Node 22 + ripgrep) serial chain:
`build` (`npm run build` + dist artifact kept for 7 days) → `type-check-test` (`tsc --noEmit` + `vitest run`) → `codeql` (javascript scan). Pure `*.md` changes do not trigger it; fork PRs skip codeql; consecutive pushes to the same PR have stale runs cancelled by concurrency. Locally all green but CI red → create an issue first, then fix.

## 常见问题 / FAQ

**打开看板报「您的连接不是私密连接」？**
自签名证书的预期行为，点「高级 → 继续前往 localhost」；macOS 想彻底消除：`./scripts/trust-cert-macos.sh`（导入钥匙串并设为始终信任）。

**Opens the dashboard and gets 「您的连接不是私密连接」?**
Expected behavior of a self-signed certificate, click 「高级 → 继续前往 localhost」; to eliminate it entirely on macOS: `./scripts/trust-cert-macos.sh` (imports into the keychain and sets it to always trust).

**Agent 连不上 serve？**
自签名服务端需 `PLATFORM_INSECURE_TLS=1`，或 `PLATFORM_TLS_CERT=<data/tls/cert.pem>` 指定 CA；协议要 https。

**The Agent cannot connect to serve?**
A self-signed server requires `PLATFORM_INSECURE_TLS=1`, or `PLATFORM_TLS_CERT=<data/tls/cert.pem>` to specify a CA; the protocol must be https.

**gameqa 端口冲突 / 数据在哪？**
`-p` 换端口；任务、Agent、证书都在 `DATA_DIR`（默认 `./data`），已 gitignore。

**gameqa port conflict / where is the data?**
Use `-p` to change the port; tasks, Agents and certificates all live in `DATA_DIR` (default `./data`), which is already gitignored.

**LSP/编辑器报 `../harness.js` 找不到之类错误？**
陈旧索引缓存，以 `npx tsc --noEmit` 为准；ESM 相对导入必须带 `.js` 后缀。

**LSP/editor reports errors like `../harness.js` not found?**
Stale index cache, trust `npx tsc --noEmit`; ESM relative imports must carry the `.js` suffix.

**切本地模型？**
`llm use 8b`（清单 `mlx/models.json`），`llm doctor` 自检，`llm status` 看服务。

**Switch to a local model?**
`llm use 8b` (list in `mlx/models.json`), `llm doctor` to self-check, `llm status` to view the service.

**CI 挂了？**
看 `gh run list` / `gh run view <id> --log-failed`，按上文 Issue 强制流程处理。

**CI failed?**
Check `gh run list` / `gh run view <id> --log-failed` and handle it via the mandatory Issue workflow above.

## 演进里程碑 / Evolution Milestones

| 阶段 | 内容 |
| --- | --- |
| v1 | Python 原版（tupigcode + FastAPI 平台 + Python Agent） |
| v2 | gpt-visual-platform：Go server + Rust agent（单二进制，API 兼容 v1） |
| v3 | 统一语言重写：全仓 TS 单实现（engine/proxy/mlx/tools），CI 三门槛全绿 |
| v4 | gameqa 整合：蓝本占位全部落地（Unity batchmode 真执行、Agent 全链路、TLS、系统服务与运维脚本），archive 删除 |
| 当前 | 单 README 文档制 + bug/优化 issue 强制闭环 |

English summary: v1 was the original Python version (tupigcode + FastAPI platform + Python Agent); v2 was gpt-visual-platform (Go server + Rust agent, single binary, API compatible with v1); v3 rewrote everything in one language (whole repo as a single TS implementation — engine/proxy/mlx/tools, all three CI gates green); v4 integrated gameqa (all blueprint placeholders landed: real Unity batchmode execution, the full Agent chain, TLS, system service and ops scripts, archive deleted); the current stage is single-README documentation plus the mandatory bug/optimization issue loop.
