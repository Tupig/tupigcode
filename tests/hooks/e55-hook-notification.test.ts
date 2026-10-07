/**
 * E55 Notification hook 事件（issue #52）
 *
 * - fireNotification 触发 Notification，ctx.notificationType 正确
 * - matcher.notificationType 过滤：permission_prompt 不命中 idle_prompt
 * - loadShellHooks 解析 notificationType，非法值剔除
 * - promptUserDecision 弹问前 fire permission_prompt；非 TTY 不 fire
 * - createIdleNotifier：到点 fire 一次、line 重置、ms<=0 关闭
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { hookSystem, loadShellHooks } from "../../src/engine/hooks";
import { fireNotification } from "../../src/engine/hookEvents";
import { createIdleNotifier } from "../../src/services/idleNotify";
import { promptUserDecision } from "../../src/services/permissions";

beforeAll(() => {
  process.env.TUPIG_MOCK = "1";
  process.env.TUPIG_HOOK_TRUST = "0";
});
beforeEach(() => { hookSystem.clear(); });
afterEach(() => { hookSystem.clear(); });

const ctx = { turnNumber: 0, sessionId: "s1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fireNotification", () => {
  it("触发 Notification 并携带 notificationType", async () => {
    const seen: (string | undefined)[] = [];
    hookSystem.register({
      event: "Notification",
      handler: (c) => { seen.push(c.notificationType); },
    });

    await fireNotification(undefined, "permission_prompt", ctx);
    await fireNotification(undefined, "idle_prompt", ctx);

    expect(seen).toEqual(["permission_prompt", "idle_prompt"]);
  });

  it("matcher.notificationType 过滤：permission 只命中 permission", async () => {
    const seen: string[] = [];
    hookSystem.register({
      event: "Notification",
      matcher: { notificationType: "permission_prompt" },
      handler: () => { seen.push("permission-hook"); },
    });

    await fireNotification(undefined, "permission_prompt", ctx);
    await fireNotification(undefined, "idle_prompt", ctx);

    expect(seen).toEqual(["permission-hook"]);
  });
});

describe("loadShellHooks 解析 notificationType", () => {
  it("合法值透传，非法值剔除", () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e55-"));
    const file = join(dir, "hooks.json");
    writeFileSync(file, JSON.stringify([
      { event: "Notification", matcher: { notificationType: "permission_prompt" }, command: "echo a" },
      { event: "Notification", matcher: { notificationType: "banana" }, command: "echo b" },
    ]));
    const prev = process.env.TUPIG_HOOKS_FILE;
    process.env.TUPIG_HOOKS_FILE = file;
    try {
      const cfgs = loadShellHooks(dir);
      expect(cfgs[0].matcher?.notificationType).toBe("permission_prompt");
      expect(cfgs[1].matcher?.notificationType).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TUPIG_HOOKS_FILE;
      else process.env.TUPIG_HOOKS_FILE = prev;
    }
  });
});

describe("promptUserDecision 触发 permission_prompt", () => {
  it("TTY 弹问前 fire，用户答复后收尾", async () => {
    const seen: (string | undefined)[] = [];
    hookSystem.register({
      event: "Notification",
      matcher: { notificationType: "permission_prompt" },
      handler: (c) => { seen.push(c.toolName); },
    });

    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const p = promptUserDecision("Write", { file_path: "/tmp/x.ts" });
      await sleep(30); // void fire → 微任务落地
      expect(seen).toEqual(["Write"]);
      process.stdin.emit("data", "y\n");
      expect(await p).toBe("allow");
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as any).isTTY;
    }
  }, 10_000);

  it("非 TTY 直接拒绝且不 fire", async () => {
    const seen: string[] = [];
    hookSystem.register({
      event: "Notification",
      matcher: { notificationType: "permission_prompt" },
      handler: () => { seen.push("hit"); },
    });

    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const d = await promptUserDecision("Write", { file_path: "/tmp/x.ts" });
      expect(d).toBe("deny");
      await sleep(20);
      expect(seen).toEqual([]);
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as any).isTTY;
    }
  });
});

describe("createIdleNotifier", () => {
  it("到点回调一次；reset 后可再次触发", async () => {
    const onIdle = vi.fn();
    const n = createIdleNotifier(60, onIdle);
    n.arm();

    await sleep(120);
    expect(onIdle).toHaveBeenCalledTimes(1);

    await sleep(80);
    expect(onIdle).toHaveBeenCalledTimes(1); // 不重复 fire

    n.reset();
    n.arm();
    await sleep(120);
    expect(onIdle).toHaveBeenCalledTimes(2);
    n.dispose();
  }, 10_000);

  it("ms<=0 关闭不触发", async () => {
    const onIdle = vi.fn();
    const n = createIdleNotifier(0, onIdle);
    n.arm();
    n.arm();

    await sleep(40);
    expect(onIdle).not.toHaveBeenCalled();
    n.dispose();
  });

  it("dispose 后到点不触发", async () => {
    const onIdle = vi.fn();
    const n = createIdleNotifier(50, onIdle);
    n.arm();
    n.dispose();

    await sleep(90);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
