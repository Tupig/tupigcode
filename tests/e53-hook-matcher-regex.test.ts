/**
 * E53 hook matcher 正则化 + decision/modeTo 解析（issue #50）
 *
 * - tool_name 全串锚定正则 `^(?:p)$`：Edit|Write 命中且不误伤 MultiEdit
 * - 既有精确配置行为不变；子串意图用 `.*X.*`
 * - 非法正则回退精确比较
 * - loadShellHooks 解析并保留 matcher.decision/modeTo
 * - hashRule 纳入 matcher 全字段，配置变更重询 TOFU
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { hookSystem, loadShellHooks, type ShellHookConfig } from "../src/engine/hooks";
import { hashRule } from "../src/engine/hookTrust";

beforeAll(() => { process.env.TUPIG_MOCK = "1"; });
beforeEach(() => { hookSystem.clear(); });
afterEach(() => { hookSystem.clear(); });

const ctx = { turnNumber: 1, sessionId: "s1" };

describe("tool_name 正则匹配（全串锚定）", () => {
  it("Edit|Write 命中两个工具，不误伤 MultiEdit/Bash", async () => {
    const hit: string[] = [];
    hookSystem.register({
      event: "PreToolUse",
      matcher: { tool_name: "Edit|Write" },
      handler: (c) => { hit.push(c.toolName!); },
    });

    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Edit" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Write" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "MultiEdit" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Bash" });

    expect(hit).toEqual(["Edit", "Write"]);
  });

  it("精确配置只命中全串（Read 不命中 ReadFile）", async () => {
    const hit: string[] = [];
    hookSystem.register({
      event: "PreToolUse",
      matcher: { tool_name: "Read" },
      handler: (c) => { hit.push(c.toolName!); },
    });

    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Read" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "ReadFile" });

    expect(hit).toEqual(["Read"]);
  });

  it("子串意图用 .*X.*", async () => {
    const hit: string[] = [];
    hookSystem.register({
      event: "PreToolUse",
      matcher: { tool_name: ".*Edit.*" },
      handler: (c) => { hit.push(c.toolName!); },
    });

    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "MultiEdit" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Bash" });

    expect(hit).toEqual(["MultiEdit"]);
  });

  it("非法正则回退精确比较", async () => {
    const hit: string[] = [];
    hookSystem.register({
      event: "PreToolUse",
      matcher: { tool_name: "[bad" },
      handler: (c) => { hit.push(c.toolName!); },
    });

    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "[bad" });
    await hookSystem.trigger("PreToolUse", { ...ctx, toolName: "Bash" });

    expect(hit).toEqual(["[bad"]);
  });
});

describe("shell hooks 解析 decision/modeTo", () => {
  it("loadShellHooks 透传 matcher.decision/modeTo", () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e53-"));
    const file = join(dir, "hooks.json");
    writeFileSync(file, JSON.stringify([
      {
        event: "PreToolUse",
        matcher: { tool_name: "Edit|Write", decision: "deny", modeTo: "act" },
        command: "echo hi",
      },
    ]));
    const prev = process.env.TUPIG_HOOKS_FILE;
    process.env.TUPIG_HOOKS_FILE = file;
    try {
      const cfgs = loadShellHooks(dir);
      expect(cfgs).toHaveLength(1);
      expect(cfgs[0].matcher?.tool_name).toBe("Edit|Write");
      expect(cfgs[0].matcher?.decision).toBe("deny");
      expect(cfgs[0].matcher?.modeTo).toBe("act");
    } finally {
      if (prev === undefined) delete process.env.TUPIG_HOOKS_FILE;
      else process.env.TUPIG_HOOKS_FILE = prev;
    }
  });

  it("非法 decision 值被剔除（不透传脏数据）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tupig-e53b-"));
    const file = join(dir, "hooks.json");
    writeFileSync(file, JSON.stringify([
      { event: "PreToolUse", matcher: { decision: "banana" }, command: "echo hi" },
    ]));
    const prev = process.env.TUPIG_HOOKS_FILE;
    process.env.TUPIG_HOOKS_FILE = file;
    try {
      const cfgs = loadShellHooks(dir);
      expect(cfgs[0].matcher?.decision).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TUPIG_HOOKS_FILE;
      else process.env.TUPIG_HOOKS_FILE = prev;
    }
  });

  it("decision/modeTo 过滤生效（解析后的 matcher 经 trigger 生效）", async () => {
    const hit: string[] = [];
    hookSystem.register({
      event: "PreToolUse",
      matcher: { decision: "deny", modeTo: "act" },
      handler: (c) => { hit.push(c.decision!); },
    });

    await hookSystem.trigger("PreToolUse", { ...ctx, decision: "deny", modeTo: "act" });
    await hookSystem.trigger("PreToolUse", { ...ctx, decision: "allow", modeTo: "act" });
    await hookSystem.trigger("PreToolUse", { ...ctx, decision: "deny", modeTo: "plan" });

    expect(hit).toEqual(["deny"]);
  });
});

describe("hashRule 覆盖 matcher 全字段", () => {
  const base: ShellHookConfig = {
    event: "PreToolUse",
    matcher: { tool_name: "Edit", source: "auto" },
    command: "echo hi",
    timeout: 5000,
  };

  it("同规则 hash 稳定", () => {
    expect(hashRule(base)).toBe(hashRule({ ...base, matcher: { ...base.matcher! } }));
  });

  it("decision/modeTo/source 任一变更 → hash 不同", () => {
    expect(hashRule(base)).not.toBe(hashRule({ ...base, matcher: { ...base.matcher!, decision: "deny" } }));
    expect(hashRule(base)).not.toBe(hashRule({ ...base, matcher: { ...base.matcher!, modeTo: "act" } }));
    expect(hashRule(base)).not.toBe(hashRule({ ...base, matcher: { tool_name: "Edit" } }));
  });
});
