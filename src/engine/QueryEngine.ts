/**
 * QueryEngine.ts — 核心 Agent 循环
 * 对齐 Claude Code 的 AsyncGenerator 流式架构
 */
import { withTimeout } from "./time.js";
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolUseContext, CanUseToolFn } from "./Tool.js";
import { anthropicToolResultContent, isToolResultError } from "./Tool.js";
import { connectMcpServers } from "./mcp.js";
import { getDefaultTools, getToolByName, resolveExtraTools } from "./toolRegistry.js";
import { promptTools, setExplicitExtras, setSearchPool, markLoaded } from "./lazyTools.js";
import { resetTurnOps } from "./diffReview.js";
import { createClient, streamMessage, UsageTracker, type ApiClient } from "../services/api.js";
import { resolveHarness, parseXmlToolCalls } from "./harness.js";
import { resolveFallback, resolveFallbackModel, streamWithFailover } from "../services/failover.js";
import { renderSystemPrompt } from "./prompt.js";
import { routeTask, formatRouteLog, profileTask, appendRouteFeedback } from "./router.js";
import { appendFileSync, mkdirSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { mapWithConcurrency, partitionRuns, partitionWriteGroups } from "../tools/parallel.js";
import { canUseTool, promptUserDecision } from "../services/permissions.js";
import { deriveAlwaysPattern } from "../services/approvalStore.js";
import { hookSystem, loadShellHooks, initShellHooks, reloadShellHooksIfChanged, type HookMatcher } from "./hooks.js";
import { firePermissionResult, firePostToolUseFailure, fireModeChange } from "./hookEvents.js";
import { formatCompactionLine } from "./compactionMeta.js";
import { ensureHookTrust, answerHookTrust, promptHookTrust } from "./hookTrust.js";
import { getLineage } from "./lineage.js";
import { OverflowRecovery, MAX_OVERFLOW_RETRIES } from "./overflowRecovery.js";
import { fireSessionStart, fireStop, fireCompactPre, fireCompactPost, fireUserPromptSubmit } from "./hookEvents.js";
import { ContextCompactor, LADDER_MICRO } from "../context/compact/index.js";
import { appStore } from "../state/AppState.js";
import { MAX_CONTEXT_TOKENS, TOOL_TIMEOUT_MS, resolveWriteConcurrency } from "./constants.js";
import { resolveRuleLayers, formatLayersForPrompt, type RuleLayer } from "../context/rules.js";
import { loadMemoriesSync, formatMemoriesForPrompt, type MemoryEntry } from "../knowledge/memory.js";
import { loadSkills, formatSkillCatalog } from "../knowledge/skills.js";
import { loadAgents } from "../agents/agents.js";
import { listSpecs } from "../modes/spec.js";
import { setAgentRegistry } from "../tools/Agent.js";
import { renderTodoState } from "../tools/todo.js";
import { createToolState, recordToolExecution, formatToolStateForPrompt, type ToolExecutionState } from "../tools/state.js";
import { ModeManager, type AgentMode } from "../modes/modes.js";
import { createTrajectoryRecorder, type TrajectoryRecorder } from "../session/trajectory.js";
import { autoSnapshot } from "../session/checkpoint.js";

const WRITE_SNAP_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);
import {
  createSessionState,
  generateSessionId, type SessionState,
} from "../session/sessionState.js";

export type SDKMessage =
  | { type: "assistant"; message: { content: Array<{ type: string; [key: string]: unknown }> } }
  | { type: "tool_use"; toolName: string; input: Record<string, unknown>; toolUseId: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "result"; subtype: "success" | "error"; result: string; cost_usd?: number; duration_ms?: number; num_turns?: number }
  | { type: "system"; subtype: "init"; model: string; tools: string[] }
  | { type: "text"; text: string }
  | { type: "session"; messages: Anthropic.MessageParam[] };

export type QueryEngineConfig = {
  cwd: string;
  model: string;
  maxTokens: number;
  maxTurns: number;
  permissionMode?: "plan" | "default" | "acceptEdits" | "bypassPermissions";
  allowedTools?: string[];
  disallowedTools?: string[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  fallbackModel?: string;
  verbose?: boolean;
  /** 初始模式：plan 或 act */
  initialMode?: AgentMode;
  /** 是否启用轨迹记录 */
  enableTrajectory?: boolean;
  /** 轨迹保存路径 */
  trajectoryPath?: string;
  /** E9 路由决策的 provider 切换（local/cloud/mock） */
  routeProvider?: "local" | "cloud" | "mock";
  /** 是否启用缓存 */
  enableCache?: boolean;
  /** 是否启用会话持久化 */
  enableSession?: boolean;
  /** 会话 ID（用于恢复） */
  sessionId?: string;
  /** 会话续接：初始历史消息 */
  initialMessages?: Anthropic.MessageParam[];
  /** 预算限制 */
  budget?: {
    maxCostPerSession?: number;
    maxTokensPerRequest?: number;
  };
};

type LoopState = {
  messages: Anthropic.MessageParam[];
  turnCount: number;
  compacted: boolean;
  maxOutputTokensOverride: number;
  hasAttemptedReactiveCompact: boolean;
};

const MAX_OUTPUT_TOKEN_ESCALATION = [8192, 16384, 32768, 65536];

/** 升级基线跟随当前上限（issue #96）：取阶梯中第一个严格大于当前值的档位，耗尽返回 null */
function nextOutputTokenEscalation(current: number): number | null {
  return MAX_OUTPUT_TOKEN_ESCALATION.find((v) => v > current) ?? null;
}

export function createDoomDetector(threshold = 3) {
  let lastSig = "";
  let count = 0;
  return {
    feed(sig: string): boolean {
      if (sig === lastSig) count++;
      else { lastSig = sig; count = 1; }
      return count >= threshold;
    },
    reset() { lastSig = ""; count = 0; },
  };
}

export { withTimeout } from "./time.js";

function appendRouteLog(prompt: string, route: ReturnType<typeof routeTask>, cwd: string): void {
  try {
    const dir = join(cwd, ".tupigcode");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "route.log"), formatRouteLog({ ...route, prompt, kind: profileTask(prompt).kind }) + "\n");
  } catch { /* routelog 失败不影响主流程 */ }
}

export class QueryEngine {
  private config: QueryEngineConfig;
  private tools: Tool[];
  /** 模型主动压缩信号（issue #41）：置位后下一轮循环前执行 */
  private pendingCompaction: { focus?: string } | null = null;
  private client: ApiClient;
  private compactor: ContextCompactor;
  private lineageText = ""; // repo-map 变更史摘要（issue #22）
  private overflowRecovery = new OverflowRecovery(); // 上下文溢出恢复（issue #24）
  private abortController: AbortController;
  private readFileState: Map<string, { mtime: number }> = new Map();
  private currentMessages: Anthropic.MessageParam[] = [];
  private toolState: ToolExecutionState;
  private ruleLayers: RuleLayer[] = [];
  private memoryEntries: MemoryEntry[] = [];
  private skillCatalog: string = "";
  private modeManager: ModeManager;
  private trajectory: TrajectoryRecorder | null = null;
  private sessionState: SessionState | null = null;
  private doomDetector = createDoomDetector(3);
  /** doom 批内已计签名（issue #100）：同一批相同调用只 feed 一次，批界清空 */
  private doomBatchSigs = new Set<string>();
  private mcpInitialized = false;
  private fallbackClient: ApiClient | null = null;
  private fallbackLabel: string | null = null;

  constructor(config: QueryEngineConfig) {
    this.config = config;
    this.tools = [...getDefaultTools(), ...resolveExtraTools()];
    // 工具延迟装载（issue #17）：核心常驻 + ToolSearch 按需挂载；显式 extras 保持常驻
    setExplicitExtras(resolveExtraTools().map((t) => t.name));
    setSearchPool(this.tools);
    if (config.routeProvider === "mock") {
      this.client = { type: "mock" };
    } else if (config.routeProvider === "cloud" && process.env.ANTHROPIC_API_KEY) {
      this.client = { type: "anthropic", anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) };
    } else {
      this.client = createClient();
    }
    const fbKind = resolveFallback();
    if (fbKind && fbKind !== (this.client.type as string)) {
      this.fallbackLabel = fbKind;
      this.fallbackClient =
        fbKind === "anthropic"
          ? { type: "anthropic", anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }) }
          : { type: "openai" };
    }
    this.compactor = new ContextCompactor();
    this.abortController = new AbortController();
    this.toolState = createToolState(config.cwd);
    this.modeManager = new ModeManager(config.initialMode ?? "act");

    // 会话身份（issue #92：原恒返回 null 的会话恢复死路径已删）
    this.sessionState = createSessionState(config.sessionId ?? generateSessionId());

    // 初始化轨迹记录器
    if (config.enableTrajectory) {
      this.trajectory = createTrajectoryRecorder(
        this.sessionState.sessionId,
        config.model,
        config.cwd,
        { enabled: true, savePath: config.trajectoryPath },
      );
    }

    // shell hooks（issue #51 热加载）：工厂注册，mtime 变更/手动 reload 复用
    initShellHooks(config.cwd, () => this.buildShellHookMatchers());
    this.ruleLayers = resolveRuleLayers(config.cwd);
    this.memoryEntries = loadMemoriesSync(config.cwd);
    this.skillCatalog = formatSkillCatalog(loadSkills(config.cwd));
    setAgentRegistry(loadAgents(config.cwd), config.cwd);
    if (this.ruleLayers.length > 0 && config.verbose) {
      console.log(`\n已加载规则层：${this.ruleLayers.map((l) => l.tier).join(" → ")}`);
    }

    if (this.client.type === "mock") {
      appStore.setState((s) => ({
        ...s,
        toolPermissionContext: { ...s.toolPermissionContext, mode: "bypassPermissions" },
      }));
    }
  }

  /** shell hooks → 注册器（TOFU 信任闸门闭包，issue #20/#51） */
  private buildShellHookMatchers(): HookMatcher[] {
    const workDir = this.config.cwd;
    return loadShellHooks(workDir).map((h): HookMatcher => ({
      event: h.event,
      matcher: h.matcher,
      handler: async (c) => {
        const gate = await ensureHookTrust(workDir, h);
        if (gate === "ask") {
          const yes = await promptHookTrust(h);
          if (answerHookTrust(workDir, h, yes) === "deny") {
            return { block: true, message: "hook 未获信任，已阻止（/hooks clear 可重置后重新询问）" };
          }
        }
        return hookSystem.triggerShellHook(h.command, c, h.timeout);
      },
    }));
  }

  /** 惰性连接 .tupigcode/mcp.json 配置的 MCP server；未配置零变化，失败只降级 */
  private async ensureMcpTools(): Promise<void> {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    try {
      const mcp = await connectMcpServers(
        this.config.cwd,
        (msg) => process.stderr.write(`⚠️  ${msg}\n`),
        (tools) => this.applyMcpTools(tools), // list_changed 动态刷新（issue #59）
      );
      this.applyMcpTools(mcp.tools);
    } catch {
      /* MCP 不可用不影响主流程 */
    }
  }

  /**
   * 同步 MCP 工具集（issue #59）：替换 this.tools 中 mcp_ 前缀工具，
   * markLoaded 常驻 + setSearchPool 重建发现池（新增可搜、移除自然消失）。
   */
  private applyMcpTools(mcpTools: Tool[]): void {
    this.tools = [...this.tools.filter((t) => !t.name.startsWith("mcp_")), ...mcpTools];
    if (mcpTools.length > 0) {
      markLoaded(mcpTools.map((t) => t.name)); // MCP 工具常驻
    }
    setSearchPool(this.tools);
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    await this.ensureMcpTools();
    // doom detector 按用户轮次重置（issue #100）：跨 submitMessage 不累计，保留同轮跨批保护
    this.doomDetector.reset();
    this.doomBatchSigs.clear();
    reloadShellHooksIfChanged(); // hooks.json 热加载（issue #51）：mtime 变更才重载
    // 记录用户消息
    this.trajectory?.recordUserMessage(prompt);

    // 检查模式切换命令
    if (prompt === "/plan") {
      const from = this.modeManager.mode;
      this.modeManager.enterPlan("用户切换到 Plan 模式");
      await fireModeChange(hookSystem, from, this.modeManager.mode, {
        turnNumber: 0, sessionId: appStore.getState().sessionId,
      });
      yield {
        type: "text",
        text: "已切换到 Plan 模式（只读）",
      };
      return;
    }
    if (prompt === "/act") {
      const from = this.modeManager.mode;
      this.modeManager.enterAct("用户切换到 Act 模式");
      await fireModeChange(hookSystem, from, this.modeManager.mode, {
        turnNumber: 0, sessionId: appStore.getState().sessionId,
      });
      yield {
        type: "text",
        text: "已切换到 Act 模式（完整执行）",
      };
      return;
    }

    // UserPromptSubmit（issue #48）：prompt 进模型前触发；block 拒绝本轮（不发请求），
    // additionalContext 注入到本轮消息（prompt 之后）
    const submitResult = await fireUserPromptSubmit(hookSystem, {
      turnNumber: appStore.getState().userPromptCount, // 该条输入的 0-based 序号（issue #69）
      sessionId: this.sessionState?.sessionId ?? "",
      input: { prompt },
    });
    appStore.setState((s) => ({ ...s, userPromptCount: s.userPromptCount + 1 })); // block 也递增（输入已发生）
    if (submitResult.block) {
      yield {
        type: "text",
        text: submitResult.message?.trim() || "用户输入已被 UserPromptSubmit hook 拦截",
      };
      return;
    }

    // 根据模式过滤工具（issue #102-5）：与请求侧 schema / system 目录同源
    const activeTools = this.activeRequestTools();

    yield {
      type: "system",
      subtype: "init",
      model: this.config.model,
      tools: activeTools.map((t) => t.name),
    };

    await fireSessionStart(undefined, {
      turnNumber: 0,
      sessionId: this.sessionState?.sessionId ?? "",
    });

    const toolContext = this.buildToolContext();
    const canUseToolFn = this.buildCanUseToolFn();

    const baseMessages = this.config.initialMessages?.length
      ? [...this.config.initialMessages, { role: "user" as const, content: prompt }]
      : [{ role: "user" as const, content: prompt }];
    const injectedCtx = submitResult.additionalContext?.trim();
    if (injectedCtx) {
      baseMessages.push({
        role: "user" as const,
        content: `<user-prompt-submit-hook additionalContext>\n${injectedCtx}\n</user-prompt-submit-hook>`,
      });
    }
    const loopState: LoopState = {
      messages: baseMessages,
      turnCount: 0,
      compacted: false,
      maxOutputTokensOverride: this.config.maxTokens,
      hasAttemptedReactiveCompact: false,
    };
    this.currentMessages = loopState.messages;

    let hitMaxTurns = false;
    let turnFailed = false; // API 错误（issue #95）：不进成功分支
    let aborted = false; // 中断（issue #95）：同不进成功分支
    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (this.abortController.signal.aborted) { aborted = true; break; }
      loopState.turnCount = turn + 1;

      // 模型主动压缩（issue #41）：上一轮 CompactContext 置信号 → 此处执行
      if (this.pendingCompaction) {
        const focus = this.pendingCompaction.focus;
        this.pendingCompaction = null;
        const hctx = { turnNumber: loopState.turnCount, sessionId: this.sessionState?.sessionId ?? "" };
        await fireCompactPre(undefined, hctx, "model");
        const out = await this.compactor.autoCompact(
          this.client, this.config.model, loopState.messages, focus, "model",
        );
        if (out !== loopState.messages) {
          loopState.messages = out;
          loopState.compacted = true;
          appStore.setState((st) => ({ ...st, compactionCount: st.compactionCount + 1 }));
          const mLine = formatCompactionLine();
          if (mLine) {
            process.stdout.write(chalk.gray(`\n♻️  已压缩（模型请求${focus ? `，焦点：${focus}` : ""}）：${mLine}\n`));
          }
        }
        await fireCompactPost(undefined, hctx, "model");
      }

      // 每 turn 单次构建（issue #102-4）：估算与 executeTurn 共用同一份 tool schema / system 分层
      const turnToolDefs = this.buildToolDefs();
      const turnSysLayers = this.buildSystemLayers(turnToolDefs);
      const turnSystem = turnSysLayers.volatile
        ? `${turnSysLayers.stable}\n\n${turnSysLayers.volatile}`
        : turnSysLayers.stable;
      const estimatedTokens = this.estimateTokens(loopState.messages, turnSystem, turnToolDefs);
      if (
        !loopState.hasAttemptedReactiveCompact &&
        estimatedTokens > MAX_CONTEXT_TOKENS * LADDER_MICRO
      ) {
        const r = this.compactor.compactByLadder(loopState.messages, estimatedTokens, MAX_CONTEXT_TOKENS);
        loopState.hasAttemptedReactiveCompact = true;
        // 等值检查（issue #91）：非 force 档压缩无实际变化（如 9 条 micro 原样返回）
        // → 整段跳过，不 fire hook、不计数、不 recordResult（防假熔断）
        if (
          (r.strategy !== "none" && r.strategy !== "circuit-open") &&
          (r.strategy === "force" || r.messages !== loopState.messages)
        ) {
          const hctx = { turnNumber: loopState.turnCount, sessionId: this.sessionState?.sessionId ?? "" };
          await fireCompactPre(undefined, hctx, "auto");
          // force 档（>95%）：LLM 摘要（openai/anthropic/mock 三链路，失败自动回退预算削减）
          let out = r.messages;
          if (r.strategy === "force") {
            out = await this.compactor.autoCompact(this.client, this.config.model, loopState.messages);
          }
          if (out !== loopState.messages) {
            this.compactor.recordResult(loopState.messages, out, estimatedTokens, MAX_CONTEXT_TOKENS);
            loopState.messages = out;
            loopState.compacted = true;
            appStore.setState((s) => ({ ...s, compactionCount: s.compactionCount + 1 }));
            const cLine = formatCompactionLine();
            if (cLine) process.stdout.write(chalk.gray(`\n♻️  已压缩：${cLine}\n`));
          }
          await fireCompactPost(undefined, hctx, "auto");
        }
      }

      const turnResult = await this.executeTurn(loopState, toolContext, canUseToolFn, {
        toolDefs: turnToolDefs,
        sysLayers: turnSysLayers,
      });

      for (const event of turnResult.events) {
        yield event;
      }

      // API 错误（issue #95）：error result 已随 events 产出，结束循环且不进成功分支
      if (turnResult.stopReason === "error") { turnFailed = true; break; }

      // 中断（issue #98）：不再派发后续工具、不进成功分支
      if (turnResult.stopReason === "aborted" || this.abortController.signal.aborted) {
        aborted = true;
        break;
      }

      if (turnResult.stopReason === "end_turn" || turnResult.stopReason === "stop" || !turnResult.stopReason) {
        break;
      }

      if (turnResult.stopReason === "tool_use" && turnResult.toolResults.length > 0) {
        loopState.messages.push({
          role: "user",
          content: turnResult.toolResults.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error,
          })),
        });
      } else {
        break;
      }

      if (turn + 1 >= this.config.maxTurns) hitMaxTurns = true;
    }

    if (hitMaxTurns) {
      const errorMsg = `已达到最大轮次限制（${this.config.maxTurns} 轮），任务可能未完成`;
      this.trajectory?.recordError(errorMsg);
      yield {
        type: "result",
        subtype: "error",
        result: errorMsg,
        num_turns: loopState.turnCount,
      };
    } else if (turnFailed) {
      // 错误 result 已在 executeTurn 的 events 中产出（issue #95）：不 fireStop、不重复 yield
      this.trajectory?.recordError("API 调用失败，任务未完成");
    } else if (aborted) {
      const msg = "任务已中断";
      this.trajectory?.recordError(msg);
      // 中断也 fire Stop（issue #98 期望）：output 标记 aborted 语义，供 hooks 感知
      await fireStop(undefined, {
        turnNumber: loopState.turnCount,
        sessionId: this.sessionState?.sessionId ?? "",
        output: msg,
      });
      yield {
        type: "result",
        subtype: "error",
        result: msg,
        num_turns: loopState.turnCount,
      };
    } else {
      await fireStop(undefined, {
        turnNumber: loopState.turnCount,
        sessionId: this.sessionState?.sessionId ?? "",
        output: "任务已完成",
      });
      yield {
        type: "result",
        subtype: "success",
        result: "任务已完成",
        num_turns: loopState.turnCount,
      };
    }

    // 保存轨迹
    this.trajectory?.finish();
    const trajectoryPath = this.trajectory?.save();
    if (trajectoryPath && this.config.verbose) {
      console.log(chalk.gray(`\n轨迹已保存：${trajectoryPath}`));
    }

    // routelog 反馈回填（A23 闭环，供画像选型）：错误/中断不记 success（issue #95）
    const feedbackOk = !hitMaxTurns && !turnFailed && !aborted;
    appendRouteFeedback(this.config.cwd, {
      model: this.config.model,
      kind: profileTask(prompt).kind,
      success: feedbackOk,
      oneShot: feedbackOk && loopState.turnCount <= 2,
    });
  }

  /** 请求侧工具集（issue #102-5）：常驻集 × 当前模式过滤，init 事件 / tool schema / system 目录同源 */
  private activeRequestTools(): Tool[] {
    return this.modeManager.filterTools(promptTools(this.tools));
  }

  /** 常驻工具的 Anthropic tool schema（issue #44：估算与请求共用同一构造） */
  private buildToolDefs(): Anthropic.Tool[] {
    const residentTools = this.activeRequestTools();
    return residentTools.map((t) => {
      const raw = (t.jsonSchema as any) ?? zodToJsonSchema(t.inputSchema);
      // 清理 zod-to-json-schema 添加的多余字段
      const { $schema, additionalProperties, ...schema } = raw as any;
      return {
        name: t.name,
        description: t.description(t as any),
        input_schema: schema as Anthropic.Tool["input_schema"],
      };
    });
  }

  /** 清空早期派发遗留（issue #47/#97）：等在途完成并移除其 tool_result/events 条目 */
  private async discardEarlyExecutions(
    earlyExecutions: Map<string, Promise<void>>,
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
    events: SDKMessage[],
  ): Promise<void> {
    if (earlyExecutions.size === 0) return;
    const staleIds = new Set(earlyExecutions.keys());
    await Promise.allSettled([...earlyExecutions.values()]);
    earlyExecutions.clear();
    for (let i = toolResults.length - 1; i >= 0; i--) {
      if (staleIds.has(toolResults[i].tool_use_id)) toolResults.splice(i, 1);
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev: any = events[i];
      if (ev?.type === "tool_result" && staleIds.has(ev.toolUseId)) events.splice(i, 1);
    }
  }

  private async executeTurn(
    loopState: LoopState,
    toolContext: ToolUseContext,
    canUseToolFn: CanUseToolFn,
    // 每 turn 预构建资产（issue #102-4）：submitMessage 与估算共用，缺省自建（测试直连路径）
    assets?: { toolDefs: Anthropic.Tool[]; sysLayers: { stable: string; volatile: string } },
  ): Promise<{
    stopReason: string | null;
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
    events: SDKMessage[];
  }> {
    const events: SDKMessage[] = [];
    const toolDefs: Anthropic.Tool[] = assets?.toolDefs ?? this.buildToolDefs();
    // doom 批内去重边界（issue #100）：轮界清一次——同轮（含 early dispatch 与各批次）共享，
    // 相同调用只 feed 一次；跨轮由 submitMessage 的 detector.reset 拦 ≥3 次
    this.doomBatchSigs.clear();

    const toolBuffers = new Map<string, { id: string; name: string; inputJson: string }>();
    const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
    // 流式早期派发（issue #47）：tool_use 收完即执行只读并发安全工具，流结束复用结果
    const earlyExecutions = new Map<string, Promise<void>>();
    let fullText = "";
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    // system 分层断点（issue #45）：稳定层带 cache_control，易变层排其后（断点后内容不参与缓存键前缀）
    const sysLayers = assets?.sysLayers ?? this.buildSystemLayers(toolDefs);
    const systemInput: Anthropic.TextBlockParam[] = [
      { type: "text", text: sysLayers.stable, cache_control: { type: "ephemeral" } },
      ...(sysLayers.volatile ? [{ type: "text" as const, text: sysLayers.volatile }] : []),
    ];

    for (let attempt = 0; attempt < MAX_OUTPUT_TOKEN_ESCALATION.length; attempt++) {
      // 重试前清空上一轮早期派发（issue #47）：等在途完成并移除其遗留结果
      await this.discardEarlyExecutions(earlyExecutions, toolResults, events);
      toolBuffers.clear();
      fullText = "";
      stopReason = null;
      const eventsMark = events.length; // failover 回滚边界（issue #97）
      const usage = new UsageTracker(); // 每次尝试独立记账（issue #44）

      try {
        const stream = () => streamMessage(
          this.client, this.config.model, loopState.maxOutputTokensOverride,
          systemInput, loopState.messages, toolDefs, this.abortController.signal,
        );
        // 兜底流用云端模型名（issue #98）：本地模型名打到云端必 404，config.fallbackModel 优先
        const fbModel = this.fallbackLabel
          ? resolveFallbackModel(this.fallbackLabel as "anthropic" | "openai", this.config.fallbackModel)
          : this.config.model;
        const fbStream = this.fallbackClient
          ? () => streamMessage(
              this.fallbackClient!, fbModel, loopState.maxOutputTokensOverride,
              systemInput, loopState.messages, toolDefs, this.abortController.signal,
            )
          : null;
        // 切换兜底前回滚本轮已累计状态（issue #97）：文本/工具缓冲/早期派发结果清零，
        // 否则 primary 半截文本与 fallback 全量重复、残留 tool_use_start 变幽灵块
        const onFailoverReset = async () => {
          await this.discardEarlyExecutions(earlyExecutions, toolResults, events);
          toolBuffers.clear();
          fullText = "";
          stopReason = null;
          events.length = eventsMark;
          process.stdout.write("\n");
        };
        for await (const event of streamWithFailover(stream, fbStream, this.fallbackLabel, (l) => {
          process.stdout.write(chalk.yellow(`\n⚡ 本地推理故障，已回退到 ${l}\n`));
          this.trajectory?.recordError(`基础设施故障，回退 ${l}`);
        }, onFailoverReset)) {
          // 中断（issue #98）：signal 已 abort 立即停止消费，mock/未接 signal 链路同样生效
          if (this.abortController.signal.aborted) break;
          switch (event.type) {
            case "text_delta":
              process.stdout.write(event.text);
              fullText += event.text;
              break;
            case "tool_use_start":
              toolBuffers.set(event.id, { id: event.id, name: event.name, inputJson: "" });
              process.stdout.write(chalk.yellow(`\n🔧 ${event.name} `));
              break;
            case "tool_use_delta": {
              const buf = toolBuffers.get(event.id);
              if (buf) buf.inputJson += event.inputJsonDelta;
              break;
            }
            case "tool_use_stop": {
              // 流式早期派发（issue #47）：输入已收完，只读并发安全工具立刻执行，
              // 与模型尾部生成重叠；流结束后在 entries 处过滤复用，不重复执行
              const buf = toolBuffers.get(event.id);
              if (!buf || earlyExecutions.has(buf.id)) break;
              let earlyInput: Record<string, unknown>;
              try { earlyInput = JSON.parse(buf.inputJson || "{}") as Record<string, unknown>; } catch { break; }
              const earlyTool = getToolByName(this.tools, buf.name);
              if (!earlyTool || !earlyTool.isReadOnly(earlyInput) || !earlyTool.isConcurrencySafe(earlyInput)) break;
              earlyExecutions.set(
                buf.id,
                this.runToolBuffer(buf, earlyInput, earlyTool, toolContext, canUseToolFn, loopState, events, toolResults)
                  .catch((err: unknown) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.recordToolFailure(buf, earlyInput, errMsg, loopState, events, toolResults);
                  }),
              );
              break;
            }
            case "message_start":
              // 首帧 usage 记入（Anthropic 的 input_tokens 在 message_start，issue #44）
              usage.record((event.message as any)?.usage);
              break;
            case "message_delta":
              stopReason = event.stopReason;
              // 末帧（非首帧）非零 usage 优先，input 含 cache 字段全量
              usage.record(event.usage);
              break;
            case "message_stop": break;
          }
        }
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
        // 中断（issue #98）：流被 abort 后不当成功/错误路径，交 submitMessage 走 aborted 分支
        if (this.abortController.signal.aborted) {
          await Promise.allSettled([...earlyExecutions.values()]);
          return { stopReason: "aborted", toolResults: [], events };
        }
        // 链路正常返回的 max_tokens 截断（issue #96）：与异常路径同权升级重试，耗尽即失败
        if (stopReason === "max_tokens") {
          const next = nextOutputTokenEscalation(loopState.maxOutputTokensOverride);
          if (next !== null && attempt < MAX_OUTPUT_TOKEN_ESCALATION.length - 1) {
            loopState.maxOutputTokensOverride = next;
            process.stdout.write(chalk.yellow(`\n⚠️  输出被 max_tokens 截断，正在以 ${next} 重试...\n`));
            continue;
          }
          const errMsg = `输出被 max_tokens 截断（${loopState.maxOutputTokensOverride}），升级重试已耗尽，任务未完成`;
          process.stdout.write(chalk.red(`\n❌ ${errMsg}\n`));
          // 错误返回前等在途早期派发落地（issue #99）：否则后台结果与 events 脱钩
          await Promise.allSettled([...earlyExecutions.values()]);
          return {
            stopReason: "error", toolResults,
            events: [...events, { type: "result", subtype: "error", result: errMsg }],
          };
        }
        break;
      } catch (err: any) {
        // 中断（issue #98）：abort 引发的 AbortError 不当 API 错误（不 fire error result、不升级重试）
        if (this.abortController.signal.aborted) {
          await Promise.allSettled([...earlyExecutions.values()]);
          return { stopReason: "aborted", toolResults: [], events };
        }
        if (err?.message?.includes("max_tokens") && attempt < MAX_OUTPUT_TOKEN_ESCALATION.length - 1) {
          const next = nextOutputTokenEscalation(loopState.maxOutputTokensOverride);
          if (next !== null) {
            loopState.maxOutputTokensOverride = next;
            process.stdout.write(chalk.yellow(`\n⚠️  输出 Token 超限，正在以 ${loopState.maxOutputTokensOverride} 重试...\n`));
            continue;
          }
        }

        // 上下文溢出自动恢复（issue #24）：压缩重建 messages 后重试本轮，限 2 次
        if (this.overflowRecovery.shouldRetry(err)) {
          const hctx = { turnNumber: loopState.turnCount, sessionId: this.sessionState?.sessionId ?? "" };
          await fireCompactPre(undefined, hctx, "auto");
          const recovered = await this.overflowRecovery.recover(
            this.compactor, this.client, this.config.model, loopState.messages,
          );
          if (recovered !== loopState.messages) {
            loopState.messages = recovered;
            appStore.setState((st) => ({ ...st, compactionCount: st.compactionCount + 1 }));
            this.trajectory?.recordError(`上下文溢出，自动压缩恢复（第 ${this.overflowRecovery.attempts} 次）`);
            await fireCompactPost(undefined, hctx, "auto");
            const oLine = formatCompactionLine();
            process.stdout.write(chalk.yellow(`\n⚠️  上下文超限，已自动压缩并重试（${this.overflowRecovery.attempts}/${MAX_OVERFLOW_RETRIES}）${oLine ? `：${oLine}` : ""}...\n`));
            attempt--; // 溢出恢复不消耗 max_tokens 升级额度（互不干扰）
            continue;
          }
        }

        process.stdout.write(chalk.red(`\n❌ API 错误：${err?.message || err}\n`));
        // 错误返回前等在途早期派发落地（issue #99）：异常进 recordToolFailure 写的仍是有效数组
        await Promise.allSettled([...earlyExecutions.values()]);
        return {
          stopReason: "error", toolResults,
          events: [...events, { type: "result", subtype: "error", result: String(err) }],
        };
      }
    }

    if (resolveHarness() === "xml" && toolBuffers.size === 0 && stopReason !== "error") {
      const calls = parseXmlToolCalls(fullText);
      for (const c of calls) {
        const id = `xmtool_${Date.now()}_${toolBuffers.size}`;
        toolBuffers.set(id, { id, name: c.name, inputJson: c.parseError ? "___bad_json___" : JSON.stringify(c.input) });
        process.stdout.write(chalk.yellow(`\n🔧 ${c.name} `));
      }
      if (calls.length > 0) stopReason = "tool_use";
    }

    // 流正常结束但无 finish_reason / message_delta（issue #102）：
    // OpenAI 缺 finish_reason 时 stopReason 保持 null，此前被 submitMessage
    // 当 end_turn 走成功语义——按不完整响应处理，不 fireStop 成功
    if (stopReason === null) {
      const errMsg = "流结束但未收到 finish_reason（响应不完整），任务未完成";
      process.stdout.write(chalk.red(`\n❌ ${errMsg}\n`));
      await Promise.allSettled([...earlyExecutions.values()]);
      return {
        stopReason: "error", toolResults,
        events: [...events, { type: "result", subtype: "error", result: errMsg }],
      };
    }

    if (toolBuffers.size > 0) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (fullText) content.push({ type: "text", text: fullText });
      for (const [, buf] of toolBuffers) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(buf.inputJson || "{}"); } catch {
          content.push({ type: "tool_use", id: buf.id, name: buf.name, input: {} });
          // 事件配对（issue #102）：tool_result 必须有对应 tool_use，否则消费端事件流断链
          events.push({ type: "tool_use", toolName: buf.name, input: {}, toolUseId: buf.id });
          toolResults.push({
            tool_use_id: buf.id,
            content: `错误：工具输入 JSON 解析失败，请检查参数格式`,
            is_error: true,
          });
          events.push({
            type: "tool_result", toolUseId: buf.id,
            content: `错误：工具输入 JSON 解析失败，请检查参数格式`, isError: true,
          });
          continue;
        }
        content.push({ type: "tool_use", id: buf.id, name: buf.name, input });
        events.push({ type: "tool_use", toolName: buf.name, input, toolUseId: buf.id });
      }
      loopState.messages.push({ role: "assistant", content });

      // 早期派发的工具可能仍在执行：先等全部落地（结果已在 toolResults/events）
      if (earlyExecutions.size > 0) await Promise.allSettled([...earlyExecutions.values()]);

      const entries: Array<{ buf: { id: string; name: string; inputJson: string }; input: Record<string, unknown> | null }> = [];
      for (const [, buf] of toolBuffers) {
        if (earlyExecutions.has(buf.id)) continue; // 已在流式期间执行（issue #47）
        let input: Record<string, unknown> | null = null;
        try { input = JSON.parse(buf.inputJson || "{}"); } catch { input = null; }
        if (input) entries.push({ buf, input });
      }
      const isSafe = (e: { buf: { name: string }; input: Record<string, unknown> | null }) => {
        if (!e.input) return false;
        const t = getToolByName(this.tools, e.buf.name);
        return !!t && t.isReadOnly(e.input) && t.isConcurrencySafe(e.input);
      };
      // 写工具（非只读且带 file_path）：相邻写单项批合并为写组批，组内按文件保序、组间并行（issue #57）
      const isWriteItem = (e: { buf: { name: string }; input: Record<string, unknown> | null }) => {
        if (!e.input) return false;
        const t = getToolByName(this.tools, e.buf.name);
        if (!t || t.isReadOnly(e.input)) return false;
        return typeof e.input.file_path === "string";
      };
      type Seg = { write: boolean; entries: typeof entries };
      const segments: Seg[] = [];
      for (const batch of partitionRuns(entries, isSafe)) {
        const write = batch.length === 1 && isWriteItem(batch[0]);
        const last = segments[segments.length - 1];
        if (write && last?.write) last.entries.push(batch[0]);
        else segments.push({ write, entries: [...batch] });
      }
      for (const seg of segments) {
        if (seg.write) {
          await this.runWriteGroup(seg.entries, toolContext, canUseToolFn, loopState, events, toolResults);
        } else {
          await this.runBatch(seg.entries, toolContext, canUseToolFn, loopState, events, toolResults);
        }
      }

      stopReason = "tool_use";
    } else {
      loopState.messages.push({ role: "assistant", content: fullText });
    }

    this.currentMessages = loopState.messages;
    appStore.setState((s) => ({
      ...s,
      tokenUsage: {
        input: s.tokenUsage.input + inputTokens,
        output: s.tokenUsage.output + outputTokens,
      },
    }));

    process.stdout.write("\n");
    return { stopReason, toolResults, events };
  }

  /**
   * 批次级闸门（issue #43/#57）：批间顺序执行——safe 批可并行，非只读无 file_path 的
   * 不安全项（如 Bash）由 partitionRuns 独立成批顺序跑；带 file_path 的写项已由
   * runWriteGroup 按文件分组处理（见下）。批内并行 fail-soft——单任务异常只产生
   * 自己的 error tool_result，不误伤兄弟。
   */
  /** 批内/早期派发异常兜底（issue #43/#47）：自己的 error tool_result + PostToolUseFailure */
  private recordToolFailure(
    buf: { id: string; name: string },
    input: Record<string, unknown> | null,
    errMsg: string,
    loopState: LoopState,
    events: any[],
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  ): void {
    process.stdout.write(chalk.red(`\n❌ ${errMsg}\n`));
    if (!toolResults.some((r) => r.tool_use_id === buf.id)) {
      toolResults.push({ tool_use_id: buf.id, content: errMsg, is_error: true });
      events.push({ type: "tool_result", toolUseId: buf.id, content: errMsg, isError: true });
    }
    void firePostToolUseFailure(hookSystem, {
      toolName: buf.name, input: input ?? {}, output: errMsg, durationMs: 0,
    }, { turnNumber: loopState.turnCount, sessionId: appStore.getState().sessionId });
    this.trajectory?.recordError(errMsg);
  }

  private async runBatch(
    batch: Array<{ buf: { id: string; name: string; inputJson: string }; input: Record<string, unknown> | null }>,
    toolContext: ToolUseContext,
    canUseToolFn: CanUseToolFn,
    loopState: LoopState,
    events: any[],
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  ): Promise<void> {
    this.doomBatchSigs.clear(); // 批界（issue #100）
    const runOne = async (e: { buf: { id: string; name: string; inputJson: string }; input: Record<string, unknown> | null }) => {
      await this.runToolBuffer(e.buf, e.input ?? {}, getToolByName(this.tools, e.buf.name), toolContext, canUseToolFn, loopState, events, toolResults);
    };
    if (batch.length === 1) {
      await runOne(batch[0]);
      return;
    }
    const settled = await mapWithConcurrency(batch, 4, runOne);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status !== "rejected") continue;
      const e = batch[i];
      const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      this.recordToolFailure(e.buf, e.input, errMsg, loopState, events, toolResults);
    }
  }

  /**
   * 写组批（issue #57）：同 file_path 保序串行（组内逐项 fail-soft，前项失败不连坐后项），
   * 异文件组间并行（resolveWriteConcurrency，TUPIG_WRITE_CONCURRENCY 可调）；
   * 批段间仍顺序执行，与 safe 批/其他写项保持原闸门。
   * 已接受边界（issue #74）：分组 key 用 resolvePath 字面规范化、不解析 symlink——
   * 同一轮用两个别名路径（如 a.ts 与指向它的 link.ts）写同一物理文件会落不同分组，
   * 绕过保序；触发需工作区含 symlink + 模型同轮双别名写，极低频，接受现状不修。
   */
  private async runWriteGroup(
    entries: Array<{ buf: { id: string; name: string; inputJson: string }; input: Record<string, unknown> | null }>,
    toolContext: ToolUseContext,
    canUseToolFn: CanUseToolFn,
    loopState: LoopState,
    events: any[],
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  ): Promise<void> {
    this.doomBatchSigs.clear(); // 批界（issue #100）
    const keyOf = (e: { input: Record<string, unknown> | null }): string | null => {
      const fp = e.input?.file_path;
      if (typeof fp !== "string" || !fp) return null;
      try {
        return resolvePath(toolContext.workDir, fp);
      } catch {
        return fp;
      }
    };
    const groups = partitionWriteGroups(entries, keyOf);
    if (groups.length === 1) {
      for (const e of groups[0]) {
        try {
          await this.runToolBuffer(e.buf, e.input ?? {}, getToolByName(this.tools, e.buf.name), toolContext, canUseToolFn, loopState, events, toolResults);
        } catch (err) {
          this.recordToolFailure(e.buf, e.input, err instanceof Error ? err.message : String(err), loopState, events, toolResults);
        }
      }
      return;
    }
    const runGroup = async (g: typeof entries): Promise<void> => {
      for (const e of g) {
        try {
          await this.runToolBuffer(e.buf, e.input ?? {}, getToolByName(this.tools, e.buf.name), toolContext, canUseToolFn, loopState, events, toolResults);
        } catch (err) {
          this.recordToolFailure(e.buf, e.input, err instanceof Error ? err.message : String(err), loopState, events, toolResults);
        }
      }
    };
    const settled = await mapWithConcurrency(groups, resolveWriteConcurrency(), runGroup);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status !== "rejected") continue;
      const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      for (const e of groups[i]) {
        if (!toolResults.some((r) => r.tool_use_id === e.buf.id)) {
          this.recordToolFailure(e.buf, e.input, errMsg, loopState, events, toolResults);
        }
      }
    }
  }

  private async runToolBuffer(
    buf: { id: string; name: string; inputJson: string },
    input: Record<string, unknown>,
    tool: Tool | undefined,
    toolContext: ToolUseContext,
    canUseToolFn: CanUseToolFn,
    loopState: LoopState,
    events: any[],
    toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  ): Promise<void> {
      const permission = await canUseToolFn(buf.name, input);
      this.trajectory?.record("permission", {
        toolName: buf.name,
        behavior: permission.behavior,
        reason: (permission as any).decisionReason ?? (permission as any).message ?? "",
      });
      const permSource =
        (permission as any).decisionReason ?? (permission as any).message ?? undefined;
      const firePerm = (decision: "allow" | "deny" | "always", source?: string) => {
        void firePermissionResult(hookSystem, {
          toolName: buf.name, decision, ruleSource: source ?? permSource,
        }, { turnNumber: loopState.turnCount, sessionId: appStore.getState().sessionId });
      };

      // 应用权限层改写（plan 模式 staging 暂存等，issue #18）
      if (permission.behavior !== "deny" && (permission as any).updatedInput) {
        input = (permission as any).updatedInput;
      }

      if (permission.behavior === "deny") {
        const msg = permission.message || "已拒绝";
        firePerm("deny", permSource);
        process.stdout.write(chalk.red(`\n🚫 ${msg}\n`));
        toolResults.push({ tool_use_id: buf.id, content: msg, is_error: true });
        events.push({ type: "tool_result", toolUseId: buf.id, content: msg, isError: true });
        return;
      }

      if (permission.behavior === "ask") {
        const decision = await promptUserDecision(buf.name, input);
        if (decision === "deny") {
          firePerm("deny", "交互拒绝");
          toolResults.push({ tool_use_id: buf.id, content: "用户已拒绝", is_error: true });
          events.push({ type: "tool_result", toolUseId: buf.id, content: "用户已拒绝", isError: true });
          return;
        }
        firePerm(decision === "always" ? "always" : "allow", decision === "always" ? "交互:总是允许" : "交互:单次允许");
        if (decision === "always") {
          process.stdout.write(chalk.green(`\n✓ 已持久化「总是允许」：${deriveAlwaysPattern(buf.name, input)}（/permissions clear 清除）\n`));
        }
      } else {
        firePerm("allow", permSource);
      }

      const hookResult = await hookSystem.trigger("PreToolUse", {
        toolName: buf.name, input,
        turnNumber: loopState.turnCount,
        sessionId: appStore.getState().sessionId,
      });

      if (hookResult.block) {
        const msg = hookResult.message || "已被 Hook 阻断";
        process.stdout.write(chalk.red(`\n🚫 ${msg}\n`));
        toolResults.push({ tool_use_id: buf.id, content: msg, is_error: true });
        events.push({ type: "tool_result", toolUseId: buf.id, content: msg, isError: true });
        return;
      }

      if (tool) {
        const parsed = tool.inputSchema.safeParse(input);
        if (!parsed.success) {
          const errMsg = `输入校验失败：${parsed.error.errors.map((e: any) => e.message).join(", ")}`;
          process.stdout.write(chalk.red(`\n❌ ${errMsg}\n`));
          toolResults.push({ tool_use_id: buf.id, content: errMsg, is_error: true });
          events.push({ type: "tool_result", toolUseId: buf.id, content: errMsg, isError: true });
          return;
        }

        // 流式锁已移除（issue #43）：同批只读工具并发执行不再互斥，
        // 写/不安全项由 partitionRuns 独立成批 + 批间顺序循环天然互斥
        // doom loop（issue #100）：签名只在同一批内计一次——批内并行的相同只读调用是合法行为，
        // 不构成循环；跨批/跨轮重复仍累计，连续 ≥3 轮同动作才拦
        const doomSig = JSON.stringify({ name: buf.name, input });
        if (!this.doomBatchSigs.has(doomSig)) {
          this.doomBatchSigs.add(doomSig);
          if (this.doomDetector.feed(doomSig)) {
            const errMsg = "检测到连续重复动作（doom loop），已中断。请换一种方式完成任务。";
            process.stdout.write(chalk.red(`\n🛑 ${errMsg}\n`));
            toolResults.push({ tool_use_id: buf.id, content: errMsg, is_error: true });
            events.push({ type: "tool_result", toolUseId: buf.id, content: errMsg, isError: true });
            this.trajectory?.recordError(errMsg);
            return;
          }
        }

        // 记录工具调用
        this.trajectory?.recordToolUse(buf.name, input, buf.id);
        const toolStartTime = Date.now();

        process.stdout.write(chalk.gray("⏳ "));
        let result;
        // per-call AbortController（issue #99）：超时即 abort，工具读 context.abortController 可真取消
        const callAc = new AbortController();
        const callCtx = { ...toolContext, abortController: callAc };
        // 引擎中断联动（issue #98）：Ctrl+C → interrupt() → 在途工具一并 abort
        const onEngineAbort = () => callAc.abort();
        this.abortController.signal.addEventListener("abort", onEngineAbort, { once: true });
        const isReadOnlyTool = tool.isReadOnly(parsed.data);
        try {
          result = await withTimeout(
            tool.call(parsed.data, callCtx as ToolUseContext, canUseToolFn),
            TOOL_TIMEOUT_MS, `工具 ${buf.name}`,
            {
              controller: callAc,
              sideEffectHint: isReadOnlyTool ? undefined : "写类操作可能已部分落盘，请核对文件状态",
            },
          );
        } catch (e) {
          if (this.abortController.signal.aborted) {
            // 中断引发的 abort（issue #98）：不按工具失败计，不 fire PostToolUseFailure
            const msg = "任务已中断，工具调用已取消";
            toolResults.push({ tool_use_id: buf.id, content: msg, is_error: true });
            events.push({ type: "tool_result", toolUseId: buf.id, content: msg, isError: true });
            return;
          }
          const errMsg = e instanceof Error ? e.message : String(e);
          void firePostToolUseFailure(hookSystem, {
            toolName: buf.name, input, output: errMsg,
            durationMs: Date.now() - toolStartTime,
          }, { turnNumber: loopState.turnCount, sessionId: appStore.getState().sessionId });
          process.stdout.write(chalk.red(`\n❌ ${errMsg}\n`));
          toolResults.push({ tool_use_id: buf.id, content: errMsg, is_error: true });
          events.push({ type: "tool_result", toolUseId: buf.id, content: errMsg, isError: true });
          this.trajectory?.recordError(errMsg);
          return;
        } finally {
          this.abortController.signal.removeEventListener("abort", onEngineAbort);
        }

        // 记录工具执行状态
        const filePath = (input as any).file_path || (input as any).path;
        const operation = buf.name === "Write" ? "write" : buf.name === "Edit" ? "edit" : undefined;
        recordToolExecution(this.toolState, buf.name, filePath, operation);

        const resultStr = result.resultForAssistant || JSON.stringify(result.data);
        // 工具级错误（issue #99）：isError/output=error → is_error + PostToolUseFailure（不再当成功）
        const toolErr = isToolResultError(result);
        toolResults.push({ tool_use_id: buf.id, content: anthropicToolResultContent(result, resultStr) as never, is_error: toolErr });
        events.push({ type: "tool_result", toolUseId: buf.id, content: resultStr, isError: toolErr });

        // 记录工具结果
        const toolDuration = Date.now() - toolStartTime;
        this.trajectory?.recordToolResult(buf.id, resultStr, toolErr, toolDuration);

        process.stdout.write(toolErr ? chalk.red(`❌（${resultStr.length} 字符）\n`) : chalk.green(`✅（${resultStr.length} 字符）\n`));

        if (toolErr) {
          // 工具级错误（issue #99）：错误结果同样进 PostToolUseFailure（含 durationMs）
          void firePostToolUseFailure(hookSystem, {
            toolName: buf.name, input, output: resultStr,
            durationMs: toolDuration,
          }, { turnNumber: loopState.turnCount, sessionId: appStore.getState().sessionId });
        } else {
          await hookSystem.trigger("PostToolUse", {
            toolName: buf.name, input, output: resultStr,
            turnNumber: loopState.turnCount,
            sessionId: appStore.getState().sessionId,
            durationMs: toolDuration,
          });
        }

        // 自动快照（issue #14）：写类工具成功后（防抖 5s；无改动/非 git 静默）；错误结果不快照
        if (!toolErr && process.env.TUPIG_AUTOSNAPSHOT !== "0" && WRITE_SNAP_TOOLS.has(buf.name)) {
          void autoSnapshot(toolContext.workDir, `auto:tool:${buf.name}`).catch(() => {});
        }
      } else {
        const errMsg = `未知工具：${buf.name}`;
        toolResults.push({ tool_use_id: buf.id, content: errMsg, is_error: true });
        events.push({ type: "tool_result", toolUseId: buf.id, content: errMsg, isError: true });
      }
  }

  private buildToolContext(): ToolUseContext {
    return {
      options: {
        debug: this.config.verbose || false,
        mainLoopModel: this.config.model,
        tools: this.tools,
        verbose: this.config.verbose || false,
        isNonInteractiveSession: false,
      },
      abortController: this.abortController,
      readFileState: this.readFileState,
      getMessages: () => this.currentMessages as any,
      workDir: this.config.cwd,
      sessionId: appStore.getState().sessionId,
      requestCompaction: (focus?: string) => {
        if (!this.pendingCompaction) {
          this.pendingCompaction = { focus: focus?.trim() || undefined };
        }
      },
    };
  }

  private buildCanUseToolFn(): CanUseToolFn {
    return async (toolName, input) => {
      const tool = getToolByName(this.tools, toolName);
      const state = appStore.getState();
      return canUseTool(toolName, input, tool, state.toolPermissionContext);
    };
  }

  /** system 分层（issue #45 prompt cache）：稳定层供缓存断点，易变层（状态/变更史）排断点之后不破坏前缀 */
  private buildSystemLayers(toolDefs: Anthropic.Tool[] = []): { stable: string; volatile: string } {
    void toolDefs;
    let planSpec: string | undefined;
    if (this.modeManager.mode === "plan") {
      const specs = listSpecs(this.config.cwd);
      planSpec = (specs.find((s) => s.status === "approved") ?? specs[0])?.name;
    }
    const stateText =
      (formatToolStateForPrompt(this.toolState) + renderTodoState(appStore.getState().todoState ?? null)) || undefined;
    const stable = renderSystemPrompt(this.activeRequestTools(), {
      planSpec,
      rulesText: this.ruleLayers.length ? formatLayersForPrompt(this.ruleLayers) : undefined,
      memoryText: this.memoryEntries.length ? formatMemoriesForPrompt(this.memoryEntries) : undefined,
      skillCatalog: this.skillCatalog || undefined,
      append: this.config.appendSystemPrompt || undefined,
    });
    const volatile = [
      stateText ? `## 当前状态\n${stateText}` : "",
      this.lineageText ? `## 近期变更\n${this.lineageText}` : "",
    ].filter(Boolean).join("\n\n");
    return { stable, volatile };
  }

  /** 稳定层 + 易变层拼接的完整 system（估算与兼容口径，issue #44/#45） */
  private buildSystemPrompt(toolDefs: Anthropic.Tool[] = []): string {
    const { stable, volatile } = this.buildSystemLayers(toolDefs);
    return volatile ? `${stable}\n\n${volatile}` : stable;
  }

  /** 预取变更史摘要（issue #22）：失败/超时静默为空，不阻塞主流程 */
  async preloadLineage(): Promise<void> {
    try {
      this.lineageText = await getLineage(this.config.cwd, this.client, this.config.model);
    } catch {
      this.lineageText = "";
    }
  }

  /** messages 字符数增量缓存（issue #102-4）：只在数组尾部追加时增量累加，换引用/缩短则全量重算 */
  private estMsgCache: { ref: Anthropic.MessageParam[]; count: number; sum: number } | null = null;

  /**
   * messages 段 JSON 字符数，与 JSON.stringify(messages).length 等值。
   * 等值拆分：`[` `]` 2 字符 + 各元素字符数之和 + 元素间逗号 (count-1)。
   * 假设引擎对 messages 只有 push 与整体替换（已确认无 splice/pop/原地改写）。
   */
  private messageChars(messages: Anthropic.MessageParam[]): number {
    const cache = this.estMsgCache;
    if (cache && cache.ref === messages && cache.count <= messages.length) {
      for (let i = cache.count; i < messages.length; i++) {
        const s = JSON.stringify(messages[i]);
        // 数组内 undefined/function 序列化为 "null"（4 字符）
        cache.sum += s === undefined ? 4 : s.length;
      }
      cache.count = messages.length;
    } else {
      let sum = 0;
      for (let i = 0; i < messages.length; i++) {
        const s = JSON.stringify(messages[i]);
        sum += s === undefined ? 4 : s.length;
      }
      this.estMsgCache = { ref: messages, count: messages.length, sum };
    }
    const { count, sum } = this.estMsgCache!;
    return 2 + sum + Math.max(count - 1, 0);
  }

  /** 估算上下文 token（issue #44）：messages + system prompt + tool schema 同按 chars/4 口径 */
  private estimateTokens(
    messages: Anthropic.MessageParam[],
    system?: string,
    toolDefs?: Anthropic.Tool[],
  ): number {
    try {
      const msgChars = this.messageChars(messages);
      const sysChars = system?.length ?? 0;
      const toolChars = toolDefs ? (JSON.stringify(toolDefs)?.length ?? 0) : 0;
      return Math.ceil((msgChars + sysChars + toolChars) / 4);
    } catch {
      this.estMsgCache = null;
      return 0;
    }
  }

  interrupt(): void {
    this.abortController.abort();
  }

  /** 是否已请求中断（SIGINT 二按判定，issue #98） */
  get interrupted(): boolean {
    return this.abortController.signal.aborted;
  }

  getTools(): Tool[] {
    return this.tools;
  }

  getSessionMessages(): Anthropic.MessageParam[] {
    return this.currentMessages;
  }
}

export async function* query(params: {
  prompt: string;
  initialMessages?: Anthropic.MessageParam[];
  options?: Partial<QueryEngineConfig>;
}): AsyncGenerator<SDKMessage, void, unknown> {
  const cwd = params.options?.cwd ?? process.cwd();
  // 上下文 token 传给路由（issue #102）：resume 会话 initialMessages 可能很大，
  // 不传则 router 的 easy-ctx>=14k→8b 死分支永远不可达
  const ctxChars =
    JSON.stringify(params.initialMessages ?? []).length + params.prompt.length;
  const route = routeTask({
    prompt: params.prompt,
    model: params.options?.model,
    env: process.env,
    workDir: cwd,
    contextTokens: Math.ceil(ctxChars / 4),
  });
  appendRouteLog(params.prompt, route, cwd);
  resetTurnOps(); // 清理上一入口（single/spec 等）遗留的写操作，避免审查串轮

  const engine = new QueryEngine({
    cwd,
    maxTokens: 8192,
    maxTurns: 20,
    ...params.options,
    model: route.model,
    routeProvider: route.provider,
    initialMessages: params.initialMessages,
  });

  await engine.preloadLineage(); // 变更史摘要（失败静默跳过，~5s 超时兜底）
  activeEngine = engine; // 注册活跃 turn（issue #98）：供 SIGINT 优雅中断
  try {
    yield* engine.submitMessage(params.prompt);
  } finally {
    activeEngine = null;
  }
  yield { type: "session", messages: engine.getSessionMessages() };
}

// ─── Ctrl+C 优雅中断接线（issue #98） ───────────────────────────────────────────
// 每次 query() 注册活跃 engine；turn 进行中 SIGINT → interrupt() 结束流/取消工具，
// 替代直接 process.exit(130)。无活跃 turn（REPL 空闲）时调用方维持原抢救+退出行为。
let activeEngine: QueryEngine | null = null;

/**
 * 中断当前进行中的 turn。返回是否有活跃 turn 可中断：
 * true → 已请求优雅中断，调用方应继续等待本轮结束（不要 exit）；
 * false → 无活跃 turn，调用方走原有的抢救会话 + 退出。
 */
export function interruptActiveTurn(): boolean {
  if (!activeEngine) return false;
  activeEngine.interrupt();
  return true;
}

/** 活跃 turn 是否已请求过中断（供 SIGINT 区分首按/二按：二按强制退出） */
export function activeTurnInterrupted(): boolean {
  return activeEngine?.interrupted ?? false;
}
