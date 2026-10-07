/**
 * I1 记忆：分层规则+@path 引用（A10）+ 先审后存+引用校验（A11）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveRuleLayers, expandRuleRefs, validateRuleRefs, formatLayersForPrompt } from "../../src/context/rules";
import { stageMemory, commitMemory, loadMemories, formatMemoriesForPrompt } from "../../src/knowledge/memory";

let dir: string;
let home: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-i1-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-home-"));
  origHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("resolveRuleLayers 分层（A10）", () => {
  it("无任何规则 → 空", () => {
    expect(resolveRuleLayers(dir)).toEqual([]);
  });
  it("项目规则层存在", () => {
    fs.writeFileSync(path.join(dir, ".tupigcoderules"), "- 用 TS");
    const layers = resolveRuleLayers(dir);
    expect(layers.length).toBe(1);
    expect(layers[0].tier).toBe("project");
    expect(layers[0].content).toContain("用 TS");
  });
  it("全局+项目+就近三层按序", () => {
    fs.mkdirSync(path.join(home, ".tupigcode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".tupigcode", "rules.md"), "全局规则");
    fs.writeFileSync(path.join(dir, ".tupigcoderules"), "项目规则");
    const sub = path.join(dir, "src");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "rules.md"), "就近规则");
    const layers = resolveRuleLayers(dir, path.join(sub, "a.ts"));
    expect(layers.map((l) => l.tier)).toEqual(["global", "project", "local"]);
    expect(layers[0].content).toContain("全局规则");
    expect(layers[2].content).toContain("就近规则");
  });
});

describe("expandRuleRefs @path 引用（A10）", () => {
  it("行首 @path 展开为文件内容", () => {
    fs.writeFileSync(path.join(dir, "guide.md"), "指南正文");
    const out = expandRuleRefs("@guide.md", dir);
    expect(out).toContain("指南正文");
    expect(out).not.toContain("@guide.md");
  });
  it("缺失引用 → 明确占位", () => {
    const out = expandRuleRefs("@missing.md", dir);
    expect(out).toContain("[缺失引用");
    expect(out).toContain("missing.md");
  });
  it("非引用行原样保留", () => {
    const out = expandRuleRefs("- 普通规则\n见 @a.md 尾", dir);
    expect(out).toContain("- 普通规则");
    expect(out).toContain("见 @a.md 尾");
  });
});

describe("validateRuleRefs 引用校验（A11）", () => {
  it("全部存在 → ok", () => {
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    const r = validateRuleRefs("@a.md\n正文", dir);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("缺失列出", () => {
    const r = validateRuleRefs("@gone.md", dir);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["gone.md"]);
  });
});

describe("formatLayersForPrompt", () => {
  it("分层带标题且已展开引用", () => {
    fs.writeFileSync(path.join(dir, ".tupigcoderules"), "@g.md\n- 规则A");
    fs.writeFileSync(path.join(dir, "g.md"), "被引用内容");
    const text = formatLayersForPrompt(resolveRuleLayers(dir));
    expect(text).toContain("## 项目规则");
    expect(text).toContain("被引用内容");
    expect(text).toContain("- 规则A");
  });
});

describe("memory 先审后存（A11）", () => {
  it("stage 不落盘", async () => {
    const staged = stageMemory({ category: "偏好", content: "喜欢函数式" });
    expect(staged.approved).toBe(false);
    expect(await loadMemories(dir)).toEqual([]);
  });
  it("approved=false 拒绝写入", async () => {
    const staged = stageMemory({ category: "偏好", content: "x" });
    const ok = await commitMemory(dir, staged, false);
    expect(ok).toBe(false);
    expect(await loadMemories(dir)).toEqual([]);
  });
  it("approved=true 写入且可加载、格式化注入", async () => {
    const staged = stageMemory({ category: "偏好", content: "提交前跑测试" });
    const ok = await commitMemory(dir, staged, true);
    expect(ok).toBe(true);
    const mems = await loadMemories(dir);
    expect(mems.length).toBe(1);
    expect(mems[0].content).toContain("提交前跑测试");
    const text = formatMemoriesForPrompt(mems);
    expect(text).toContain("## 记忆");
    expect(text).toContain("提交前跑测试");
  });
  it("损坏条目跳过不炸", async () => {
    fs.mkdirSync(path.join(dir, ".tupigcode", "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tupigcode", "memory", "entries.jsonl"), "not-json\n{\"category\":\"a\",\"content\":\"b\"}\n");
    const mems = await loadMemories(dir);
    expect(mems.length).toBe(1);
  });
});
