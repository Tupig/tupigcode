/**
 * E54 hooks.json 热加载 + /hooks reload（issue #51）
 *
 * - 构造后修改 hooks.json → 下次 submitMessage 入口按 mtime 检测重载
 * - 文件删除 → 重载为空，旧 hook 失效
 * - mtime 未变 → 零动作
 * - HookSystem.reloadShell：只换 shell 注册，代码注册（register）保留
 * - reloadShellHooks 手动强制重载返回注册数（供 /hooks reload）
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  hookSystem, initShellHooks, reloadShellHooks, reloadShellHooksIfChanged, hooksFilePath,
  type HookMatcher,
} from "../../src/engine/hooks";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});
afterAll(() => { hookSystem.clear(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

async function makeEngine(cwd?: string) {
  const { QueryEngine } = await import("../../src/engine/QueryEngine");
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "tupig-e54-"));
  let modelCalled = false;
  let captured: any = null;
  const engine: any = new QueryEngine({
    cwd: dir, model: "mock", maxTokens: 1024, maxTurns: 1, routeProvider: "mock",
  });
  engine.fallbackClient = null;
  engine.fallbackLabel = null;
  engine.client = {
    type: "anthropic",
    anthropic: {
      messages: {
        stream: (params: any) => {
          modelCalled = true;
          captured = params;
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } };
            yield { type: "content_block_stop" };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
            yield { type: "message_stop" };
          })();
        },
      },
    },
  };
  return { engine, dir, wasModelCalled: () => modelCalled, captured: () => captured };
}

describe("HookSystem shell 注册管理", () => {
  it("reloadShell 只换 shell 注册，代码注册保留", () => {
    hookSystem.clear();
    const codeMatcher: HookMatcher = { event: "Stop", handler: () => {} };
    hookSystem.register(codeMatcher);
    hookSystem.reloadShell([
      { event: "Stop", handler: () => {} },
      { event: "Stop", handler: () => {} },
    ]);
    expect((hookSystem as any).matchers).toHaveLength(3);
    expect((hookSystem as any).shellMatchers).toHaveLength(2);

    hookSystem.reloadShell([{ event: "Stop", handler: () => {} }]);
    expect((hookSystem as any).matchers).toHaveLength(2); // 代码注册 1 + shell 1

    hookSystem.reloadShell([]);
    expect((hookSystem as any).matchers).toHaveLength(1); // 代码注册仍在
    hookSystem.clear();
  });
});

describe("submitMessage 入口热加载", () => {
  it("构造后新建 hooks.json → block 生效；改写放行 → 重载后进模型", async () => {
    const { engine, dir, wasModelCalled } = await makeEngine();
    const file = join(dir, ".tupigcode", "hooks.json");
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(file, JSON.stringify([
      { event: "UserPromptSubmit", command: `echo '{"block":true,"message":"热加载生效"}'` },
    ]));

    const out = await collect(engine.submitMessage("第一发"));

    expect(wasModelCalled()).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("热加载生效");

    // 改写为放行（强制 mtime 前移）→ 下次入口重载，prompt 正常进模型
    writeFileSync(file, JSON.stringify([{ event: "UserPromptSubmit", command: `echo '{}'` }]));
    const t = statSync(file).mtimeMs;
    utimesSync(file, new Date(t + 100), new Date(t + 100));

    const out2 = await collect(engine.submitMessage("第二发"));

    expect(wasModelCalled()).toBe(true);
    expect(out2.some((m) => m.type === "result")).toBe(true);
  }, 15_000);

  it("删除 hooks.json → 重载为空，旧 block 失效", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e54c-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), JSON.stringify([
      { event: "UserPromptSubmit", command: `echo '{"block":true,"message":"应已失效"}'` },
    ]));
    const { engine, wasModelCalled } = await makeEngine(dir);
    rmSync(join(dir, ".tupigcode", "hooks.json"));

    const out = await collect(engine.submitMessage("删除后"));

    expect(wasModelCalled()).toBe(true);
    expect(out.every((m) => m.type !== "text" || !m.text.includes("应已失效"))).toBe(true);
  }, 15_000);

  it("mtime 未变 → 不重载（再次 prompt 直接放行）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e54d-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), JSON.stringify([
      { event: "UserPromptSubmit", command: `echo '{}'` },
    ]));
    const { engine, wasModelCalled } = await makeEngine(dir);
    await collect(engine.submitMessage("首拍"));
    expect(wasModelCalled()).toBe(true);

    const out = await collect(engine.submitMessage("二拍"));
    expect(out.some((m) => m.type === "result")).toBe(true);
  }, 15_000);
});

describe("reloadShellHooks 手动强制重载", () => {
  it("返回当前 shell hook 注册数（/hooks reload 用）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e54e-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), JSON.stringify([
      { event: "Stop", command: "echo a" },
      { event: "Stop", command: "echo b" },
    ]));
    const n = initShellHooks(dir, (): HookMatcher[] => [
      { event: "Stop", handler: () => {} },
      { event: "Stop", handler: () => {} },
    ]);
    expect(n).toBe(2);
    expect(hooksFilePath(dir).endsWith("hooks.json")).toBe(true);

    // 手动重载不看 mtime：改文件后强制 reload 计数仍是工厂产出
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), "[]");
    const n2 = reloadShellHooks();
    expect(n2).toBe(2);
    hookSystem.reloadShell([]);
  });

  it("reloadShellHooksIfChanged：mtime 未变返回 false，变化返回 true", () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e54f-"));
    mkdirSync(join(dir, ".tupigcode"), { recursive: true });
    writeFileSync(join(dir, ".tupigcode", "hooks.json"), "[]");
    initShellHooks(dir, (): HookMatcher[] => []);

    expect(reloadShellHooksIfChanged()).toBe(false);

    writeFileSync(join(dir, ".tupigcode", "hooks.json"), JSON.stringify([
      { event: "Stop", command: "echo x" },
    ]));
    expect(reloadShellHooksIfChanged()).toBe(true);
    hookSystem.reloadShell([]);
  });
});
