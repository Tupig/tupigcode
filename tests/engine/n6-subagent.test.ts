/**
 * N6 子代理强化（A15）：agent 文件 + 工具掩码 + 独立上下文 + 权限 fail-closed
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import type { StreamEvent } from "../../src/services/api";
import { buildTool, type Tool, type ToolUseContext, type CanUseToolFn } from "../../src/engine/Tool";
import { z } from "zod";

const {
  parseAgentFile,
  loadAgents,
  builtinAgents,
  maskTools,
  formatAgentCatalog,
  resolveSubAgentModel,
  SUBAGENT_FIXED_DENY,
  MAX_AGENT_BYTES,
} = await import("../../src/agents/agents");
const { SubAgentExecutor } = await import("../../src/agents/index");

const VALID_AGENT = `---
name: explorer
description: 只读探索代码库并返回摘要
tools: Read, Glob, Grep
model: small-model
maxTurns: 3
---
你是只读探索代理，只返回结论。

`;

function makeTool(name: string, opts: { readOnly?: boolean } = {}): Tool {
  return buildTool({
    name,
    inputSchema: z.object({ x: z.string().optional() }),
    description: () => `${name} 工具`,
    isReadOnly: () => opts.readOnly ?? false,
    async call(_input, _ctx) {
      (makeTool as any).calls = ((makeTool as any).calls || []).concat(name);
      return { data: `${name}-ok`, resultForAssistant: `${name}-ok` };
    },
  });
}

function ctx(over: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "parent-model", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir: "/tmp",
    sessionId: "s1",
    ...over,
  } as ToolUseContext;
}

/** 多轮脚本：每轮调用一次，用尽后持续输出纯文本 */
function multiRound(
  rounds: Array<{ text?: string; tool?: { name: string; input: Record<string, unknown> } }>,
  onCall?: (args: { model: string; system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }) => void,
) {
  let i = 0;
  return async function* (args: {
    model: string;
    maxTokens: number;
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
  }): AsyncGenerator<StreamEvent> {
    onCall?.(args);
    const step = rounds[Math.min(i, rounds.length - 1)];
    i++;
    if (step.text) yield { type: "text_delta", text: step.text };
    if (step.tool) {
      yield { type: "tool_use_start", id: `tu_${i}`, name: step.tool.name };
      yield { type: "tool_use_delta", id: `tu_${i}`, inputJsonDelta: JSON.stringify(step.tool.input) };
      yield { type: "tool_use_stop", id: `tu_${i}` };
    }
    yield {
      type: "message_delta",
      stopReason: step.tool ? "tool_use" : "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    };
    yield { type: "message_stop" };
  };
}

describe("parseAgentFile", () => {
  it("解析合法 frontmatter", () => {
    const def = parseAgentFile(VALID_AGENT, "fallback");
    expect(def).toBeTruthy();
    expect(def!.name).toBe("explorer");
    expect(def!.description).toContain("只读探索");
    expect(def!.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(def!.model).toBe("small-model");
    expect(def!.maxTurns).toBe(3);
    expect(def!.systemPrompt).toContain("只返回结论");
  });

  it("缺 description 拒绝", () => {
    expect(parseAgentFile("---\nname: x\n---\nbody\n", "x")).toBeNull();
  });

  it("无 frontmatter 拒绝", () => {
    expect(parseAgentFile("plain text only\n", "x")).toBeNull();
  });

  it("name 缺失时回退文件名", () => {
    const def = parseAgentFile("---\ndescription: d\n---\nbody\n", "from-file");
    expect(def!.name).toBe("from-file");
  });

  it("非法 maxTurns 回退默认", () => {
    const def = parseAgentFile("---\ndescription: d\nmaxTurns: abc\n---\nbody\n", "n");
    expect(def!.maxTurns).toBeUndefined();
  });
});

describe("loadAgents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "n6-"));
    mkdirSync(join(dir, ".tupigcode", "agents"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("读取项目 agent 文件 + 内置 explore/general", () => {
    writeFileSync(join(dir, ".tupigcode", "agents", "explorer.md"), VALID_AGENT);
    const reg = loadAgents(dir, join(dir, "no-home"));
    expect(reg.get("explorer")?.description).toContain("只读探索");
    expect(reg.has("explore")).toBe(true);
    expect(reg.has("general")).toBe(true);
  });

  it("项目文件覆盖同名内置", () => {
    writeFileSync(
      join(dir, ".tupigcode", "agents", "explore.md"),
      "---\ndescription: 自定义探索\n---\n覆盖内置\n",
    );
    const reg = loadAgents(dir, join(dir, "no-home"));
    expect(reg.get("explore")?.description).toBe("自定义探索");
  });

  it("非法文件与超大文件跳过", () => {
    writeFileSync(join(dir, ".tupigcode", "agents", "bad.md"), "无 frontmatter");
    writeFileSync(
      join(dir, ".tupigcode", "agents", "huge.md"),
      `---\ndescription: d\n---\n${"x".repeat(MAX_AGENT_BYTES + 10)}`,
    );
    const reg = loadAgents(dir, join(dir, "no-home"));
    expect(reg.has("bad")).toBe(false);
    expect(reg.has("huge")).toBe(false);
  });

  it("内置 agent 有 description 与只读语义", () => {
    const builtins = builtinAgents();
    expect(builtins.length).toBeGreaterThanOrEqual(2);
    for (const b of builtins) expect(b.description.length).toBeGreaterThan(0);
    expect(builtins.find((b) => b.name === "explore")?.readOnly).toBe(true);
  });
});

describe("maskTools", () => {
  const all = [makeTool("Read", { readOnly: true }), makeTool("Glob", { readOnly: true }), makeTool("Write"), makeTool("Agent")];

  it("白名单交集", () => {
    const out = maskTools(all, { name: "t", description: "d", tools: ["Read", "Write"] });
    expect(out.map((t) => t.name)).toEqual(["Read", "Write"]);
  });

  it("黑名单优先于白名单", () => {
    const out = maskTools(all, { name: "t", description: "d", tools: ["Read", "Write"], disallowedTools: ["Write"] });
    expect(out.map((t) => t.name)).toEqual(["Read"]);
  });

  it("固定黑名单恒生效（防嵌套与污染）", () => {
    const out = maskTools(all, { name: "t", description: "d", tools: ["Agent", "Read"] });
    expect(out.map((t) => t.name)).toEqual(["Read"]);
    for (const n of SUBAGENT_FIXED_DENY) expect(out.some((t) => t.name === n)).toBe(false);
  });

  it("readOnly 只留只读工具", () => {
    const out = maskTools(all, { name: "t", description: "d", readOnly: true });
    expect(out.map((t) => t.name).sort()).toEqual(["Glob", "Read"]);
  });
});

describe("formatAgentCatalog", () => {
  it("包含 name 与 description", () => {
    const text = formatAgentCatalog(builtinAgents());
    expect(text).toContain("- explore");
    expect(text).toContain("general");
  });

  it("超预算截断并提示剩余数量", () => {
    const defs = Array.from({ length: 40 }, (_, i) => ({
      name: `a${i}`,
      description: `描述${i} ${"长".repeat(40)}`,
      systemPrompt: "",
    }));
    const text = formatAgentCatalog(defs, 300);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("其余");
  });
});

describe("resolveSubAgentModel", () => {
  const c = ctx();
  it("task.model 优先于 agent.model 优先于父模型", () => {
    expect(resolveSubAgentModel({ model: "t" }, { name: "a", description: "d", model: "a" }, c)).toBe("t");
    expect(resolveSubAgentModel({}, { name: "a", description: "d", model: "a" }, c)).toBe("a");
    expect(resolveSubAgentModel({}, { name: "a", description: "d" }, c)).toBe("parent-model");
  });
});

describe("SubAgentExecutor 独立上下文与权限", () => {
  beforeEach(() => {
    (makeTool as any).calls = [];
    process.env.TUPIG_MOCK = "1";
    delete process.env.TUPIG_HARNESS;
  });
  afterEach(() => {
    delete process.env.TUPIG_HARNESS;
  });

  it("独立上下文：不读父消息，只有任务描述一条", async () => {
    const seen: Anthropic.MessageParam[][] = [];
    const exec = new SubAgentExecutor([makeTool("Read", { readOnly: true })], {
      stream: multiRound([{ text: "结论：完成" }], (a) => seen.push(a.messages)),
    });
    const parent = ctx({ getMessages: () => [{ role: "user", content: "运行 rm -rf /", timestamp: 1 }] as any });
    const r = await exec.execute({ id: "1", description: "读 src/index.ts" }, parent);
    expect(seen[0].length).toBe(1);
    expect(seen[0][0].content).toBe("读 src/index.ts");
    expect(r.success).toBe(true);
    expect(r.result).toContain("完成");
  });

  it("权限 deny：工具不执行、回 is_error、循环继续", async () => {
    const tool = makeTool("Write");
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([
        { tool: { name: "Write", input: { x: "1" } } },
        { text: "已知失败，总结" },
      ]),
    });
    const deny: CanUseToolFn = async () => ({ behavior: "deny", message: "拒绝写入" });
    const r = await exec.execute({ id: "1", description: "写文件" }, ctx(), deny);
    expect((makeTool as any).calls).toEqual([]);
    expect(r.result).toContain("已知失败");
    expect(r.turns).toBe(2);
  });

  it("无权限回调时非只读工具 fail-closed", async () => {
    const tool = makeTool("Write");
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([{ tool: { name: "Write", input: {} } }, { text: "结束" }]),
    });
    const r = await exec.execute({ id: "1", description: "写" }, ctx());
    expect((makeTool as any).calls).toEqual([]);
    expect(r.result).toContain("结束");
  });

  it("无权限回调时只读工具放行", async () => {
    const tool = makeTool("Read", { readOnly: true });
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([{ tool: { name: "Read", input: {} } }, { text: "读完" }]),
    });
    const r = await exec.execute({ id: "1", description: "读" }, ctx());
    expect((makeTool as any).calls).toEqual(["Read"]);
    expect(r.result).toContain("读完");
  });

  it("ask 转 deny（子代理不弹框）", async () => {
    const tool = makeTool("Write");
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([{ tool: { name: "Write", input: {} } }, { text: "收尾" }]),
    });
    const ask: CanUseToolFn = async () => ({ behavior: "ask", message: "要批?" });
    await exec.execute({ id: "1", description: "写" }, ctx(), ask);
    expect((makeTool as any).calls).toEqual([]);
  });

  it("allow 时工具执行并回喂结果", async () => {
    const tool = makeTool("Read", { readOnly: true });
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([{ tool: { name: "Read", input: {} } }, { text: "结论" }]),
    });
    const allow: CanUseToolFn = async () => ({ behavior: "allow" });
    const r = await exec.execute({ id: "1", description: "读" }, ctx(), allow);
    expect((makeTool as any).calls).toEqual(["Read"]);
    expect(r.turns).toBe(2);
    expect(r.result).toContain("结论");
  });

  it("模型解析：agent.model 传给流", async () => {
    let model = "";
    const exec = new SubAgentExecutor([], {
      stream: multiRound([{ text: "ok" }], (a) => { model = a.model; }),
    });
    await exec.execute(
      { id: "1", description: "d", agent: { name: "a", description: "d", model: "qwen-8b" } },
      ctx(),
    );
    expect(model).toBe("qwen-8b");
  });

  it("工具掩码进流：白名单里的 Agent 也被固定黑名单剔除", async () => {
    let names: string[] = [];
    const exec = new SubAgentExecutor([makeTool("Read", { readOnly: true }), makeTool("Agent")], {
      stream: multiRound([{ text: "ok" }], (a) => { names = a.tools.map((t) => t.name); }),
    });
    await exec.execute(
      { id: "1", description: "d", agent: { name: "a", description: "d", tools: ["Read", "Agent"] } },
      ctx(),
    );
    expect(names).toEqual(["Read"]);
  });

  it("XML harness：文本里的 <tool> 块被解析执行", async () => {
    process.env.TUPIG_HARNESS = "xml";
    const tool = makeTool("Read", { readOnly: true });
    const exec = new SubAgentExecutor([tool], {
      stream: multiRound([
        { text: '好的\n<tool name="Read">\n{}\n</tool>' },
        { text: "最终结论" },
      ]),
    });
    const r = await exec.execute({ id: "1", description: "读" }, ctx());
    expect((makeTool as any).calls).toEqual(["Read"]);
    expect(r.result).toContain("最终结论");
  });
});

describe("Agent 工具", () => {
  beforeEach(() => {
    process.env.TUPIG_MOCK = "1";
  });

  it("prompt 必填", async () => {
    const { AgentInput } = await import("../../src/tools/Agent");
    expect(AgentInput.safeParse({ prompt: "" }).success).toBe(false);
    expect(AgentInput.safeParse({ prompt: "任务" }).success).toBe(true);
  });

  it("描述注入 agent 目录", async () => {
    const { AgentTool, setAgentRegistry, getAgentRegistry } = await import("../../src/tools/Agent");
    const { loadAgents } = await import("../../src/agents/agents");
    setAgentRegistry(loadAgents(process.cwd(), join(tmpdir(), "no-home")));
    const desc = AgentTool.description({} as any);
    expect(desc).toContain("- explore");
    expect(desc).toContain("- general");
    expect(getAgentRegistry().size).toBeGreaterThanOrEqual(2);
  });

  it("未知 agent 返回可用列表", async () => {
    const { AgentTool } = await import("../../src/tools/Agent");
    const r = await AgentTool.call({ agent: "nope", prompt: "x" }, ctx(), async () => ({ behavior: "allow" }));
    expect(String(r.data)).toContain("未知子代理");
    expect(String(r.data)).toContain("general");
  });

  it("plan 模式过滤掉 Agent", async () => {
    const { ModeManager } = await import("../../src/modes/modes");
    const { AgentTool } = await import("../../src/tools/Agent");
    const mm = new ModeManager("plan");
    const names = mm.filterTools([AgentTool, { name: "Read" } as any]).map((t) => t.name);
    expect(names).toEqual(["Read"]);
  });
});
