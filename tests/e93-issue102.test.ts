/**
 * E93 引擎低优先级五连（issue #102）
 *
 * - query() 入口把上下文长度接线给 routeTask（route.log ctx 非 0，死分支可达）
 * - JSON 解析失败的 tool_use/tool_result 事件配对（见 e50「输入 JSON 非法」）
 * - 流正常结束但缺 finish_reason/message_delta → 按不完整响应 error 处理，不走成功语义
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

describe("query() 上下文接线给 routeTask（#102-1）", () => {
  it("route.log 的 ctx = (initialMessages + prompt)/4，非 0", async () => {
    const { query } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93-"));
    const initialMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `第 ${i} 轮`.padEnd(2000, "x"),
    }));
    const prompt = "读文件";
    const iter = query({ prompt, initialMessages, options: { cwd: dir, model: "mock" } });
    for await (const _ of iter) { /* drain */ }

    const raw = readFileSync(join(dir, ".tupigcode", "route.log"), "utf-8").trim().split("\n");
    const row = raw.map((l) => JSON.parse(l)).find((r) => r.type === "route");
    expect(row).toBeTruthy();
    expect(row.ctx).toBe(Math.ceil((JSON.stringify(initialMessages).length + prompt.length) / 4));
    expect(row.ctx).toBeGreaterThan(10_000);
  }, 25_000);
});

describe("流结束缺 finish_reason → error（#102-3）", () => {
  async function makeEngine() {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93b-"));
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;
    return engine;
  }

  function loopState() {
    return { messages: [] as any[], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
  }

  it("只有 message_start/text/message_stop，无 message_delta → stopReason=error + error result", async () => {
    const engine = await makeEngine();
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_start", content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "半截回答" } };
              yield { type: "content_block_stop" };
              yield { type: "message_stop" }; // 缺 message_delta（finish_reason）
            })(),
        },
      },
    };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), async () => ({ behavior: "allow" } as any));

    expect(res.stopReason).toBe("error");
    const err = res.events.find((e: any) => e.type === "result" && e.subtype === "error");
    expect(err).toBeTruthy();
    expect(String(err.result)).toContain("finish_reason");
  }, 15_000);

  it("正常带 message_delta → 不受影响（end_turn 成功语义）", async () => {
    const engine = await makeEngine();
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: () =>
            (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_start", content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "完整回答" } };
              yield { type: "content_block_stop" };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
              yield { type: "message_stop" };
            })(),
        },
      },
    };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), async () => ({ behavior: "allow" } as any));

    expect(res.stopReason).toBe("end_turn");
    expect(res.events.some((e: any) => e.type === "result")).toBe(false);
  }, 15_000);
});

describe("estimateTokens 增量估算（#102-4）", () => {
  async function makeEngine() {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93c-"));
    return new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    }) as any;
  }

  it("同数组重复估算不序列化旧消息；追加后只序列化新增（与全量口径等值）", async () => {
    const engine = await makeEngine();
    let serializations = 0;
    const mkMsg = (i: number) => ({
      role: "user" as const,
      content: `第 ${i} 条`.padEnd(300, "y"),
      toJSON() {
        serializations++;
        return { role: this.role, content: this.content };
      },
    });
    const msgs: any[] = [mkMsg(0), mkMsg(1), mkMsg(2)];
    // 期望值用等价普通对象算，避免测试自身的 JSON.stringify 触发 toJSON 计数
    const fullChars = (arr: any[]) =>
      Math.ceil(JSON.stringify(arr.map((m) => ({ role: m.role, content: m.content }))).length / 4);

    const first = engine.estimateTokens(msgs);
    expect(serializations).toBe(3);
    expect(first).toBe(fullChars(msgs));

    // 未变更 → 不重复序列化旧消息（当前实现全量重算 → 红）
    const second = engine.estimateTokens(msgs);
    expect(second).toBe(first);
    expect(serializations).toBe(3);

    // 追加 → 只序列化新增那条，且与全量口径等值
    msgs.push(mkMsg(3));
    const third = engine.estimateTokens(msgs);
    expect(serializations).toBe(4);
    expect(third).toBe(fullChars(msgs));

    // 数组被整体替换（压缩场景）→ 全量重算仍等值
    const replaced = [mkMsg(9)];
    const fourth = engine.estimateTokens(replaced);
    expect(fourth).toBe(fullChars(replaced));
  });

  it("每 turn 只构建一次 toolDefs + system prompt（estimate 与 executeTurn 共用）", async () => {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93d-"));
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
    });
    let toolDefsBuilds = 0;
    let systemBuilds = 0;
    const origToolDefs = engine.buildToolDefs.bind(engine);
    engine.buildToolDefs = () => { toolDefsBuilds++; return origToolDefs(); };
    const origLayers = engine.buildSystemLayers.bind(engine);
    engine.buildSystemLayers = (...a: any[]) => { systemBuilds++; return origLayers(...a); };

    for await (const _ of engine.submitMessage("读 README.md")) { /* drain */ }

    expect(toolDefsBuilds).toBe(1);
    expect(systemBuilds).toBe(1);
  }, 25_000);
});

describe("plan 模式请求侧工具与 filterTools 对齐（#102-5）", () => {
  function loopState() {
    return { messages: [] as any[], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
  }

  async function makeEngine(mode: "plan" | "act") {
    const { QueryEngine } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93e-"));
    const engine: any = new QueryEngine({
      cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
      initialMode: mode,
    });
    engine.fallbackClient = null;
    engine.fallbackLabel = null;
    const captured: { tools?: any[]; system?: any[] } = {};
    engine.client = {
      type: "anthropic",
      anthropic: {
        messages: {
          stream: (params: any) => {
            captured.tools = params.tools;
            captured.system = params.system;
            return (async function* () {
              yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
              yield { type: "content_block_start", content_block: { type: "text", text: "" } };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "好的" } };
              yield { type: "content_block_stop" };
              yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
              yield { type: "message_stop" };
            })();
          },
        },
      },
    };
    return { engine, captured };
  }

  it("plan 模式：请求 tools 不含 Write/Edit/Bash，system 工具目录同步剔除", async () => {
    const { engine, captured } = await makeEngine("plan");
    const res = await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" } as any));
    expect(res.stopReason).toBe("end_turn");

    const names = (captured.tools ?? []).map((t: any) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Bash");
    expect(names).toContain("Read");

    const sysText = (captured.system ?? []).map((b: any) => b.text ?? "").join("\n");
    expect(sysText).not.toMatch(/- Write：/);
    expect(sysText).toMatch(/- Read：/);
  }, 15_000);

  it("act 模式：请求 tools 含写工具（默认行为不回退）", async () => {
    const { engine, captured } = await makeEngine("act");
    await engine.executeTurn(loopState(), engine.buildToolContext(), async () => ({ behavior: "allow" } as any));
    const names = (captured.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("Write");
    expect(names).toContain("Bash");
  }, 15_000);

  it("init 事件 tools 与请求侧一致（同为模式过滤后的集合）", async () => {
    const { query } = await import("../src/engine/QueryEngine");
    const dir = mkdtempSync(join(tmpdir(), "tupig-e93f-"));
    const iter = query({ prompt: "读 README", options: { cwd: dir, model: "mock", initialMode: "plan" } });
    let initTools: string[] | null = null;
    for await (const ev of iter as any) {
      if (ev.type === "system" && ev.subtype === "init") initTools = ev.tools;
    }
    expect(initTools).toBeTruthy();
    expect(initTools).not.toContain("Write");
    expect(initTools).toContain("Read");
  }, 25_000);
});
