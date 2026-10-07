/**
 * E10 提示词优化（workbuddy 类）：/optimize + 规则式结构补全
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { optimizePrompt, parseOptimizeCommand, needsClarification, appendPromptStyle } from "../../src/engine/promptOptimize";
import fs from "fs";
import os from "os";
import path from "path";

describe("parseOptimizeCommand", () => {
  it("/optimize 提取原文", () => {
    expect(parseOptimizeCommand("/optimize 帮我修这个 bug")).toBe("帮我修这个 bug");
  });
  it("/优化 中文别名", () => {
    expect(parseOptimizeCommand("/优化 把读取函数改安全点")).toBe("把读取函数改安全点");
  });
  it("无参数命令 → 空串", () => {
    expect(parseOptimizeCommand("/optimize")).toBe("");
  });
  it("非命令 → null", () => {
    expect(parseOptimizeCommand("读 src/index.ts")).toBeNull();
    expect(parseOptimizeCommand("/model")).toBeNull();
  });
});

describe("optimizePrompt 结构补全（规则式，不开自迭代）", () => {
  it("模糊短指令 → 结构化含目标段", () => {
    const out = optimizePrompt("优化下这段代码");
    expect(out).toContain("目标：");
    expect(out).toContain("优化下这段代码");
  });
  it("已结构化（含目标：）→ 不重复包装", () => {
    const src = "目标：修复登录\n约束：不改数据库";
    expect(optimizePrompt(src)).toBe(src);
  });
  it("保留原始关键词（忠实性，不改意图）", () => {
    const out = optimizePrompt("给 CLI 加个超时参数");
    expect(out).toContain("给 CLI 加个超时参数");
    expect(out).toMatch(/验收|输出/);
  });
  it("多行指令保留内容", () => {
    const src = "第一行做A\n第二行做B";
    const out = optimizePrompt(src);
    expect(out).toContain("第一行做A");
    expect(out).toContain("第二行做B");
  });
});

describe("needsClarification 缺信息检测", () => {
  it("纯模糊词 → 需澄清", () => {
    expect(needsClarification("优化一下")).toBe(true);
    expect(needsClarification("弄好它")).toBe(true);
  });
  it("有明确动词对象 → 不需", () => {
    expect(needsClarification("读 src/index.ts 并解释流程")).toBe(false);
    expect(needsClarification("把 timeout 从 60 改成 1800")).toBe(false);
  });
});

describe("appendPromptStyle 偏好记忆", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-style-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("追加一行 JSONL", () => {
    appendPromptStyle(dir, { action: "reject", prompt: "优化下这段代码", reason: "意图已清晰" });
    appendPromptStyle(dir, { action: "accept", prompt: "x", reason: "结构缺失" });
    const lines = fs.readFileSync(path.join(dir, "prompt-style.md"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe("reject");
  });
  it("目录不存在则创建", () => {
    appendPromptStyle(path.join(dir, "a", "b"), { action: "accept", prompt: "p", reason: "r" });
    expect(fs.existsSync(path.join(dir, "a", "b", "prompt-style.md"))).toBe(true);
  });
});
