/**
 * E58 MultiEdit 多组替换原子编辑（issue #55）
 *
 * - 多处按序替换一次原子落盘
 * - 任一不匹配 → 整体不落盘，报「第 N 处」
 * - replace_all 逐处生效；文件不存在报错
 * - 注册：extras 池 + resolveExtraTools；非核心常驻；检索别名命中
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { MultiEditTool } from "../../src/tools/MultiEdit";
import { getExtraTools, resolveExtraTools, getDefaultTools } from "../../src/engine/tool-registry";
import { resetLazyStore, setSearchPool, searchDeferred } from "../../src/engine/lazy-tools";

let dir = "";
const ctx = () => ({ workDir: dir, readFileState: new Map() }) as any;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "tupig-e58-")); });
afterAll(() => {
  delete process.env.TUPIG_EXTRA_TOOLS;
  resetLazyStore();
});

describe("MultiEdit 原子编辑", () => {
  it("多处按序替换成功 → 一次落盘", async () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "alpha\nbeta\ngamma\n");

    const r: any = await MultiEditTool.call({
      file_path: f,
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "gamma", new_string: "GAMMA" },
      ],
    }, ctx());

    expect(r.data).toContain("2");
    const content = readFileSync(f, "utf-8");
    expect(content).toBe("ALPHA\nbeta\nGAMMA\n");
  }, 15_000);

  it("第 2 处不匹配 → 整体不落盘（第 1 处也不生效）", async () => {
    const f = join(dir, "b.ts");
    writeFileSync(f, "one\ntwo\nthree\n");

    const r: any = await MultiEditTool.call({
      file_path: f,
      edits: [
        { old_string: "one", new_string: "ONE" },
        { old_string: "missing", new_string: "X" },
      ],
    }, ctx());

    expect(r.data).toContain("第 2 处");
    expect(r.data).not.toContain("第 1 处");
    expect(readFileSync(f, "utf-8")).toBe("one\ntwo\nthree\n"); // 原子：全未生效
  }, 15_000);

  it("多处匹配未 replace_all → 报「第 N 处不匹配」", async () => {
    const f = join(dir, "c.ts");
    writeFileSync(f, "x x x\n");

    const r: any = await MultiEditTool.call({
      file_path: f,
      edits: [{ old_string: "x", new_string: "Y" }],
    }, ctx());

    expect(r.data).toContain("第 1 处");
    expect(readFileSync(f, "utf-8")).toBe("x x x\n");
  }, 15_000);

  it("replace_all 逐处生效", async () => {
    const f = join(dir, "d.ts");
    writeFileSync(f, "a-b-a\nkeep\n");

    const r: any = await MultiEditTool.call({
      file_path: f,
      edits: [
        { old_string: "a", new_string: "X", replace_all: true },
        { old_string: "keep", new_string: "KEEP" },
      ],
    }, ctx());

    expect(readFileSync(f, "utf-8")).toBe("X-b-X\nKEEP\n");
    expect(r.data).toContain("成功");
  }, 15_000);

  it("文件不存在 → 错误且不落盘", async () => {
    const f = join(dir, "nope.ts");
    const r: any = await MultiEditTool.call({
      file_path: f,
      edits: [{ old_string: "a", new_string: "b" }],
    }, ctx());
    expect(r.data).toContain("未找到");
    expect(existsSync(f)).toBe(false);
  }, 15_000);
});

describe("注册与检索", () => {
  it("在 extras 池且不在核心常驻集", () => {
    expect(getExtraTools().some((t) => t.name === "MultiEdit")).toBe(true);
    expect(getDefaultTools().some((t) => t.name === "MultiEdit")).toBe(false);
  });

  it("TUPIG_EXTRA_TOOLS=MultiEdit → 常驻解析", () => {
    process.env.TUPIG_EXTRA_TOOLS = "MultiEdit,WebFetch";
    try {
      const tools = resolveExtraTools();
      expect(tools.some((t) => t.name === "MultiEdit")).toBe(true);
    } finally {
      delete process.env.TUPIG_EXTRA_TOOLS;
    }
  });

  it("检索别名命中（multi edit / 批量编辑）", () => {
    resetLazyStore();
    setSearchPool([MultiEditTool]);
    const hits = searchDeferred("multi edit");
    expect(hits.some((t) => t.name === "MultiEdit")).toBe(true);
    resetLazyStore();
    setSearchPool([MultiEditTool]);
    const hits2 = searchDeferred("批量编辑");
    expect(hits2.some((t) => t.name === "MultiEdit")).toBe(true);
    resetLazyStore();
  });
});
