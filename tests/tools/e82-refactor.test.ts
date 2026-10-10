/**
 * E82 Refactor 工具补测（refs #125）：RenameSymbol / ExtractFunction / MoveFile / InlineVariable / ExtractConstant。
 * tmp 夹具 + allow 权限；grep/sed 走真实二进制（CI ubuntu 与 macOS 均可用）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RenameSymbolTool,
  ExtractFunctionTool,
  MoveFileTool,
  InlineVariableTool,
  ExtractConstantTool,
} from "../../src/tools/Refactor";
import type { ToolUseContext, CanUseToolFn } from "../../src/engine/Tool";

const allow: CanUseToolFn = async () => ({ behavior: "allow" });
let dir: string;

function ctx(workDir: string): ToolUseContext {
  return {
    options: { debug: false, mainLoopModel: "m", tools: [], verbose: false, isNonInteractiveSession: false },
    abortController: new AbortController(),
    readFileState: new Map(),
    getMessages: () => [],
    workDir,
    sessionId: "s1",
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RenameSymbolTool", () => {
  it("dryRun 只预览不落盘；真实模式替换；未命中提示", async () => {
    const f = path.join(dir, "m.ts");
    fs.writeFileSync(f, "const oldValue = 1;\nconsole.log(oldValue);\n");

    const preview = await RenameSymbolTool.call(
      { oldName: "oldValue", newName: "newValue", fileType: "ts", dryRun: true } as never,
      ctx(dir),
      allow,
    );
    expect(String(preview.data)).toContain("预览重命名");
    expect(String(preview.data)).toContain("2 处引用");
    expect(fs.readFileSync(f, "utf-8")).toContain("oldValue"); // 未落盘

    const real = await RenameSymbolTool.call(
      { oldName: "oldValue", newName: "newValue", fileType: "ts" } as never,
      ctx(dir),
      allow,
    );
    expect(String(real.data)).toContain("已重命名");
    const after = fs.readFileSync(f, "utf-8");
    expect(after).not.toContain("oldValue");
    expect(after).toContain("newValue");

    const none = await RenameSymbolTool.call(
      { oldName: "notExistSym", newName: "x", fileType: "ts" } as never,
      ctx(dir),
      allow,
    );
    expect(String(none.data)).toContain("未找到符号");
  });
});

describe("ExtractFunctionTool", () => {
  it("选中行变调用 + 函数定义插入文件；行号越界/文件缺失提示", async () => {
    const f = path.join(dir, "e.ts");
    fs.writeFileSync(f, "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");

    const ok = await ExtractFunctionTool.call(
      { file_path: "e.ts", startLine: 1, endLine: 2, functionName: "makePair", params: [] } as never,
      ctx(dir),
      allow,
    );
    expect(String(ok.data)).toContain("已提取函数「makePair」");
    const after = fs.readFileSync(f, "utf-8");
    expect(after).toContain("function makePair() {");
    expect(after).toContain("makePair();");

    const bad = await ExtractFunctionTool.call(
      { file_path: "e.ts", startLine: 99, endLine: 100, functionName: "x" } as never,
      ctx(dir),
      allow,
    );
    expect(String(bad.data)).toContain("起始行号无效");

    const miss = await ExtractFunctionTool.call(
      { file_path: "no.ts", startLine: 1, endLine: 1, functionName: "x" } as never,
      ctx(dir),
      allow,
    );
    expect(String(miss.data)).toContain("文件不存在");
  });
});

describe("MoveFileTool", () => {
  it("移动成功；目标已存在守卫；源缺失提示", async () => {
    fs.writeFileSync(path.join(dir, "src.ts"), "export const v = 1;\n");

    const ok = await MoveFileTool.call(
      { source: "src.ts", destination: "dst.ts" } as never,
      ctx(dir),
      allow,
    );
    expect(String(ok.data)).toContain("已移动");
    expect(fs.existsSync(path.join(dir, "dst.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src.ts"))).toBe(false);

    const exists = await MoveFileTool.call(
      { source: "dst.ts", destination: "dst.ts" } as never,
      ctx(dir),
      allow,
    );
    expect(String(exists.data)).toContain("目标文件已存在");

    const miss = await MoveFileTool.call(
      { source: "ghost.ts", destination: "x.ts" } as never,
      ctx(dir),
      allow,
    );
    expect(String(miss.data)).toContain("源文件不存在");
  });
});

describe("InlineVariableTool", () => {
  it("删除声明并替换引用；未找到声明提示", async () => {
    const f = path.join(dir, "i.ts");
    fs.writeFileSync(f, "const width = 800;\nconsole.log(width);\nrender(width);\n");

    const ok = await InlineVariableTool.call(
      { file_path: "i.ts", variableName: "width" } as never,
      ctx(dir),
      allow,
    );
    expect(String(ok.data)).toContain("已内联变量");
    const after = fs.readFileSync(f, "utf-8");
    expect(after).not.toContain("const width");
    expect(after).toContain("(800)");
    expect(after).not.toMatch(/\bwidth\b/);

    const none = await InlineVariableTool.call(
      { file_path: "i.ts", variableName: "ghostVar" } as never,
      ctx(dir),
      allow,
    );
    expect(String(none.data)).toContain("未找到变量");
  });
});

describe("ExtractConstantTool", () => {
  it("顶部插入常量声明并全局替换；文件缺失提示", async () => {
    const f = path.join(dir, "c.ts");
    fs.writeFileSync(f, "if (x === 42) { y(42); }\n");

    const ok = await ExtractConstantTool.call(
      { file_path: "c.ts", value: "42", constantName: "ANSWER" } as never,
      ctx(dir),
      allow,
    );
    expect(String(ok.data)).toContain("已提取常量「ANSWER」");
    const after = fs.readFileSync(f, "utf-8");
    expect(after.startsWith("const ANSWER = 42;")).toBe(true);
    expect(after).not.toContain("=== 42");
    expect(after).toContain("=== ANSWER");

    const miss = await ExtractConstantTool.call(
      { file_path: "no.ts", value: "1", constantName: "ONE" } as never,
      ctx(dir),
      allow,
    );
    expect(String(miss.data)).toContain("文件不存在");
  });
});
