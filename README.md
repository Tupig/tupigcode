# tupigcode

[![CI](https://img.shields.io/github/actions/workflow/status/Tupig/tupigcode/ci.yml?branch=main&label=CI)](https://github.com/Tupig/tupigcode/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-black?logo=nodedotjs&logoColor=white)](#快速开始)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript&logoColor=white)](#项目结构)
[![vitest](https://img.shields.io/badge/vitest-1060%20%E7%BB%BF-brightgreen?logo=vitest&logoColor=white)](#测试与-ci)
[![gameqa](https://img.shields.io/badge/gameqa-Unity%20%E6%B5%8B%E8%AF%95%E5%B9%B3%E5%8F%B0-orange?logo=unity&logoColor=white)](#gameqa--unity-自动化测试平台)

> 全 TypeScript 的本地研发工具集，四个部分：
> 编码代理（tupigcode）、Unity 测试平台（gameqa）、MLX 本地推理层（llm）、单端口三协议代理。
> 全部自托管，数据不出本机，本文档是唯一文档。

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
- [七个命令入口](#七个命令入口)
- [tupigcode — AI 编码代理](#tupigcode--ai-编码代理)
- [gameqa — Unity 自动化测试平台](#gameqa--unity-自动化测试平台)
- [MLX 本地推理 + 协议代理](#mlx-本地推理--协议代理)
- [架构](#架构)
- [项目结构](#项目结构)
- [配置与环境变量](#配置与环境变量)
- [开发流程（PROCESS）](#开发流程process)
- [测试与 CI](#测试与-ci)
- [常见问题](#常见问题)
- [演进里程碑](#演进里程碑)

## 这是什么

跑在自己机器上的研发工具台，由四个部分组成：

| 组件 | 说明 | 入口 |
| --- | --- | --- |
| **tupigcode-agent** | 编码代理，参照 Claude Code 架构实现：读代码、改文件、跑命令、多步规划，全链路可本地运行 | `tupigcode` |
| **gameqa** | Unity3D 游戏自动化测试编排：HTTPS 看板 + 任务队列 + 跨机 Agent + Unity batchmode 真执行。NUnit3 结果解析保留全量用例明细（`summary.cases`，含 classname/duration/message/stack/stdout，上限 2000 条、单字段 4KB）。两个报告出口：`GET /report` 轻量单文件（汇总卡片 + 近 20 次通过率 SVG 趋势 + 历史表）、`GET /allure?job=N` Allure 风格报告（Overview/Suites/Categories 三个 tab + 用例树与失败详情 + 历史切换，无外部依赖）。API 与数据格式兼容原 gpt-visual-platform（Go 版） | `gameqa serve` / `gameqa agent` |
| **MLX 推理层** | 在 Apple Silicon（M4）上用 MLX 跑本地大模型，管理服务生命周期，单端口暴露给任意客户端 | `llm` |
| **协议代理** | 一个端口同时说 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议，互相转换后转本地后端 | `:4100`（由 `llm` 拉起） |

设计原则：

- **一种语言**：全仓 TypeScript（含脚本、代理、测试），无 Python / Go / Rust 残留
- **自托管**：代码、模型、测试数据不出本机；云端 Provider 是可选项，不是依赖
- **客户端开放**：任何支持 OpenAI 或 Anthropic 协议的工具（opencode / Claude Code / codex 等）都能直连本机
- **一份文档**：本 README 即项目全部文档，随代码同步更新，历史看 git 记录

## 快速开始

```bash
git clone https://github.com/Tupig/tupigcode.git && cd tupigcode
npm ci                # 安装依赖（Node ≥ 20，构建需 Node 22+）
npm run build         # tsc 编译 + 拷贝 gameqa 看板静态资源 + 入口 chmod
npm test              # 120 文件 / 1060 用例（tsc + vitest 是 CI 双门槛）
```

构建后 `dist/cli/*.js` 即 7 个可执行入口。常用命令：

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
> - gameqa 默认全站 HTTPS（自签名证书自动生成于 `data/tls/`）；浏览器首次访问点「高级 → 继续前往」，macOS 可用 `./scripts/trust-cert-macos.sh` 一键信任。
> - 跑 MLX 需要 Apple Silicon；`llm doctor` 自检环境。

## 七个命令入口

| 命令 | 用途 | 典型用法 |
| --- | --- | --- |
| `tupigcode` | 编码代理主入口 | `tupigcode "重构这个模块"` / `tupigcode`（REPL） |
| `llm` | MLX 本地服务管理 + 对话 | `llm start` / `llm use 8b` / `llm "问题"` / `llm doctor` |
| `gameqa` | 测试平台 serve / agent 双子命令 | `gameqa serve --tls off` / `gameqa agent` |
| `opencode-local` | 走本机代理的 opencode 入口 | `opencode-local "写个快排"` |
| `claude-local` | 走本机代理的 Claude Code 入口 | `claude-local "重构这个函数"` |
| `codex-local` | 走本机代理的 Codex 入口 | `codex-local exec "跑测试"` |
| `mlx-local` | MLX 模型直连入口 | `mlx-local "补全这段"` |

开发态脚本：`npm run dev`（index）、`dev:tupigcode`、`dev:llm`、`gameqa:serve`、`gameqa:agent`、`test`、`test:watch`。

## tupigcode — AI 编码代理

### 能力清单（20+ 工具）

| 类别 | 工具 |
| --- | --- |
| 读写 | `FileRead`（文本 + 图片多模态输入，png/jpg/webp/gif ≤5MB）`FileWrite` `FileEdit`（精确匹配，失败时模糊回退，容忍缩进/空白/单字符漂移，唯一命中才替换）`MultiEdit`（多组替换原子落盘，失败报「第 N 处不匹配」；extras 池经 ToolSearch 或 `TUPIG_EXTRA_TOOLS` 挂载）`DocRead` |
| 检索 | `Grep`（ripgrep 主路径 + 内置降级；`offset` / `head_limit` 分页，截断带续取提示）`Glob` `RepoMap`（全仓地图）`similar`（语义近邻） |
| 执行 | `Bash`（沙箱 + 安全护栏）`PackageManager` `lint` `Refactor` `Analysis` |
| 规划 | `todo`（任务清单）`Question`（向用户澄清）`parallel`（并行子任务）`Agent`（子代理派发） |
| 状态 | `rollback`（回滚）`state`（状态机）`Web`（联网抓取） |
| 扩展 | **MCP 客户端**：`.tupigcode/mcp.json`（Claude Code 兼容 `{ mcpServers: { name: { command, args, env } } }`）接入外部 MCP server，工具自动桥接为 `mcp_<server>_<tool>`。支持 `readOnlyHint` 只读标记、inputSchema 透传、单 server 失败降级；审批分两级（server 级 `approval` 与单工具 `tools` 白名单，allow/ask/deny），`TUPIG_MCP_APPROVAL=off\|ask` 为全局开关 |

### 内核特性

**上下文与压缩**

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

**容错与路由**

- **多 Provider 容错**：Anthropic / OpenAI / 本地代理统一接入，`TUPIG_FAILOVER` 链式降级。错误分类见 `services/errors.ts`（rate_limit / auth / context_too_long / overloaded / server / network / invalid_request），429/529/5xx/断连触发切换，401 与业务错误不切换；`TUPIG_ROLE_MODELS` 按角色选模型
- **重试退避**：`callWithRetry` 用 full-jitter 退避 `rand(0, min(10s, 1s·2^n))`，总预算 `TUPIG_RETRY_BUDGET_MS`（默认 60s）超限抛最后错误，401/403 立即抛
- **结果语义与截断保真（fix #95/#96）**：错误与中断路径只产出一条 `error` result，`route.log` feedback 记真实成败；Anthropic `stop_reason=max_tokens` 与 OpenAI `finish_reason=length` 进入输出额度升级重试（基线跟随 `maxTokens`，阶梯 `[8192,16384,32768,65536]`，耗尽才报错）
- **failover 状态回滚（fix #97）**：主源中途断流切换兜底前回滚 `fullText` / `toolBuffers` / 早派发遗留与 `events`，assistant 消息只含兜底全量输出
- **兜底模型接线（fix #98）**：`config.fallbackModel` 优先，缺省按兜底 provider 解析云模型（`TUPIG_CLOUD_MODEL` / `OPENAI_MODEL`，anthropic 默认 `claude-sonnet-4-20250514`），避免把本地模型名打到云端 404
- **Ctrl+C 中断**：turn 进行中 SIGINT 调 `interrupt()`（`interruptActiveTurn` 活跃注册表），信号接入 LLM 流（`streamMessage` 收 signal），在途工具 per-call controller 联动 abort（取消文案、不 fire PostToolUseFailure）；`AbortError` 不切兜底，收尾 fire `Stop(output=任务已中断)` 与单条 error result；空闲时走抢救 + exit(130)，二按强制退出
- **流式空闲看门狗**：`withIdleWatchdog` 包装流式消费，距上一个内容事件超过阈值（默认 120s，`TUPIG_STREAM_IDLE_MS` 覆盖，0 关闭）抛「流式响应空闲超时」并回收内层迭代器；字节级 keepalive 不产生事件不重置计时；错误归类 network，复用既有 retry/failover 通道
- **流式早期派发**：`tool_use` 输入收完（`tool_use_stop`）即执行只读且并发安全的工具，与模型尾部生成重叠以降低首工具延迟；流结束后结果直接复用不重复执行（权限只进一次），写工具、未知工具、JSON 非法仍走既有批次路径；max_tokens 与溢出重试前清空在途派发与遗留结果
- **结果路由修复（fix #102）**：`contextTokens` 接进 `routeTask`（resume 大上下文可命中 `easy-ctx>=14k→8b`）；输入 JSON 非法的 tool_use 补发 `tool_use` 事件以配对后续 `tool_result`；流结束缺 `finish_reason` 按不完整响应记 `stopReason=error`；请求侧工具集统一为 `activeRequestTools()`（`modeManager.filterTools(promptTools(tools))`），init 事件、请求 `tools`、system 工具目录三处同源，plan 模式下模型看不到 Write/Edit/Bash

**Hooks**

- **TOFU 信任**：shell hook 首次触发询问，确认后写 `.tupigcode/hook-trust.json`（规则 hash 覆盖 event/matcher/command/timeout，任一变更重询）；拒绝不持久化，异常与超时 fail-closed；非 TTY 与 `TUPIG_HOOK_TRUST=0` 不打断；`/hooks` 查看、`/hooks clear` 清除、`/hooks reload` 手动重载，`/doctor` 列信任清单
- **信任询问输入解析（fix #101）**：`promptHookTrust` 复用审批的 `parseApprovalAnswer` 首行解析（粘贴 `y⏎杂散内容` 不误拒）；30s 超时显式移除 data/close/end 三处 stdin listener，不残留吞后续输入
- **并行执行与合并**：同事件多 handler 用 `Promise.all` 并行（总耗时约等于最慢者，单点异常吞掉）。合并规则：block 任一为真即 block，message 不被后续覆盖；未 block 时取注册序第一个非空 message/replacement，additionalContext 拼接。并行下 block 不短路后续 handler。两处有意收紧（issue #70）：block 者未带 replacement 时不保留前面 handler 的 replacement；block 之后 handler 的 additionalContext 仍被收集，但 UserPromptSubmit 整体丢弃不注入
- **matcher 正则化**：`tool_name` 全串锚定正则 `^(?:p)$`（`Edit|Write` 命中两工具不误伤 MultiEdit），子串用 `.*X.*`，非法正则回退精确匹配；shell hooks.json 解析透传 `matcher.decision` / `matcher.modeTo`；TOFU `hashRule` 纳入 matcher 全字段
- **hooks.json 热加载**：shell hooks 按工厂注册，`submitMessage` 入口检测 mtime 变更才整批重载（文件未变零动作，删除即失效）；代码注册（`hookSystem.register`）不受重载影响；REPL `/hooks reload` 忽略 mtime 强制重载并打印数量
- **生命周期事件**：`Stop`（自然结束）、`SessionStart`（submitMessage 入口）、`PreCompact` + `PostCompact`（阈值梯度、溢出恢复、手动 /compact 三处压缩点）均已落地；压缩事件带 `source: manual|auto` 供 matcher 过滤，shell hooks.json 支持 `matcher.source`；hook 异常一律吞掉不阻塞
- **UserPromptSubmit**：prompt 进模型前触发（mode 命令之后、init 之前）。`block`（exit 2 或 JSON block）拒绝本轮不发请求并输出原因；`additionalContext`（平铺 JSON 或 Claude Code `hookSpecificOutput` 嵌套）以独立 user 消息注入本轮上下文，多 hook 拼接不覆盖；`turnNumber` 为该条输入的 0-based 序号（`appStore.userPromptCount`，block 也递增）
- **Notification hook**：`permission_prompt`（`promptUserDecision` 弹问前 fire-and-forget，非 TTY 不 fire）与 `idle_prompt`（REPL 输入空闲，`TUPIG_IDLE_NOTIFY_MS` 默认 300s、0 关闭，prompt 布防 / line 重置 / 一轮一次）；`matcher.notificationType` 过滤，shell hooks.json 解析透传，TOFU hash 覆盖
- **PostToolUseFailure**：工具执行错误与超时（含 Bash 超时改为 reject 的真实失败语义）触发，携带 `output + durationMs`；校验失败与 doom 拒绝不触发
- **PostToolUse 带耗时**：hook 上下文含 `durationMs`（纯工具执行时间，不含权限询问与 PreToolUse），shell hook 经 stdin JSON 同步可见
- **PermissionResult**：allow/deny/always 决策后携带 `decision + ruleSource` 触发供审计，matcher 可按 decision 过滤
- **ModeChange**：`/plan`、`/act` 实际发生切换时携带 `modeFrom/modeTo` 触发（同模式不触发），matcher 可按 modeTo 过滤
- **PostRewind**：回滚成功后携带 `checkpointId + mode` 触发，失败不触发
- **PreClear/PostClear**：`/clear` 序列为 Pre hook → 重置状态 → Post hook，hook 异常吞掉，重置失败原样上抛

**工具执行与并行**

- **并行批 fail-soft**：同批只读工具并发执行不被全局 `streaming` 互斥误伤（不安全项由 `partitionRuns` 独立成批，批间顺序执行天然互斥）；`mapWithConcurrency` 为 settled 语义，批内单任务异常只产生自己的 error tool_result 并触发 PostToolUseFailure，兄弟结果保留
- **写工具按文件分组并行**：带 `file_path` 的写（Write/Edit/MultiEdit）相邻项合并为写组批——同文件保序串行（组内逐项 fail-soft，前项失败不连坐），异文件组间并行（并发 `TUPIG_WRITE_CONCURRENCY`，默认 4）；批段间仍顺序，非写不安全项（Bash 等）保持独立成批
- **工具超时**：`withTimeout` 超时即 abort 本次调用的 controller 并附副作用提示（写类操作可能已部分落盘）；子代理内 tool.call 与主循环同享 `TOOL_TIMEOUT_MS`（含 `TUPIG_TOOL_TIMEOUT_MS` 覆盖），挂死工具超时返回 is_error tool_result 后任务继续；实现于 `engine/time.ts` 供两侧共用
- **工具结果语义（fix #99）**：工具返回 `isError` 或 `output.type=error` 时 `tool_result.is_error=true` 并触发 PostToolUseFailure，不按成功处理、不快照；流报错返回前 await 在途早期派发，events 与 toolResults 不脱钩
- **doom loop 批内去重（fix #100）**：同一批、同一轮内相同只读调用只计一次（轮界清批内集合），并行同参检索不受影响；detector 在 `submitMessage` 入口 reset，跨轮连续 ≥3 次同动作仍拦截
- **截断续取**：统一文案 `已截断 total=N，本次显示 x~y，用 offset=… 续取`（`truncationHint`，unit 条/字符可配）；Grep 支持 `offset` 分页（越界返回「无更多结果」），WebFetch 按字符窗口 `offset` + `maxLength` 续取
- **Bash 输出裁剪**：超长输出 head+tail 双端保留（both 默认 60/40，`keep=head|tail` 单端），预算 `TUPIG_BASH_OUTPUT_CHARS`（默认 50000）可调；截断标注原始大小、省略量、keep 模式，预算内原样返回
- **auto-test**：`RunTests` 工具（默认集，只读），探测 `TUPIG_TEST_CMD` / npm test（跳过占位）/ pytest / cargo / go，失败输出回喂修复后复跑；超时 `TUPIG_TEST_TIMEOUT_MS`，输出尾部截断 4000 字符
- **工具延迟装载**：核心集（Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Question）与 `ToolSearch` 元工具常驻，其余（git / 测试 / 网页 / 子代理 / 仓库地图等）按需检索挂载，下一轮生效；`TUPIG_EXTRA_TOOLS` 显式指定与 MCP 工具保持常驻；`TUPIG_LAZY_TOOLS=0` 回退全量注入
- **模型主动压缩**：只读工具 CompactContext，阶段完成后模型自行请求折叠（focus 透传摘要）；QueryEngine 下一轮循环前执行压缩流水线（source=model，PreCompact/PostCompact 同步触发，`/context` 可见）

**权限、审查与护栏**

- **三级 diff 审查**：每轮写操作聚合为结构化 diff（自研 LCS，上下文 3），REPL 全局 a/r/s → 文件 y/n/h/q → 块 y/n 三级判定；拒绝按文件回滚（同文件多次修改回到首次之前）；超大 diff 降级为仅文件级；`TUPIG_DIFF_REVIEW=0` 关闭。plan 模式改动暂存 `.tupigcode/staging/`，`/apply` 才落盘（越界条目拒绝，落盘前自动建 `before:apply` 检查点）
- **审批「总是允许」持久化**：审批 prompt `y/N/a`，选 `a` 推导模式（Bash 首词前缀如 `Bash(npm *)`、写工具按工具级）写入项目级 `.tupigcode/permissions.json`，后续同前缀自动放行；deny 规则、敏感路径、自修改面仍优先（敏感路径检查在规则链之前）；`/permissions [clear]` 查看与清除
- **审批 diff 预览**：ask 弹问时 Edit/Write 渲染真实变更（复用 LCS 三级审查的 mini 渲染，含新建/覆盖、diff 行着色），定位失败、内容无变化、其他工具回退 JSON 截断 500 字符
- **弹问串行化（issue #64）**：审批弹问与 hook 信任询问共用一把进程内锁，同一时刻只占一个 readline，后续并发调用按到达序排队，前一个 settle 后才提示下一个；非 TTY 快速拒绝不入队
- **风险分类器**：mutate 命令自动放行、系统敏感路径 deny、git push/publish 恒询问，判定入 trajectory
- **自修改面复审**：写 `.tupigcode/skills|mcp.json|config.json` 与 hooks 文件时绕过 allow 规则强制确认
- **写路径沙箱**：`TUPIG_SANDBOX_WRITE` 白名单 / `TUPIG_SANDBOX_DENY` 黑名单

**会话与状态**

- **会话恢复**：session / checkpoint 一键回滚；自动快照（每轮与写类工具成功后，防抖 5s、上限 20 滚动，`TUPIG_AUTOSNAPSHOT=0` 关）；`/rewind [chat|code|all] [id]` 三档回卷（回对话 / 回代码 / 全回），跨进程续跑
- **检查点按名称回滚**：`/rewind` 参数为 id-or-label，id 精确优先，label 精确匹配（同名取最新），回滚消息标注匹配方式
- **SIGINT 会话抢救**：Ctrl+C / SIGTERM 同步落盘当前历史并打 `interrupted` 标记（空会话不写）；下次启动扫描孤儿会话打印「恢复：/resume \<id\>」提示；正常 turn 结束的保存不带标记自然冲掉，也可手动 `clearInterruptedFlag`；会话文件 temp+rename 原子写（中断不半写），sessionId 白名单校验拒绝含 `/` 的穿越 id
- **会话列表**：`/resume`（无 id）与 `/sessions` 统一行格式：id + 相对时间 + 条数 + 首条用户 prompt 预览（截断 60 字，空会话显示「无预览」占位），按 updatedAt 倒序
- **REPL 输入防重入（issue #86）**：line handler 持 `TurnGate` 门闩，turn 进行中的行直接丢弃；审批弹问的裸 stdin 监听与 readline 共挂同一输入流，一次 y⏎ 双路分发不再产生幻影 prompt 或并发 query
- **知识沉淀**：memory（长期记忆）、skills（技能库，`.tupigcode/skills/` 先审后存）、reflexion（反思入库）
- **内置技能包（10 个）**：git-workflow / git-log / gitingest / shell-command-engager / code-review / debugging / test-first / docs-sync / release-check / refactor-safe，`src/knowledge/skills/` 静态装载（build 拷贝到 dist），用户 `.tupigcode/skills/` 同名覆盖、无效回落内置，三重门禁与 3000 字目录预算对内置同样生效

**MCP**

- **接入**：`.tupigcode/mcp.json`（Claude Code 兼容）接入外部 MCP server，工具桥接为 `mcp_<server>_<tool>`，单 server 失败降级不阻塞
- **双重审批**：server/tool 级 `approval` 白名单 + `TUPIG_MCP_APPROVAL=off|ask` 全局开关，未配置时按 mcp.json 白名单与 readOnlyHint 分级
- **ToolAnnotations**：`readOnlyHint` → 只读分级；显式 `destructiveHint=true` 且非只读时审批升为 ask 强制确认（deny 优先、allow 被覆盖）；`title` 进 description 展示
- **list_changed 动态刷新**：server 发 `notifications/tools/list_changed` 或手动 `refresh()` 时重拉 tools/list，diff 出增删与同名定义变更（description / schema / annotations 签名比较），变更即同步工具集与搜索池，刷新失败保留旧工具只告警
- **白名单过滤**：`includeTools` / `excludeTools`（MCP 原始名白/黑名单，exclude 优先），首连与 list_changed 重拉共用
- **远程传输与 OAuth**：`url` + `transport: http|sse` + `headers`，`oauth:false` 关闭；`FileOAuthProvider` 本地回调收 code 后 `finishAuth` 自动重连，tokens 落 `~/.tupigcode/mcp-auth/`；`states` 暴露 connected/failed/needs_auth
- **超时与断线自愈**：`mcp.json` 每 server 可配 `timeout`（毫秒，callTool 单次超时）；stdio 断开立即摘除该 server 的死工具，指数退避自动重连（1s→2s→…→30s 封顶，最多 5 次，同 server 不并发叠加），成功恢复工具，耗尽告警放弃，connection close 后不再重连

**其他**

- **工作模式**：plan / act 双模式 + spec 规格驱动开发（`n8-spec`）
- **工程护栏**：写路径沙箱、权限分级与风险分类器、自修改面复审、hooks（`TUPIG_HOOKS_FILE`）、`/doctor` 自诊断、`/init` 项目初始化、`/review` 代码评审
- **wire.jsonl 原始报文**：`TUPIG_WIRE=1` 开启（默认关，零开销）——pilot 侧 `streamMessage` 记录请求与流式合并后正文，proxy 侧透传观测，JSONL 落 `.tupigcode/wire.jsonl`（`TUPIG_WIRE_FILE` / `TUPIG_WIRE_MAX_BYTES` 可调，默认 5MB 滚动裁剪），request/response 共享 `req_id`

## gameqa — Unity 自动化测试平台

跨环境（Mac / Linux / Windows / iOS / Android）的 Unity3D 游戏自动化测试编排与结果收集，
`data/` 数据格式与原 gpt-visual-platform（Go server + Rust agent）完全兼容；原蓝本文档已删，历史见 git。

### 任务类型（Agent 侧，`extra.job_type`）

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

### 内置执行器（服务端，`platform=web`，无需 Agent）

`web_check`（网站可用性）/ `api_check`（接口断言）/ `api_load`（k6 式性能冒烟）/
`api_flow`（多步接口流程）/ `self_check` / `port_check` / `cert_check` / `dns_check`；
`extra.repeat_minutes` 开启循环监控（蓝本的断链 bug 已修，服务端 worker 直读 `extra`）。

### 服务端 API（30 路由）

注册 / 心跳 / 领任务（`POST /api/agent/poll`）/ 结果上报（3 次重试，poll 只认 pending）/
产物上传（截尾 64KB，`ARTIFACT_MAX_BYTES`）/ 任务 CRUD / 取消 / Agent 列表 / 技能表 /
MCP 代理 / OpenAI 用例生成 / Webhook 通知 / 看板静态资源；可选 `X-Platform-Token` 认证（`PLATFORM_TOKEN`）。

### 关键环境变量

| 变量 | 侧 | 说明 |
| --- | --- | --- |
| `PORT` / `DATA_DIR` / `STATIC_DIR` | serve | 端口（默认 9111）/ 数据目录 / 看板目录（缺省自动定位） |
| `TLS_MODE` | serve | `auto`（自签名/用户证书，默认）\| `off`（明文，仅限可信内网） |
| `TLS_CERT` / `TLS_KEY` | serve | 用户证书（优先；自签名存 `data/tls/`，跨重启复用，key 0600） |
| `PLATFORM_TOKEN` | serve | 启用 `X-Platform-Token` API 认证（公网部署必设） |
| `STALE_MINUTES` | serve | running 任务超时判 Agent 失联标失败（默认 30） |
| `PLATFORM_URL` | agent | 编排服务地址（默认 `http://localhost:9111`） |
| `AGENT_ID` / `AGENT_SKILLS` / `AGENT_WORKDIR` | agent | 标识 / 技能（逗号分隔，任务 `required_skills` 须为其子集）/ 工作目录 |
| `PLATFORM_INSECURE_TLS` | agent | `1` = 信任自签名服务端；或 `PLATFORM_TLS_CERT=<cert.pem>` 指定 CA |
| `UNITY_PATH` | agent | Unity 可执行文件（缺省探测 Unity Hub 最高版本 / PATH） |
| `ADB_PATH` / `ANDROID_SERIAL` | agent | adb 可执行覆盖 / 默认设备序列号 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_VISION_MODEL` | agent | `ai_exploratory` 视觉模型 |

### 运维脚本与部署

```bash
./scripts/e2e.sh              # 全链路冒烟（HTTPS + Agent + 内置执行器 + 取消/删除 + 落盘）
./scripts/start.sh            # 前台启动（已注册系统服务则转 launchd/systemd）
./scripts/install-service.sh  # 注册开机自启（macOS launchd / Linux systemd）
./scripts/stop.sh / status.sh / uninstall-service.sh / trust-cert-macos.sh
```

## MLX 本地推理 + 协议代理

Apple M4 上跑本地大模型，架构：

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

**模型清单**（`mlx/models.json`）：

| 别名 | 模型 | 大小 | 定位 |
| --- | --- | --- | --- |
| `14b` | Qwen3-14B-4bit | 7.8G | 默认，性能均衡 |
| `8b` | Qwen3-8B-4bit | 4.3G | 轻量快速 |
| `30b` | Qwen3-Coder-30B-A3B-Instruct-4bit | 16G | 代码专精，需提高 GPU 上限 |
| `qwen-vl-8b` | Qwen3-VL-8B-Instruct-4bit | 5.5G | 视觉语言模型 |

> [!WARNING]
> 24GB 内存机器 GPU 上限约 16GB：30B 模型需调高 MLX GPU 上限；超长上下文（5 万+ token）请求可能 OOM，长任务建议切云端 Provider（`TUPIG_PROVIDER`）。

## 架构

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

## 项目结构

```
tupigcode/
├── AGENTS.md                  # AI 协作约定（工作流/issue 闭环/README 维护规则）
├── README.md                  # 本文件——项目唯一文档，随代码同步更新
├── package.json               # 7 bin + 构建/开发脚本
├── scripts/                   # gameqa 运维：e2e/start/stop/status/install-service…
│
├── src/
│   ├── index.ts               # CLI 入口（配置走环境变量，无配置文件读取）
│   ├── engine/                # 主链路：QueryEngine prompt toolRegistry router harness mcp
│   ├── tools/                 # 20+ 工具实现
│   ├── services/              # api bashSafety permissions sandbox failover errors
│   ├── session/               # session sessionState checkpoint trajectory
│   ├── context/               # compact rules repomap
│   ├── knowledge/             # memory skills reflexion
│   ├── modes/                 # plan/act + spec
│   ├── agents/                # 子代理
│   ├── commands/              # /doctor /init /review + REPL
│   ├── proxy/                 # 统一协议代理（convert 三协议转换 + server SSE relay）
│   ├── gameqa/                # Unity 测试平台（store/server/builtin/agent/unity/
│   │                          #   airtest/gameperf/ai/tls + report/allure 报告 + static 看板）
│   ├── cli/                   # 7 个入口（tupigcode llm gameqa *-local mlx-local mlxcmd）
│   └── git/ state/ utils/
│
├── tests/                     # vitest 120 文件 / 1060 用例
├── mlx/                       # 推理服务层（models/venv/logs/state 运行时 + models.json）
├── .tupigcode/                # 运行时技能库（先审后存）
└── .github/workflows/ci.yml   # 门槛：tsc + vitest + build
```

## 配置与环境变量

### tupigcode / 引擎

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

### MLX / 代理

| 变量 | 说明 |
| --- | --- |
| `MLX_HOME` / `MLX_VENV` / `MLX_LOGS` / `MLX_STATE` | MLX 根目录/虚拟环境/日志/状态 |
| `MLX_MODELS` / `MLX_MODEL` / `MLX_DEFAULT_MODEL` | 模型清单 / 当前模型 / 默认模型 |
| `MLX_SERVER_PORT` / `MLX_UNIFIED_PORT` | 后端推理端口（8080）/ 统一代理端口（4100） |
| `MLX_BACKEND` / `MLX_AUTH_TOKEN` / `MLX_REQUEST_TIMEOUT` | 后端选择 / 鉴权 / 超时 |

gameqa 环境变量见上文 [gameqa 节](#gameqa--unity-自动化测试平台)。

## 开发流程（PROCESS）

每个功能单元走完六步，不允许跳步：

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

### Bug / 优化 · Issue 强制流程

本地发现的任何 bug 或优化点，先上报 GitHub issue 再动手修：

1. `gh issue create` 上报（现象/根因/影响面/复现）——无 issue 不许改代码
2. 修复提交必须引用 issue 号：`fix #<N>: ...`
3. 回归全绿 + 推送后 CI 绿 → `gh issue close <N>`（留一句修复摘要）

历史 bug 查询：`gh issue list --state all`；过往决策用 `git log`。工作区不留待办文档。

## 测试与 CI

```bash
 npm test              # = npx vitest run，120 文件 / 1060 用例
 npx tsc --noEmit      # 类型门槛
 npm run build         # 构建门槛（含 gameqa 静态资源拷贝 + 入口 chmod）
 ```

用例分组：`n1~n12`（编辑/会话/沙箱/子代理/规格/RepoMap/harness…）、`e1~e93`
（Provider/配置/护栏/容错/工具/并行/路由/优化/图像输入/模糊编辑/错误分类/MCP）、`f*`（压缩/权限）、`i1~i4`
（记忆/技能/hooks/反思）、`g1~g7`（gameqa store/服务/内置执行器/Unity 真执行全链路/
airtest·性能·AI 集成/TLS·CLI/轻量报告/Allure 报告）、`proxy-*`（三协议转换/SSE/流式 usage）、`smoke`、`cli`、`ctx10m`。

**CI**（`.github/workflows/ci.yml`，ubuntu-latest + Node 22 + ripgrep）三连：
`tsc --noEmit` → `vitest run` → `npm run build`。本地全绿但 CI 红 → 先建 issue 再修。

## 常见问题

**打开看板报「您的连接不是私密连接」？**
自签名证书的预期行为，点「高级 → 继续前往 localhost」；macOS 想彻底消除：`./scripts/trust-cert-macos.sh`（导入钥匙串并设为始终信任）。

**Agent 连不上 serve？**
自签名服务端需 `PLATFORM_INSECURE_TLS=1`，或 `PLATFORM_TLS_CERT=<data/tls/cert.pem>` 指定 CA；协议要 https。

**gameqa 端口冲突 / 数据在哪？**
`-p` 换端口；任务、Agent、证书都在 `DATA_DIR`（默认 `./data`），已 gitignore。

**LSP/编辑器报 `../harness.js` 找不到之类错误？**
陈旧索引缓存，以 `npx tsc --noEmit` 为准；ESM 相对导入必须带 `.js` 后缀。

**切本地模型？**
`llm use 8b`（清单 `mlx/models.json`），`llm doctor` 自检，`llm status` 看服务。

**CI 挂了？**
看 `gh run list` / `gh run view <id> --log-failed`，按上文 Issue 强制流程处理。

## 演进里程碑

| 阶段 | 内容 |
| --- | --- |
| v1 | Python 原版（tupigcode + FastAPI 平台 + Python Agent） |
| v2 | gpt-visual-platform：Go server + Rust agent（单二进制，API 兼容 v1） |
| v3 | 统一语言重写：全仓 TS 单实现（engine/proxy/mlx/tools），CI 三门槛全绿 |
| v4 | gameqa 整合：蓝本占位全部落地（Unity batchmode 真执行、Agent 全链路、TLS、系统服务与运维脚本），archive 删除 |
| 当前 | 单 README 文档制 + bug/优化 issue 强制闭环 |
