#!/usr/bin/env node
/**
 * index.ts — CLI 入口 + REPL
 */
import { Command } from "commander";
import chalk from "chalk";
import { parseOptimizeCommand, optimizePrompt, needsClarification, appendPromptStyle } from "./engine/prompt-optimize.js";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { createInterface, Interface } from "readline";
import { TurnGate } from "./services/turn-gate.js";
import { snapshot, listCheckpoints, rollbackCheckpoint, rewind, autoSnapshot, pruneCheckpoints } from "./session/checkpoint.js";
import {
  drainTurnOps, buildReview, decideGlobal, decideFile, decideHunk,
  renderFileDiff, rollbackOps, applyHunkDecision, type FileOp,
} from "./engine/diff-review.js";
import { applyStaged, listStaged } from "./engine/staging.js";
import { listTrust, clearTrust } from "./engine/hook-trust.js";
import { fireCompactPre, fireCompactPost, runClearSequence, fireRewindPost, fireNotification } from "./engine/hook-events.js";
import { hookSystem, reloadShellHooks } from "./engine/hooks.js";
import { createIdleNotifier, resolveIdleNotifyMs } from "./services/idle-notify.js";
import { ContextCompactor, estimateTokens } from "./context/compact/index.js";
import { formatCompactionLine } from "./engine/compaction-meta.js";
import { contextBreakdown } from "./context/breakdown.js";
import { createClient, resolveModel } from "./services/api.js";
import { getDefaultTools } from "./engine/tool-registry.js";
import { renderSystemPrompt } from "./engine/prompt.js";
import { loadMemoriesSync } from "./knowledge/memory.js";
import {
  saveSessionMessages, loadSessionMessages, listSessions, forkMessages,
  rescueSessionSync, listInterruptedSessions, formatInterruptedNotice,
  formatSessionRow,
} from "./session/session.js";
import { stageMemory, commitMemory, loadMemories, formatMemoriesForPrompt } from "./knowledge/memory.js";
import { loadSkills, resolveSkill } from "./knowledge/skills.js";
import { createSpec, listSpecs, loadSpec, buildWaves, parseTasks, approveSpec } from "./modes/spec.js";
import { runDoctor, renderDoctor, initAgentMd, buildReviewPrompt, isValidRef } from "./commands/diag.js";
import { buildRetroPrompt, parseReviewDecision, applyReviewDecision, extractFailures } from "./knowledge/reflexion.js";
import { promptUserDecision } from "./services/permissions.js";
import { loadAlwaysAllow, clearAlwaysAllow } from "./services/approval-store.js";
import type Anthropic from "@anthropic-ai/sdk";
import { query, interruptActiveTurn, activeTurnInterrupted, type SDKMessage } from "./engine/QueryEngine.js";
import { appStore, adoptSessionId } from "./state/AppState.js";

import { createRequire } from "module";
const requirePkg = createRequire(import.meta.url);
const VERSION: string = (requirePkg("../package.json") as { version: string }).version;

function printBanner(): void {
  console.log(chalk.cyan.bold(`
╔══════════════════════════════════════════╗
║     TupigCode v${VERSION}                ║
║     AI 编程助手（Claude Code 架构）       ║
╚══════════════════════════════════════════╝
`));
  console.log(chalk.gray("输入您的需求。命令：/help /clear /cost /model /quit\n"));
}

function printHelp(): void {
  console.log(chalk.cyan(`
命令：
  /help     显示帮助
  /clear    清空对话历史
  /cost     查看 Token 用量
  /model    查看当前模型
  /checkpoint [new|list|rollback <id>]  会话检查点/回滚
  /rewind [chat|code|all] [id|label]   三档回卷（默认 all，缺省=最新，支持名称匹配）
  /apply                              落盘 plan 模式暂存改动
  /hooks [clear|reload]               查看/清除 hook 信任（TOFU）/ 重载 hooks.json
  /permissions [clear]                查看/清除「总是允许」持久规则
  /compact [focusing on X]            手动压缩上下文（可带焦点指令）
  /context                            上下文占用分段明细（system/消息/工具结果/schema/记忆）
  /skills  技能目录
  /skill <name>  加载技能全文
  /remember [内容]  查看/存入记忆（存入需确认）
  /spec new|list|show|waves|approve  spec 三件套与计划批准
  /doctor  环境与配置体检
  /init [--force]  生成 AGENTS.md
  /review [ref]  只读评审未提交改动（或对某 ref 的 diff）
  /retro         会话复盘：discard/merge/skill/rule 四选一，草稿入 staging
  /sessions  历史会话列表
  /resume [id]        恢复会话（无 id 列出最近会话）
  /fork <id> <条数>   从历史分叉
  /quit     退出

或直接用自然语言描述您的任务。
`));
}

function handleSDKMessage(msg: SDKMessage): void {
  switch (msg.type) {
    case "text":
      process.stdout.write(chalk.cyan(`\n${msg.text}\n`));
      break;
    case "tool_use": break;
    case "tool_result": break;
    case "result":
      if (msg.subtype === "error") {
        process.stdout.write(chalk.red(`\n✗ ${msg.result}\n`));
      }
      break;
    case "system":
      if (msg.subtype === "init") {
        process.stdout.write(chalk.gray(`模型：${msg.model} | 工具：${msg.tools.join(", ")}\n\n`));
      }
      break;
  }
}

async function startREPL(): Promise<void> {
  printBanner();
  let sessionHistory: Anthropic.MessageParam[] = [];
  let sessionId = `s-${Date.now().toString(36)}`;
  adoptSessionId(sessionId);

  // 启动检测 Ctrl+C 打断的孤儿会话（issue #27）
  const notice = formatInterruptedNotice(listInterruptedSessions(appStore.getState().workDir));
  if (notice) console.log(chalk.yellow(`\n${notice}\n`));

  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("❯ "),
  });

  // SIGINT 同步落盘（issue #27）：不等 Promise，直接写 interrupted 标记
  // turn 进行中 → interrupt() 优雅中断，不直接退出；空闲 → 落盘 + 退出（issue #98）
  const onSignal = () => {
    const already = activeTurnInterrupted(); // 请求前状态：首按 false、二按 true
    if (interruptActiveTurn() && !already) {
      console.log(chalk.yellow("\n已请求中断，正在结束当前任务…（再次 Ctrl+C 强制退出）"));
      return;
    }
    rescueSessionSync(appStore.getState().workDir, sessionId, sessionHistory as unknown[]);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // 输入空闲 Notification（issue #52）：prompt 布防、line 重置，一轮只 fire 一次
  const idleNotifyMs = resolveIdleNotifyMs();
  const idle = createIdleNotifier(idleNotifyMs, () => {
    void fireNotification(undefined, "idle_prompt", {
      turnNumber: appStore.getState().userPromptCount, // 已提交输入数（issue #69）
      sessionId: appStore.getState().sessionId,
    });
    process.stdout.write(
      chalk.gray(`\n输入已空闲 ${Math.round(idleNotifyMs / 60_000)} 分钟（TUPIG_IDLE_NOTIFY_MS 可调）\n`),
    );
    rl.prompt();
  });
  const origPrompt = rl.prompt.bind(rl);
  rl.prompt = ((...args: Parameters<typeof origPrompt>) => {
    const r = origPrompt(...args);
    idle.arm();
    return r;
  }) as Interface["prompt"];
  rl.on("line", () => idle.reset()); // 用户输入 → 解除本轮空闲通知

  rl.prompt();

  // 输入重入门闩（issue #86）：turn 进行中的行（含审批弹问 y⏎ 的双路幻影）直接丢弃
  const turnGate = new TurnGate();

  rl.on("line", async (line: string) => {
    if (!turnGate.enter()) return;
    try {
      await handleLine(line);
    } finally {
      turnGate.exit();
    }
  });

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === "/quit" || input === "/exit") {
      console.log(chalk.gray("\n再见！"));
      process.exit(0);
    }
    if (input === "/help") { printHelp(); rl.prompt(); return; }
    if (input === "/clear") {
      await runClearSequence(
        hookSystem,
        { turnNumber: 0, sessionId: appStore.getState().sessionId },
        () => appStore.setState((s) => ({
          ...s,
          tokenUsage: { input: 0, output: 0 },
          compactionCount: 0,
        })),
      );
      console.log(chalk.gray("对话历史已清空。\n"));
      rl.prompt();
      return;
    }
    if (input === "/cost") {
      const s = appStore.getState();
      console.log(chalk.gray(`Token 用量：输入 ${s.tokenUsage.input} | 输出 ${s.tokenUsage.output} | 上下文压缩 ${s.compactionCount} 次\n`));
      rl.prompt();
      return;
    }
    if (input === "/model") {
      const s = appStore.getState();
      console.log(chalk.gray(`模型：${s.mainLoopModel} | 模式：${s.toolPermissionContext.mode}\n`));
      rl.prompt();
      return;
    }
    if (input === "/permissions" || input === "/permissions clear") {
      const workDir = appStore.getState().workDir;
      if (input === "/permissions clear") {
        const n = clearAlwaysAllow(workDir);
        console.log(chalk.green(`✓ 已清除 ${n} 条「总是允许」规则\n`));
      } else {
        const list = loadAlwaysAllow(workDir);
        if (list.length === 0) console.log(chalk.gray("暂无「总是允许」规则（审批时按 a 写入 .tupigcode/permissions.json）\n"));
        else {
          console.log(chalk.cyan(`项目级「总是允许」${list.length} 条：`));
          for (const e of list) console.log(chalk.gray(`  ${e.pattern}（${e.source}，${e.addedAt}）`));
          console.log(chalk.gray("清除：/permissions clear\n"));
        }
      }
      rl.prompt();
      return;
    }
    if (input === "/compact" || input.startsWith("/compact ")) {
      const focus = input.slice("/compact".length).trim();
      if (sessionHistory.length <= 4) {
        console.log(chalk.gray(`消息较少（${sessionHistory.length} 条 ≤ 4），无需压缩\n`));
        rl.prompt();
        return;
      }
      const before = estimateTokens(sessionHistory);
      try {
        const hctx = { turnNumber: 0, sessionId };
        await fireCompactPre(undefined, hctx, "manual");
        const r = await new ContextCompactor().compact(createClient(), resolveModel(), sessionHistory, focus);
        sessionHistory = r.messages;
        await fireCompactPost(undefined, hctx, "manual");
        await saveSessionMessages(appStore.getState().workDir, sessionId, sessionHistory);
        const after = estimateTokens(sessionHistory);
        const cLine = formatCompactionLine();
        console.log(chalk.green(`✓ 已压缩（${r.strategy}${focus ? `，焦点：${focus}` : ""}）：${before} → ${after} tokens，${r.messages.length} 条${cLine ? ` · ${cLine}` : ""}\n`));
      } catch (e) {
        console.log(chalk.red(`压缩失败：${e instanceof Error ? e.message : e}\n`));
      }
      rl.prompt();
      return;
    }
    if (input === "/context") {
      const workDir = appStore.getState().workDir;
      const tools = getDefaultTools();
      const systemPrompt = renderSystemPrompt(tools, {});
      const toolSchemas = tools.map((t) => ({
        name: t.name,
        description: t.description({ workDir } as never),
        schema: (t as { jsonSchema?: unknown }).jsonSchema ?? null,
      }));
      const memories = loadMemoriesSync(workDir).map((m) => JSON.stringify(m));
      const bd = contextBreakdown({ systemPrompt, messages: sessionHistory, toolSchemas, memories });
      const pad = (n: number) => String(n).padStart(7);
      console.log(chalk.cyan("\n上下文占用（估算，chars/4）"));
      for (const seg of bd.segments) {
        const cnt = seg.count !== undefined ? `（${seg.count} ${seg.id === "tool_results" ? "块" : seg.id === "system" ? "条" : "项"}）` : "";
        console.log(chalk.gray(`  ${seg.label.padEnd(11)}${pad(seg.tokens)} tokens${cnt}`));
      }
      console.log(chalk.gray(`  ${"─".repeat(36)}`));
      console.log(chalk.white(`  合计${pad(bd.totalTokens)} tokens  ·  消息 ${sessionHistory.length} 条`));
      const lastC = appStore.getState().lastCompaction;
      if (lastC) {
        console.log(chalk.gray(`  最近压缩：${formatCompactionLine()}（${lastC.source}，${lastC.at.slice(0, 19)}）`));
      }
      console.log(chalk.gray("  自动压缩在预算梯度触发；手动瘦身用 /compact [focusing on X]\n"));
      rl.prompt();
      return;
    }

    if (input === "/skills") {
      const skills = loadSkills(appStore.getState().workDir);
      if (skills.length === 0) console.log(chalk.gray("暂无技能（.tupigcode/skills/<name>/SKILL.md）。\n"));
      else {
        for (const sk of skills) console.log(chalk.gray(`  ${sk.name}  —  ${sk.description}`));
        console.log(chalk.gray("\n加载：/skill <name>\n"));
      }
      rl.prompt();
      return;
    }
    if (input === "/skill" || input.startsWith("/skill ")) {
      const name = input.split(/\s+/)[1];
      if (!name) { console.log(chalk.gray("用法：/skill <name>\n")); rl.prompt(); return; }
      const pkg = resolveSkill(appStore.getState().workDir, name);
      if (!pkg) { console.log(chalk.red(`技能不存在或被门禁拒绝：${name}\n`)); rl.prompt(); return; }
      console.log(chalk.cyan(`\n# ${pkg.name} — ${pkg.description}\n`) + pkg.body + "\n");
      rl.prompt();
      return;
    }
    if (input === "/spec" || input.startsWith("/spec ")) {
      const workDir = appStore.getState().workDir;
      const [, sub, ...rest] = input.split(/\s+/);
      try {
        if (sub === "new") {
          const name = rest[0];
          if (!name) { console.log(chalk.gray("用法：/spec new <name> [目标]\n")); rl.prompt(); return; }
          const goal = rest.slice(1).join(" ") || "（待补充目标）";
          const spec = createSpec(workDir, name, goal);
          console.log(chalk.gray(`已创建 spec：${spec.name}（写需求→设计→任务→plan.md，再 /spec approve 批准）\n`));
        } else if (sub === "list" || !sub) {
          const specs = listSpecs(workDir);
          if (specs.length === 0) console.log(chalk.gray("暂无 spec。用法：/spec new <name> [目标]\n"));
          else {
            for (const s of specs) console.log(chalk.gray(`  ${s.name}  [${s.status}] 任务 ${s.tasksDone}/${s.tasksTotal}`));
            console.log("");
          }
        } else if (sub === "show") {
          const spec = loadSpec(workDir, rest[0] || "");
          console.log(chalk.cyan(`\n=== requirements ===\n`) + spec.requirements);
          console.log(chalk.cyan(`=== design ===\n`) + spec.design);
          console.log(chalk.cyan(`=== tasks ===\n`) + spec.tasks);
          console.log(chalk.cyan(`=== plan [${spec.status}] ===\n`) + (spec.plan || "（空）") + "\n");
        } else if (sub === "waves") {
          const spec = loadSpec(workDir, rest[0] || "");
          const waves = buildWaves(parseTasks(spec.tasks));
          waves.forEach((w, i) => {
            console.log(chalk.gray(`  wave ${i + 1}（可并行）：` + w.map((t) => `${t.id} ${t.content}`).join(" | ")));
          });
          console.log("");
        } else if (sub === "approve") {
          const r = approveSpec(workDir, rest[0] || "");
          if (r.ok) {
            console.log(chalk.green(`已批准。切 /plan 探索已可省略，/act 进入执行。\n`));
          } else {
            console.log(chalk.red("批准失败（阶段③自校验未过）："));
            for (const e of r.errors) console.log(chalk.gray(`  - ${e}`));
            console.log("");
          }
        } else {
          console.log(chalk.gray("用法：/spec new|list|show|waves|approve\n"));
        }
      } catch (e) {
        console.log(chalk.red(`${e instanceof Error ? e.message : String(e)}\n`));
      }
      rl.prompt();
      return;
    }
    if (input === "/doctor") {
      const workDir = appStore.getState().workDir;
      console.log(renderDoctor(runDoctor(workDir)) + "\n");
      rl.prompt();
      return;
    }
    if (input === "/init" || input.startsWith("/init ")) {
      const force = input.includes("--force");
      try {
        const out = initAgentMd(appStore.getState().workDir, { force });
        console.log(chalk.green(`已生成 ${out.path}\n`));
        console.log(chalk.gray(out.content));
      } catch (e) {
        console.log(chalk.red(`${e instanceof Error ? e.message : String(e)}\n`));
      }
      rl.prompt();
      return;
    }
    if (input === "/review" || input.startsWith("/review ")) {
      const workDir = appStore.getState().workDir;
      const ref = input.split(/\s+/)[1];
      if (ref && !isValidRef(ref)) {
        console.log(chalk.red(`非法 ref：${ref}\n`));
        rl.prompt();
        return;
      }
      let diff = "";
      try {
        const { execSync } = await import("child_process");
        diff = execSync(ref ? `git diff --no-color ${ref}` : "git diff HEAD --no-color", {
          cwd: workDir, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        console.log(chalk.red(`收集 diff 失败：${e instanceof Error ? e.message : String(e)}\n`));
        rl.prompt();
        return;
      }
      const prompt = buildReviewPrompt(diff);
      if (prompt.startsWith("没有可评审")) {
        console.log(chalk.gray(prompt + "\n"));
        rl.prompt();
        return;
      }
      try {
        for await (const msg of query({
          prompt,
          initialMessages: sessionHistory,
          options: { cwd: workDir, model: process.env.TUPIG_MODEL, initialMode: "plan" },
        })) {
          if (msg.type === "session") { sessionHistory = msg.messages; continue; }
          handleSDKMessage(msg);
        }
      } catch (err) {
        console.error(chalk.red(`\n错误：${err instanceof Error ? err.message : err}\n`));
      }
      rl.prompt();
      return;
    }
    if (input === "/retro" || input.startsWith("/retro ")) {
      const workDir = appStore.getState().workDir;
      let diff = "";
      try {
        const { execSync } = await import("child_process");
        diff = execSync("git diff HEAD --no-color", {
          cwd: workDir, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        diff = "";
      }
      const failures = extractFailures(sessionHistory);
      const prompt = buildRetroPrompt({ diff, failures });
      if (prompt.startsWith("无可复盘")) {
        console.log(chalk.gray(prompt + "\n"));
        rl.prompt();
        return;
      }
      try {
        let text = "";
        for await (const msg of query({
          prompt,
          initialMessages: sessionHistory,
          options: { cwd: workDir, model: process.env.TUPIG_MODEL, initialMode: "plan" },
        })) {
          if (msg.type !== "assistant") continue;
          for (const b of (msg.message?.content ?? []) as any[]) {
            if (b?.type === "text") text += b.text;
          }
        }
        const decision = parseReviewDecision(text);
        if (!decision) {
          console.log(chalk.yellow("复盘输出无法解析为四选一 JSON，未做任何写入。\n"));
          rl.prompt();
          return;
        }
        const r = applyReviewDecision(workDir, decision, `run-${Date.now()}`);
        console.log(chalk.green(`复盘动作：${decision.action}（${decision.reason || "无理由"}）`));
        console.log(chalk.gray(` ${r.message}\n`));
      } catch (err) {
        console.error(chalk.red(`\n错误：${err instanceof Error ? err.message : err}\n`));
      }
      rl.prompt();
      return;
    }
    if (input === "/remember" || input.startsWith("/remember ")) {
      const content = input.slice("/remember".length).trim();
      if (!content) {
        const mems = await loadMemories(appStore.getState().workDir);
        if (mems.length === 0) console.log(chalk.gray("暂无记忆。用法：/remember <内容>\n"));
        else console.log(formatMemoriesForPrompt(mems) + "\n");
        rl.prompt();
        return;
      }
      const staged = stageMemory({ content });
      console.log(chalk.yellow("\n将存入记忆："));
      console.log(chalk.gray(`  [${staged.category}] ${staged.content}\n`));
      const ok = (await promptUserDecision("remember", { content: staged.content }, { allowAlways: false })) !== "deny";
      if (ok) {
        await commitMemory(appStore.getState().workDir, staged, true);
        console.log(chalk.gray("已存入记忆。\n"));
      } else {
        console.log(chalk.gray("已放弃。\n"));
      }
      rl.prompt();
      return;
    }
    if (input === "/sessions") {
      const list = await listSessions(appStore.getState().workDir);
      if (list.length === 0) console.log(chalk.gray("暂无历史会话。\n"));
      else {
        for (const s of list.slice(0, 20)) console.log(chalk.gray(formatSessionRow(s)));
        console.log(chalk.gray("恢复：/resume <id> | 分叉：/fork <id> <条数>\n"));
      }
      rl.prompt();
      return;
    }
    if (input === "/resume" || input.startsWith("/resume ")) {
      const id = input.split(/\s+/)[1];
      if (!id) {
        const list = await listSessions(appStore.getState().workDir);
        if (list.length === 0) console.log(chalk.gray("暂无历史会话（用 /sessions 查看）。\n"));
        else {
          console.log(chalk.gray("选择要恢复的会话（按更新时间倒序）："));
          for (const s of list.slice(0, 20)) console.log(chalk.gray(formatSessionRow(s)));
          console.log(chalk.gray("恢复：/resume <id>\n"));
        }
        rl.prompt();
        return;
      }
      const msgs = await loadSessionMessages(appStore.getState().workDir, id);
      if (!msgs) { console.log(chalk.red(`会话不存在：${id}\n`)); rl.prompt(); return; }
      sessionHistory = msgs as Anthropic.MessageParam[];
      sessionId = id;
      adoptSessionId(id);
      console.log(chalk.gray(`已恢复会话 ${id}（${msgs.length} 条历史）\n`));
      rl.prompt();
      return;
    }
    if (input.startsWith("/fork ")) {
      const [, fid, nRaw] = input.split(/\s+/);
      const n = parseInt(nRaw ?? "", 10);
      if (!fid || !Number.isFinite(n)) { console.log(chalk.gray("用法：/fork <id> <条数>\n")); rl.prompt(); return; }
      const msgs = await loadSessionMessages(appStore.getState().workDir, fid);
      if (!msgs) { console.log(chalk.red(`会话不存在：${fid}\n`)); rl.prompt(); return; }
      const forked = forkMessages(msgs as Anthropic.MessageParam[], n);
      sessionId = `fork-${Date.now().toString(36)}`;
      adoptSessionId(sessionId);
      sessionHistory = forked;
      await saveSessionMessages(appStore.getState().workDir, sessionId, sessionHistory);
      console.log(chalk.gray(`已分叉 ${fid} 前 ${n} 条 → 新会话 ${sessionId}（${forked.length} 条）\n`));
      rl.prompt();
      return;
    }
    if (input === "/rewind" || input.startsWith("/rewind ")) {
      const workDir = appStore.getState().workDir;
      const parts = input.split(/\s+/).slice(1);
      const first = parts[0];
      const mode: "chat" | "code" | "all" =
        first === "chat" || first === "code" || first === "all" ? first : "all";
      const idArg = first === mode ? parts[1] : first;
      try {
        const list = await listCheckpoints(workDir);
        if (list.length === 0) {
          console.log(chalk.gray("暂无检查点（/checkpoint new 手动创建，或写操作后自动生成）。\n"));
          rl.prompt();
          return;
        }
        const id = idArg ?? list[0].id;
        const r = await rewind(workDir, id, mode);
        if (!r.ok) {
          console.log(chalk.red(r.message + "\n"));
        } else {
          await fireRewindPost(hookSystem, r, { checkpointId: id, mode }, {
            turnNumber: 0, sessionId: appStore.getState().sessionId,
          });
          console.log(chalk.gray(r.message + "\n"));
          if (r.messages) {
            sessionHistory = r.messages as typeof sessionHistory;
            await saveSessionMessages(workDir, sessionId, sessionHistory).catch(() => {});
            console.log(chalk.gray(`对话已回卷至 ${r.messages.length} 条。\n`));
          }
        }
        await pruneCheckpoints(workDir, 20).catch(() => {});
      } catch (e: any) {
        console.log(chalk.red(`rewind 错误：${e.message}\n`));
      }
      rl.prompt();
      return;
    }

    if (input === "/hooks" || input === "/hooks clear" || input === "/hooks reload") {
      const workDir = appStore.getState().workDir;
      if (input === "/hooks clear") {
        clearTrust(workDir);
        console.log(chalk.green("✓ 已清除全部 hook 信任记录（下次触发重新询问）\n"));
      } else if (input === "/hooks reload") {
        // hooks.json 手动重载（issue #51）：不看 mtime 强制重载
        const n = reloadShellHooks();
        if (n < 0) console.log(chalk.gray("当前会话未初始化 shell hooks，无动作\n"));
        else console.log(chalk.green(`✓ 已重载 hooks.json，当前 ${n} 个 shell hook\n`));
      } else {
        const list = listTrust(workDir);
        if (list.length === 0) {
          console.log(chalk.gray("暂无 hook 信任记录（首次触发时询问，确认后持久化）\n"));
        } else {
          console.log(chalk.cyan(`已信任 ${list.length} 个 hook：`));
          for (const t of list) console.log(chalk.gray(`  ${t.command}（${t.trustedAt}，hash ${t.hash}）`));
          console.log(chalk.gray("清除：/hooks clear\n"));
        }
      }
      rl.prompt();
      return;
    }

    if (input === "/apply") {
      const workDir = appStore.getState().workDir;
      try {
        const staged = await listStaged(workDir);
        if (staged.length === 0) {
          console.log(chalk.gray("暂存区为空（plan 模式改动会先暂存，/apply 落盘）\n"));
        } else {
          // issue #93：applyStaged 成功即清 staging、/apply 不走工具钩子——落盘前先建回滚介质
          try {
            await snapshot(workDir, "before:apply");
          } catch {
            // 非 git/无改动/检查点失败不阻断落盘
          }
          const r = await applyStaged(workDir);
          const lines = r.applied.map((f) => `  - ${f}`).join("\n");
          const skip = r.skipped.length ? `\n跳过越界条目 ${r.skipped.length} 个` : "";
          console.log(chalk.green(`✓ 已落盘 ${r.applied.length} 个文件：\n${lines}${skip}\n`));
        }
      } catch (e: any) {
        console.log(chalk.red(`apply 错误：${e.message}\n`));
      }
      rl.prompt();
      return;
    }

    if (input === "/checkpoint" || input.startsWith("/checkpoint ")) {
      const workDir = appStore.getState().workDir;
      const parts = input.split(/\s+/).slice(1);
      const sub = parts[0] ?? "list";
      try {
        if (sub === "new" || sub === "save") {
          const label = parts.slice(1).join(" ") || "手动检查点";
          const rec = await snapshot(workDir, label);
          if (rec) console.log(chalk.gray(`已创建检查点 ${rec.id}（${rec.label}）\n`));
          else console.log(chalk.gray("无改动或非 git 仓库，未创建检查点。\n"));
        } else if (sub === "rollback") {
          const id = parts[1];
          if (!id) { console.log(chalk.gray("用法：/checkpoint rollback <id>\n")); rl.prompt(); return; }
          const r = await rollbackCheckpoint(workDir, id);
          console.log(chalk.gray(r.message + "\n"));
        } else {
          const list = await listCheckpoints(workDir);
          if (list.length === 0) console.log(chalk.gray("暂无检查点。\n"));
          else {
            for (const c of list.slice(0, 20)) {
              console.log(chalk.gray(`  ${c.id}  ${c.createdAt.slice(0, 19)}  ${c.label}`));
            }
            console.log(chalk.gray("回滚：/checkpoint rollback <id>\n"));
          }
        }
      } catch (e: any) {
        console.log(chalk.red(`checkpoint 错误：${e.message}\n`));
      }
      rl.prompt();
      return;
    }

    const styleDir = join(appStore.getState().workDir, ".tupigcode", "memory");
    let finalInput: string | undefined;
    const optCmd = parseOptimizeCommand(input);
    if (optCmd !== null) {
      if (!optCmd) {
        console.log(chalk.gray("用法：/optimize <你的指令>  —— 补全结构后回填输入框，可编辑再发送\n"));
        rl.prompt();
        return;
      }
      if (needsClarification(optCmd)) {
        console.log(chalk.gray("提示：信息较模糊，建议补充目标/约束/验收；已自动补最小结构。"));
      }
      const optimized = optimizePrompt(optCmd);
      if (optimized === optCmd) {
        console.log(chalk.gray("已足够结构化，直接发送。\n"));
      } else {
        console.log(chalk.cyan("\n--- 优化预览（已回填，可编辑后回车；清空=放弃） ---"));
        console.log(optimized);
        console.log(chalk.cyan("------------------------------------------------\n"));
        appendPromptStyle(styleDir, { action: "accept", prompt: optCmd, reason: "用户触发 /optimize" });
        rl.pause();
        rl.write(null, { ctrl: true, name: "u" } as any);
        rl.write(optimized);
        rl.resume();
        return;
      }
    } else if (process.env.TUPIG_PROMPT_OPT === "1" && needsClarification(input)) {
      const auto = optimizePrompt(input);
      if (auto !== input) {
        console.log(chalk.gray("[auto-optimize] 已自动补结构（TUPIG_PROMPT_OPT=1）"));
        appendPromptStyle(styleDir, { action: "accept", prompt: input, reason: "auto 模式" });
        finalInput = auto;
      }
    }

    try {
      const opts = {
        cwd: appStore.getState().workDir,
        sessionId,
        model: process.env.TUPIG_MODEL,
        maxTurns: appStore.getState().maxTurns,
        maxTokens: appStore.getState().maxTokens,
      };
      for await (const msg of query({
        prompt: finalInput ?? input,
        initialMessages: sessionHistory,
        options: opts,
      })) {
        if (msg.type === "session") {
          sessionHistory = msg.messages;
          await saveSessionMessages(appStore.getState().workDir, sessionId, sessionHistory).catch((err: unknown) => {
            console.warn("[会话] 自动保存失败（历史可能不完整）:", err instanceof Error ? err.message : err);
          });
          if (process.env.TUPIG_AUTOSNAPSHOT !== "0") {
            autoSnapshot(appStore.getState().workDir, "auto:turn", sessionHistory).catch(() => {});
          }
          continue;
        }
        handleSDKMessage(msg);
      }
    } catch (err) {
      console.error(chalk.red(`\n错误：${err instanceof Error ? err.message : err}\n`));
    }
    await maybeReviewTurn(rl);
    rl.prompt();
  }

  rl.on("close", () => { console.log(chalk.gray("\n再见！")); process.exit(0); });
}

/** 本轮写操作 diff 审查（issue #18）：全局/文件/块三级，拒绝即回滚 */
async function maybeReviewTurn(rl: Interface): Promise<void> {
  const ops = drainTurnOps();
  if (ops.length === 0) return;
  const realOps = ops.filter((o) => !o.path.includes(".tupigcode/staging"));
  if (realOps.length === 0) return; // plan 模式暂存改动不落盘，无需即时审查
  if (process.env.TUPIG_DIFF_REVIEW === "0") return;
  if (!process.stdin.isTTY) return;
  try {
    await runTurnDiffReview(realOps, rl);
  } catch (e: any) {
    console.log(chalk.gray(`diff 审查跳过：${e?.message ?? e}\n`));
  }
}

async function runTurnDiffReview(ops: FileOp[], rl: Interface): Promise<void> {
  const plan = buildReview(ops);
  const workDir = appStore.getState().workDir;
  const rel = (p: string) => (p.startsWith(workDir) ? p.slice(workDir.length + 1) : p);
  const firstOp = new Map<string, FileOp>();
  for (const op of ops) if (!firstOp.has(op.path)) firstOp.set(op.path, op);

  console.log(chalk.cyan(`\n本轮 ${plan.files.length} 个文件改动 — diff 审查`));
  for (const f of plan.files) {
    console.log(chalk.gray(`  ${f.op === "create" ? "新增" : "修改"} ${rel(f.path)}（${f.stat}）`));
  }

  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const askValid = async (q: string, parse: (s: string) => string | null): Promise<string> => {
    for (;;) {
      const raw = await ask(q);
      const v = parse(raw);
      if (v !== null) return v;
      console.log(chalk.gray("输入无效，请重试。"));
    }
  };

  const g = await askValid("全局 [a]接受全部 [r]拒绝全部(回滚) [s]逐项审查 > ", (s) => decideGlobal(s));
  if (g === "accept") {
    console.log(chalk.green(`✓ 已接受 ${plan.files.length} 个文件的改动\n`));
    return;
  }
  if (g === "reject") {
    await rollbackOps(ops);
    console.log(chalk.yellow(`↩ 已拒绝并回滚 ${plan.files.length} 个文件\n`));
    return;
  }

  const rejected = new Set<string>();
  for (const f of plan.files) {
    console.log(chalk.cyan(`\n--- ${rel(f.path)}（${f.op === "create" ? "新建" : "修改"} ${f.stat}）`));
    if (!f.degraded) {
      const text = renderFileDiff(f);
      const lines = text.split("\n");
      const shown = lines.length > 80 ? lines.slice(0, 80).join("\n") + "\n…（diff 过长已截断）" : text;
      console.log(chalk.gray(shown));
    } else {
      console.log(chalk.gray(renderFileDiff(f)));
    }

    const decision = await askValid(
      `文件 [y]接受 [n]拒绝回滚${f.degraded ? "" : " [h]逐块审查"} [q]其余默认接受 > `,
      (s) => {
        const d = decideFile(s);
        if (d === null) return null;
        if (d === "h" && f.degraded) {
          console.log(chalk.gray("超大改动已降级，仅支持整文件 y/n。"));
          return null;
        }
        return d;
      },
    );
    if (decision === "q") {
      console.log(chalk.gray("（其余文件默认接受）"));
      break;
    }
    if (decision === "n") {
      rejected.add(f.path);
      continue;
    }
    if (decision === "h") {
      const keep: boolean[] = [];
      for (let i = 0; i < f.hunks.length; i++) {
        const h = f.hunks[i];
        console.log(chalk.gray(h.header));
        const hLines = h.lines.map((l) => l.sign + l.text);
        const shownH = hLines.length > 30 ? hLines.slice(0, 30).join("\n") + "\n…（块内截断）" : hLines.join("\n");
        console.log(chalk.gray(shownH));
        const k = await askValid(`块 ${i + 1}/${f.hunks.length} [y]接受 [n]拒绝 > `, (s) => decideHunk(s));
        keep.push(k === "y");
      }
      await applyHunkDecision({ path: f.path, before: firstOp.get(f.path)!.before }, f.hunks, keep);
      const keptCount = keep.filter(Boolean).length;
      console.log(chalk.green(`✓ ${rel(f.path)}：保留 ${keptCount}/${keep.length} 块`));
    }
  }

  if (rejected.size > 0) {
    await rollbackOps(ops.filter((o) => rejected.has(o.path)));
    console.log(chalk.yellow(`↩ 已拒绝并回滚 ${rejected.size} 个文件`));
  }
  console.log(chalk.green("✓ diff 审查完成\n"));
}

async function runSingle(prompt: string): Promise<void> {
  for await (const msg of query({
    prompt,
    options: {
      cwd: appStore.getState().workDir,
      model: process.env.TUPIG_MODEL,
      maxTurns: appStore.getState().maxTurns,
      maxTokens: appStore.getState().maxTokens,
    },
  })) {
    handleSDKMessage(msg);
  }
}

function main(): void {
  const program = new Command();
  program
    .name("tupigcode")
    .description("TupigCode — AI 编程助手（Claude Code 架构）")
    .version(VERSION);

  program
    .option("-m, --model <model>", "指定模型（留空自动路由）")
    .option("-t, --max-tokens <tokens>", "最大输出 Token 数", (v) => parseInt(v, 10), 8192)
    .option("--max-turns <turns>", "最大工具调用轮次", (v) => parseInt(v, 10), 20)
    .option("-w, --work-dir <dir>", "工作目录", process.cwd())
    .option("-p, --prompt <message>", "单次执行模式")
    .option("--yolo", "跳过所有权限确认（bypassPermissions）")
    .option("--plan", "计划模式（只允许只读操作）")
    .option("--permission-mode <mode>", "权限模式：default|acceptEdits|bypassPermissions|plan|dontAsk");

  program.parse();
  const opts = program.opts();
  if (opts.model) process.env.TUPIG_MODEL = opts.model;

  // -w/--max-turns/-t 接线（issue #89）：进 appStore，REPL 与单发 query 共同消费
  const workDir = resolve(String(opts.workDir));
  if (!existsSync(workDir)) {
    console.error(chalk.red(`错误：工作目录不存在：${workDir}`));
    process.exit(1);
  }
  const maxTurns = Number.isFinite(opts.maxTurns) && opts.maxTurns > 0 ? opts.maxTurns : 20;
  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : 8192;
  appStore.setState((s) => ({ ...s, workDir, maxTurns, maxTokens }));

  const permMode = opts.yolo ? "bypassPermissions" : opts.plan ? "plan" : opts.permissionMode;
  if (permMode) {
    const valid = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
    if (!valid.includes(permMode)) {
      console.error(chalk.red(`错误：无效权限模式 ${permMode}（可选：${valid.join("|")}）`));
      process.exit(1);
    }
    appStore.setState((s) => ({
      ...s,
      toolPermissionContext: { ...s.toolPermissionContext, mode: permMode as any },
    }));
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.TUPIG_MOCK && !process.env.OPENAI_BASE_URL) {
    console.error(chalk.red("错误：请设置 ANTHROPIC_API_KEY、OPENAI_BASE_URL+OPENAI_API_KEY 或 TUPIG_MOCK=1"));
    process.exit(1);
  }

  if (opts.prompt) {
    runSingle(opts.prompt).catch((err) => {
      console.error(chalk.red(`错误：${err.message}`));
      process.exit(1);
    });
  } else {
    startREPL().catch((err) => {
      console.error(chalk.red(`错误：${err.message}`));
      process.exit(1);
    });
  }
}

main();
