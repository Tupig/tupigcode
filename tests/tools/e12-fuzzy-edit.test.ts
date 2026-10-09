/**
 * E12 FileEdit 模糊编辑容错：精确快路径 + 归一化/相似度回退。
 * 来源思路：Aider fuzzy-match（Apache-2.0，仅算法思路）；对应 issue #3。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileEditTool } from "../../src/tools/FileEdit";
import { drainTurnOps, resetTurnOps } from "../../src/engine/diff-review";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

const allow: CanUseToolFn = async () => ({ behavior: "allow" });

let dir: string;
let ctx: ToolUseContext;

function mkCtx(workDir: string): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir,
    sessionId: "s1",
  };
}

async function edit(file: string, oldStr: string, newStr: string, replaceAll = false) {
  const r = await FileEditTool.call(
    { file_path: file, old_string: oldStr, new_string: newStr, replace_all: replaceAll },
    ctx,
    allow,
  );
  return String(r.data);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-edit-"));
  ctx = mkCtx(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileEdit 模糊回退", () => {
  it("精确匹配走快路径：替换正确且结果不含「模糊」", async () => {
    const p = path.join(dir, "a.ts");
    fs.writeFileSync(p, "const x = 1;\nconst y = 2;\n");
    const msg = await edit(p, "const x = 1;", "const x = 9;");
    expect(fs.readFileSync(p, "utf-8")).toBe("const x = 9;\nconst y = 2;\n");
    expect(msg).toContain("已成功编辑");
    expect(msg).not.toContain("模糊");
  });

  it("缩进差异（tab vs 空格）模糊命中并替换", async () => {
    const p = path.join(dir, "b.ts");
    fs.writeFileSync(p, "function f() {\n    return 1;\n}\n");
    const msg = await edit(p, "function f() {\n\treturn 1;\n}", "function f() {\n\treturn 2;\n}");
    expect(msg).toContain("已成功编辑");
    expect(msg).toContain("模糊");
    expect(fs.readFileSync(p, "utf-8")).toBe("function f() {\n\treturn 2;\n}\n");
  });

  it("行尾多余空白差异模糊命中", async () => {
    const p = path.join(dir, "c.ts");
    fs.writeFileSync(p, "const flag = true;   \nconst z = 3;\n");
    const msg = await edit(p, "const flag = true;\nconst z = 3;", "const flag = false;\nconst z = 9;");
    expect(msg).toContain("模糊");
    expect(fs.readFileSync(p, "utf-8")).toBe("const flag = false;\nconst z = 9;\n");
  });

  it("长行单字符拼写差异（编辑距离 1）模糊命中", async () => {
    const p = path.join(dir, "d.ts");
    fs.writeFileSync(p, "export const projectName = 'tupigcode-agent-runtime';\n");
    const msg = await edit(p, "export const projectName = 'tupigcode-agent-runtme';", "export const projectName = 'fixed';");
    expect(msg).toContain("模糊");
    expect(fs.readFileSync(p, "utf-8")).toBe("export const projectName = 'fixed';\n");
  });

  it("多行窗口中仅一行缩进差异，整体仍命中", async () => {
    const p = path.join(dir, "e.ts");
    fs.writeFileSync(p, "if (a) {\n  b();\n  c();\n}\n");
    const msg = await edit(p, "if (a) {\n    b();\n  c();\n}", "if (a) {\n  b2();\n  c();\n}");
    expect(msg).toContain("已成功编辑");
    expect(fs.readFileSync(p, "utf-8")).toBe("if (a) {\n  b2();\n  c();\n}\n");
  });

  it("完全不相似仍报「未找到」，文件不变", async () => {
    const p = path.join(dir, "f.ts");
    const orig = "const alpha = 1;\nconst beta = 2;\n";
    fs.writeFileSync(p, orig);
    const msg = await edit(p, "完全没有的文本内容啊哈哈哈", "anything");
    expect(msg).toContain("未找到");
    expect(fs.readFileSync(p, "utf-8")).toBe(orig);
  });

  it("多处模糊候选 → 报错且文件不变", async () => {
    const p = path.join(dir, "g.ts");
    const orig = "doSomething();\ndoSomething();\ndoSomething();\n";
    fs.writeFileSync(p, orig);
    const msg = await edit(p, "doSomething ();", "next();");
    expect(msg).toContain("模糊");
    expect(msg).toContain("无法确定");
    expect(fs.readFileSync(p, "utf-8")).toBe(orig);
  });

  it("replace_all 精确多处：计数与替换正确（现状回归）", async () => {
    const p = path.join(dir, "h.ts");
    fs.writeFileSync(p, "aa bb aa bb aa\n");
    const msg = await edit(p, "aa", "XX", true);
    expect(msg).toContain("替换 3 处");
    expect(fs.readFileSync(p, "utf-8")).toBe("XX bb XX bb XX\n");
  });

  it("旧引号归一化路径保持现状（弯引号→直引号）", async () => {
    const p = path.join(dir, "i.ts");
    fs.writeFileSync(p, "const s = ‘hello’;\n");
    const msg = await edit(p, "const s = 'hello';", "const s = \"hello\";");
    expect(msg).toContain("已成功编辑");
    expect(msg).not.toContain("模糊");
    expect(fs.readFileSync(p, "utf-8")).toBe('const s = "hello";\n');
  });
});

describe("FileEdit turn ops（fix #120：主路径进 diff review）", () => {
  it("精确匹配主路径 pushTurnOp", async () => {
    resetTurnOps();
    const p = path.join(dir, "t1.ts");
    fs.writeFileSync(p, "const a = 1;\n");
    await edit(p, "const a = 1;", "const a = 2;");
    const ops = drainTurnOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].path).toBe(path.resolve(p));
    expect(ops[0].before).toBe("const a = 1;\n");
    expect(ops[0].after).toBe("const a = 2;\n");
  });

  it("replace_all 主路径 pushTurnOp", async () => {
    resetTurnOps();
    const p = path.join(dir, "t2.ts");
    fs.writeFileSync(p, "aa bb aa\n");
    await edit(p, "aa", "XX", true);
    const ops = drainTurnOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].before).toBe("aa bb aa\n");
    expect(ops[0].after).toBe("XX bb XX\n");
  });
});
