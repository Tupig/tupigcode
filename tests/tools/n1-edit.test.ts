/**
 * N1 编辑加固：相似行回喂（A1）+ lint 拦截回滚（A2/A3）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { levenshtein, findSimilarLines, formatNoMatchFeedback } from "../../src/tools/similar";
import { writeWithRollback } from "../../src/tools/rollback";
import fs from "fs";
import os from "os";
import path from "path";

describe("levenshtein", () => {
  it("相同 → 0", () => expect(levenshtein("abc", "abc")).toBe(0));
  it("单字符差 → 1", () => expect(levenshtein("abc", "abd")).toBe(1));
  it("空串 → 长度", () => expect(levenshtein("", "abcd")).toBe(4));
});

describe("findSimilarLines 相近行提示（A1）", () => {
  const content = [
    "export function hello() {",
    "  const x = compute(a, b);",
    "  return x + 1;",
    "}",
  ].join("\n");

  it("拼写偏差行被找回（行号+距离）", () => {
    const hits = findSimilarLines(content, "  const x = compute(a, b)", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].line).toBe(2);
    expect(hits[0].text).toContain("compute");
  });
  it("完全无关内容距离大但仍返回 topK", () => {
    const hits = findSimilarLines(content, "zzzzzzzzzzzzzzzz", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
  it("空内容 → 空", () => {
    expect(findSimilarLines("", "x", 3)).toEqual([]);
  });
});

describe("formatNoMatchFeedback 失败回喂（A1）", () => {
  const content = "const a = 1;\nfunction main() { return a; }\n";
  it("含未找到提示+相似行+行号", () => {
    const msg = formatNoMatchFeedback(content, "function main(){ return a; }", "src/x.ts");
    expect(msg).toContain("未找到");
    expect(msg).toContain("src/x.ts");
    expect(msg).toContain("行");
    expect(msg).toContain("main");
  });
  it("有建议重读提示", () => {
    const msg = formatNoMatchFeedback(content, "完全不存在的内容xyz", "f.ts");
    expect(msg).toMatch(/重新读取|read/i);
  });
});

describe("writeWithRollback lint 拦截（A2/A3）", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tupigcode-rollback-"));
    file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "const a = 1;\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lint 失败 → 不落盘（回滚）+ 返回失败", async () => {
    const r = await writeWithRollback(file, "const a =;", () =>
      Promise.resolve({ success: false, output: "TS1005: ';' expected" }),
    );
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\n");
    expect(r.lint?.output).toContain("TS1005");
  });
  it("lint 通过 → 落盘", async () => {
    const r = await writeWithRollback(file, "const a = 2;\n", () =>
      Promise.resolve({ success: true, output: "" }),
    );
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 2;\n");
  });
  it("无 linter（null）→ 落盘", async () => {
    const r = await writeWithRollback(file, "const a = 3;\n", () => Promise.resolve(null));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 3;\n");
  });
  it("lint 抛异常 → 回滚不炸", async () => {
    const r = await writeWithRollback(file, "const a =;", () => Promise.reject(new Error("linter crash")));
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\n");
  });
});
