/**
 * I3 hooks 退出码 0/2 + fail-closed（A9）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { interpretShellExit, HookSystem, loadShellHooks } from "../../src/engine/hooks";

const ctx = { turnNumber: 1, sessionId: "s1" };

describe("interpretShellExit 退出码语义（A9）", () => {
  it("0 + 空 stdout → 放行", () => {
    const r = interpretShellExit(0, "", "", false);
    expect(r.block).toBeFalsy();
  });
  it("0 + stdout JSON → 解析 block/replacement", () => {
    const r = interpretShellExit(0, JSON.stringify({ block: true, message: "拒" }), "", false);
    expect(r.block).toBe(true);
    expect(r.message).toBe("拒");
  });
  it("2 → 阻断，消息取 stderr（回喂）", () => {
    const r = interpretShellExit(2, "ignored", "危险：rm -rf", false);
    expect(r.block).toBe(true);
    expect(r.message).toBe("危险：rm -rf");
  });
  it("2 + 空 stderr → 消息取 stdout 兜底", () => {
    const r = interpretShellExit(2, "out-text", "", false);
    expect(r.block).toBe(true);
    expect(r.message).toBe("out-text");
  });
  it("其他非零 → fail-closed 阻断", () => {
    const r = interpretShellExit(1, "", "boom", false);
    expect(r.block).toBe(true);
    expect(r.message).toContain("fail-closed");
    expect(r.message).toContain("1");
  });
  it("TUPIG_HOOKS_FAIL_OPEN=1 → 非 0/2 放行", () => {
    process.env.TUPIG_HOOKS_FAIL_OPEN = "1";
    const r = interpretShellExit(1, "", "", false);
    delete process.env.TUPIG_HOOKS_FAIL_OPEN;
    expect(r.block).toBeFalsy();
  });
  it("超时（code=null）→ fail-closed 阻断", () => {
    const r = interpretShellExit(null, "", "", false);
    expect(r.block).toBe(true);
    expect(r.message).toContain("超时");
  });
});

describe("HookSystem.triggerShellHook 实跑", () => {
  it("exit 2 → block", async () => {
    const hs = new HookSystem();
    const r = await hs.triggerShellHook("echo '不许' >&2; exit 2", ctx);
    expect(r.block).toBe(true);
    expect(r.message).toContain("不许");
  });
  it("exit 0 放行", async () => {
    const hs = new HookSystem();
    const r = await hs.triggerShellHook("exit 0", ctx);
    expect(r.block).toBeFalsy();
  });
  it("exit 1 → fail-closed 阻断", async () => {
    const hs = new HookSystem();
    const r = await hs.triggerShellHook("exit 1", ctx);
    expect(r.block).toBe(true);
    expect(r.message).toContain("fail-closed");
  });
  it("超时 → fail-closed 阻断", async () => {
    const hs = new HookSystem();
    const r = await hs.triggerShellHook("sleep 5", ctx, 200);
    expect(r.block).toBe(true);
    expect(r.message).toContain("超时");
  });
});

describe("loadShellHooks 配置加载", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-hooks-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("有效配置解析", () => {
    fs.mkdirSync(path.join(dir, ".tupigcode"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".tupigcode", "hooks.json"),
      JSON.stringify([
        { event: "PreToolUse", matcher: { tool_name: "Bash" }, command: "exit 2", timeout: 1000 },
        { event: "PostToolUse", command: "exit 0" },
      ]),
    );
    const hooks = loadShellHooks(dir);
    expect(hooks.length).toBe(2);
    expect(hooks[0].event).toBe("PreToolUse");
    expect(hooks[0].matcher?.tool_name).toBe("Bash");
    expect(hooks[0].command).toBe("exit 2");
    expect(hooks[1].matcher).toBeUndefined();
  });
  it("坏 JSON → 空不抛", () => {
    fs.mkdirSync(path.join(dir, ".tupigcode"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tupigcode", "hooks.json"), "{bad");
    expect(loadShellHooks(dir)).toEqual([]);
  });
  it("无文件 → 空", () => {
    expect(loadShellHooks(dir)).toEqual([]);
  });
});

describe("PreToolUse 匹配执行", () => {
  it("注册的 shell hook 按 tool 匹配并阻断", async () => {
    const hs = new HookSystem();
    const hooks = [
      {
        event: "PreToolUse" as const,
        matcher: { tool_name: "Bash" },
        command: "echo '阻断理由' >&2; exit 2",
        timeout: 2000,
      },
    ];
    for (const h of hooks) {
      hs.register({
        event: h.event,
        matcher: h.matcher,
        handler: (c) => hs.triggerShellHook(h.command, c, h.timeout),
      });
    }
    const r = await hs.trigger("PreToolUse", { ...ctx, toolName: "Bash", input: {} });
    expect(r.block).toBe(true);
    expect(r.message).toContain("阻断理由");
    const other = await hs.trigger("PreToolUse", { ...ctx, toolName: "Read", input: {} });
    expect(other.block).toBeFalsy();
  });
});
