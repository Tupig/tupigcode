/**
 * E50 流式早期派发 eager_input_streaming（#47）
 *
 * - tool_use 收完（tool_use_stop）即执行只读并发安全工具，与模型尾部生成重叠
 * - 结果复用：不重复执行（canUseTool 只进一次）
 * - 写工具不参与提前派发（仍走 partitionRuns 串行语义）
 * - 输入 JSON 非法 → 不派发，走既有解析失败错误路径
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FakeStreamOpts = {
  toolName: string;
  inputJson: string;
  tailMs?: number;
  onToolStop?: () => void;
  onTail?: () => void;
};

async function makeEngine() {
  const { QueryEngine } = await import("../src/engine/QueryEngine");
  const dir = mkdtempSync(join(tmpdir(), "tupig-a5-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  const engine: any = new QueryEngine({
    cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  // 用假 anthropic 流驱动 executeTurn：tool_use_stop 后停留 tailMs 模拟模型尾部生成
  engine.client = {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: () =>
          (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "tool_use", id: "tu1", name: optsRef.toolName } };
            yield {
              type: "content_block_delta",
              delta: { type: "input_json_delta", partial_json: optsRef.inputJson },
            };
            yield { type: "content_block_stop" };
            optsRef.onToolStop?.();
            await sleep(optsRef.tailMs ?? 120);
            optsRef.onTail?.();
            yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })(),
      },
    },
  };
  return engine;
}

let optsRef: FakeStreamOpts = { toolName: "Glob", inputJson: "{}" };
function setOpts(o: FakeStreamOpts) { optsRef = o; }

function loopState() {
  return { messages: [] as any[], turnCount: 1, compacted: false, maxOutputTokensOverride: 8192, hasAttemptedReactiveCompact: false };
}

describe("早期派发：只读工具与尾部生成重叠", () => {
  it("tool_use_stop 即派发，尾部生成期间已完成权限与执行，且只执行一次", async () => {
    const engine = await makeEngine();
    let permissionCalled = false;
    let seenDuringTail: boolean | null = null;
    setOpts({
      toolName: "Glob",
      inputJson: JSON.stringify({ pattern: "*.ts" }),
      tailMs: 150,
      onTail: () => { seenDuringTail = permissionCalled; },
    });
    const canUse = async () => {
      permissionCalled = true;
      await sleep(60);
      return { behavior: "allow" } as any;
    };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), canUse);

    expect(seenDuringTail).toBe(true);
    expect(res.toolResults).toHaveLength(1);
    expect(res.toolResults[0].is_error).toBeFalsy();
    expect(permissionCalled).toBe(true);
  }, 15_000);
});

describe("早期派发边界", () => {
  it("写工具不提前派发：尾部生成期间未调用，流结束后正常执行", async () => {
    const engine = await makeEngine();
    let permissionCalled = false;
    let seenDuringTail: boolean | null = null;
    const out = join(engine.config.cwd ?? process.cwd(), "out.ts");
    setOpts({
      toolName: "Write",
      inputJson: JSON.stringify({ file_path: out, content: "written\n" }),
      tailMs: 120,
      onTail: () => { seenDuringTail = permissionCalled; },
    });
    const canUse = async () => { permissionCalled = true; return { behavior: "allow" } as any; };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), canUse);

    expect(seenDuringTail).toBe(false);
    expect(permissionCalled).toBe(true);
    expect(res.toolResults[0].is_error).toBeFalsy();
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("written\n");
  }, 15_000);

  it("输入 JSON 非法 → 不派发，走解析失败错误结果", async () => {
    const engine = await makeEngine();
    let canUseCalls = 0;
    setOpts({
      toolName: "Glob",
      inputJson: '{"pattern": ', // 未闭合
      tailMs: 30,
    });
    const canUse = async () => { canUseCalls++; return { behavior: "allow" } as any; };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), canUse);

    expect(canUseCalls).toBe(0);
    expect(res.toolResults).toHaveLength(1);
    expect(res.toolResults[0].is_error).toBe(true);
    expect(res.toolResults[0].content).toContain("JSON 解析失败");
    // 事件配对（issue #102）：tool_result 必须有同 id 的 tool_use 事件，否则消费端断链
    const tu = res.events.find((e: any) => e.type === "tool_use" && e.toolUseId === res.toolResults[0].tool_use_id);
    expect(tu).toBeTruthy();
    expect(tu.input).toEqual({});
    const trIdx = res.events.findIndex((e: any) => e.type === "tool_result" && e.toolUseId === res.toolResults[0].tool_use_id);
    const tuIdx = res.events.indexOf(tu);
    expect(tuIdx).toBeGreaterThanOrEqual(0);
    expect(tuIdx).toBeLessThan(trIdx);
  }, 15_000);

  it("未知工具不提前派发，流结束后按未知工具报错", async () => {
    const engine = await makeEngine();
    let permissionCalled = false;
    let seenDuringTail: boolean | null = null;
    setOpts({
      toolName: "NoSuchTool",
      inputJson: JSON.stringify({ x: 1 }),
      tailMs: 60,
      onTail: () => { seenDuringTail = permissionCalled; },
    });
    const canUse = async () => { permissionCalled = true; return { behavior: "allow" } as any; };

    const res = await (engine as any).executeTurn(loopState(), (engine as any).buildToolContext(), canUse);

    expect(seenDuringTail).toBe(false); // 尾部生成期间未派发
    expect(res.toolResults[0].is_error).toBeTruthy();
    expect(res.toolResults[0].content).toContain("未知工具");
  }, 15_000);
});
