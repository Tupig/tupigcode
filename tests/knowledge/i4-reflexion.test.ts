/**
 * I4 复盘写回（A24）：review 代理四选一 + 先审后存 staging + runs 留痕
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  buildRetroPrompt,
  parseReviewDecision,
  applyReviewDecision,
  extractFailures,
  listRuns,
} = await import("../../src/knowledge/reflexion");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i4-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildRetroPrompt", () => {
  it("含四选一动作与 JSON 输出要求", () => {
    const p = buildRetroPrompt({ diff: "+const a = 1", failures: ["Edit 失败：相似行不匹配"] });
    expect(p).toContain("discard");
    expect(p).toContain("merge");
    expect(p).toContain("skill");
    expect(p).toContain("rule");
    expect(p).toContain("JSON");
    expect(p).toContain("Edit 失败");
  });

  it("无改动时明确说明", () => {
    expect(buildRetroPrompt({ diff: "", failures: [] })).toMatch(/无可复盘/);
  });

  it("diff 超预算截断", () => {
    const p = buildRetroPrompt({ diff: "x".repeat(20_000), failures: [] });
    expect(p.length).toBeLessThan(22_000);
    expect(p).toMatch(/截断/);
  });
});

describe("parseReviewDecision", () => {
  it("纯 JSON 直接解析", () => {
    const d = parseReviewDecision('{"action":"skill","reason":"重复犯错","content":"## 遇到 X 用 Y"}');
    expect(d).toMatchObject({ action: "skill", reason: "重复犯错" });
    expect(d!.content).toContain("遇到 X");
  });

  it("代码块与前后废话容错", () => {
    const text = '好的，我复盘如下：\n```json\n{"action":"rule","reason":"安全约定","content":"禁止盲跑 rm"}\n```\n以上。';
    expect(parseReviewDecision(text)).toMatchObject({ action: "rule" });
  });

  it("非法 action → null", () => {
    expect(parseReviewDecision('{"action":"delete-everything","reason":"x"}')).toBeNull();
  });

  it("非 JSON → null", () => {
    expect(parseReviewDecision("我觉得这次做得不错，继续保持。")).toBeNull();
  });

  it("skill/rule 缺 content → null（无法落地）", () => {
    expect(parseReviewDecision('{"action":"skill","reason":"有想法"}')).toBeNull();
  });

  it("discard/merge 允许无 content", () => {
    expect(parseReviewDecision('{"action":"discard","reason":"这次改动无价值"}')).toBeTruthy();
    expect(parseReviewDecision('{"action":"merge","reason":"可以保留"}')).toBeTruthy();
  });
});

describe("extractFailures", () => {
  it("从会话消息里抽 is_error 的工具结果", () => {
    const msgs: any[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Edit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "错误：相似行不匹配", is_error: true }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "正常结果", is_error: false }] },
    ];
    const out = extractFailures(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("相似行不匹配");
  });

  it("空消息安全", () => {
    expect(extractFailures([])).toEqual([]);
    expect(extractFailures([{ role: "user", content: "纯文本" }])).toEqual([]);
  });
});

describe("applyReviewDecision", () => {
  it("skill → staging 草稿（先审后存，不直接入 skills）", () => {
    const r = applyReviewDecision(dir, {
      action: "skill", reason: "重复犯错", content: "## 用 X 代替 Y",
    }, "run-1");
    expect(r.applied).toBe(true);
    expect(existsSync(join(dir, ".tupigcode", "staging"))).toBe(true);
    const staged = readdirSync(join(dir, ".tupigcode", "staging"));
    expect(staged.some((f) => f.endsWith(".md"))).toBe(true);
    expect(existsSync(join(dir, ".tupigcode", "skills"))).toBe(false);
  });

  it("rule → staging/rules 草稿", () => {
    const r = applyReviewDecision(dir, { action: "rule", reason: "约定", content: "- 禁止盲跑 rm" }, "run-2");
    expect(r.applied).toBe(true);
    expect(existsSync(join(dir, ".tupigcode", "staging", "rules"))).toBe(true);
  });

  it("discard/merge 只留 run 记录，不写草稿", () => {
    const r1 = applyReviewDecision(dir, { action: "discard", reason: "无价值" }, "run-3");
    const r2 = applyReviewDecision(dir, { action: "merge", reason: "保留" }, "run-4");
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true);
    const runs = readdirSync(join(dir, ".tupigcode", "runs"));
    expect(runs.length).toBe(2);
    expect(existsSync(join(dir, ".tupigcode", "staging"))).toBe(false);
  });

  it("每次应用都写 runs 留痕含 action", () => {
    applyReviewDecision(dir, { action: "merge", reason: "ok" }, "run-9");
    const run = JSON.parse(readFileSync(join(dir, ".tupigcode", "runs", "run-9.json"), "utf-8"));
    expect(run.action).toBe("merge");
    expect(run.ts).toBeTruthy();
  });
});

describe("listRuns", () => {
  it("按时间倒序列出", () => {
    applyReviewDecision(dir, { action: "merge", reason: "a" }, "r1");
    applyReviewDecision(dir, { action: "discard", reason: "b" }, "r2");
    const runs = listRuns(dir);
    expect(runs).toHaveLength(2);
    expect(runs[0].id >= runs[1].id).toBe(true);
    expect(["merge", "discard"]).toContain(runs[0].action);
  });

  it("无 runs 返回空", () => {
    expect(listRuns(dir)).toEqual([]);
  });
});
