/**
 * E81 Analysis 工具补测（refs #125）：CodeStats / ListFunctions / DependencyAnalysis / ComplexityAnalysis。
 * 全部纯文件扫描，tmp 夹具，无外网无 LLM。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeStatsTool, ListFunctionsTool, DependencyAnalysisTool, ComplexityAnalysisTool } from "../../src/tools/Analysis";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CodeStatsTool", () => {
  it("统计代码/注释/空行（.ts 夹具）", async () => {
    fs.writeFileSync(
      path.join(dir, "a.ts"),
      "const x = 1;\n// comment\n\n/* block\nconst y = 2;\n",
    );
    const r = await CodeStatsTool.call({ path: "." } as never, ctx(dir), allow);
    const out = String(r.data);
    expect(out).toContain("文件数：1");
    expect(out).toContain("总行数：6");
    expect(out).toContain("代码行：2");
    expect(out).toContain("注释行：2"); // "// comment" + "/* block"
    expect(out).toContain("空行：2"); // 中间 1 空行 + 尾换行 split 出的 ""
  });

  it("路径不存在 → 结构化提示", async () => {
    const r = await CodeStatsTool.call({ path: "nope" } as never, ctx(dir), allow);
    expect(String(r.data)).toContain("路径不存在");
  });
});

describe("ListFunctionsTool", () => {
  it("TS 函数/类方法识别 + pattern 过滤 + 未命中", async () => {
    const f = path.join(dir, "fns.ts");
    fs.writeFileSync(f, "function alpha() {}\nclass B { beta() {} }\nconst gamma = () => {};\n");
    const r = await ListFunctionsTool.call({ file_path: "fns.ts" } as never, ctx(dir), allow);
    const out = String(r.data);
    expect(out).toContain("function");
    expect(out).toContain("alpha");

    const filtered = await ListFunctionsTool.call(
      { file_path: "fns.ts", pattern: "^alpha$" } as never,
      ctx(dir),
      allow,
    );
    expect(String(filtered.data)).toContain("alpha");

    const none = await ListFunctionsTool.call(
      { file_path: "fns.ts", pattern: "^zzz$" } as never,
      ctx(dir),
      allow,
    );
    expect(String(none.data)).toBe("未找到函数定义");
  });

  it("文件不存在 → 提示", async () => {
    const r = await ListFunctionsTool.call({ file_path: "missing.ts" } as never, ctx(dir), allow);
    expect(String(r.data)).toContain("文件不存在");
  });
});

describe("DependencyAnalysisTool", () => {
  it("depth=1 列直接依赖；depth=2 递归出间接依赖；缺失文件提示", async () => {
    fs.writeFileSync(path.join(dir, "c.ts"), "export const c = 1;\n");
    fs.writeFileSync(path.join(dir, "b.ts"), 'import { c } from "./c.js";\nexport const b = c;\n');
    fs.writeFileSync(path.join(dir, "a.ts"), 'import { b } from "./b.js";\nconsole.log(b);\n');
    const d1 = await DependencyAnalysisTool.call({ file_path: "a.ts", depth: 1 } as never, ctx(dir), allow);
    expect(String(d1.data)).toContain("直接依赖");
    expect(String(d1.data)).not.toContain("间接依赖");

    const d2 = await DependencyAnalysisTool.call({ file_path: "a.ts", depth: 2 } as never, ctx(dir), allow);
    expect(String(d2.data)).toContain("间接依赖");

    const miss = await DependencyAnalysisTool.call({ file_path: "no.ts" } as never, ctx(dir), allow);
    expect(String(miss.data)).toContain("文件不存在");
  });
});

describe("ComplexityAnalysisTool", () => {
  it("圈复杂度评级分支：简单 / 中等；缺失文件提示", async () => {
    fs.writeFileSync(path.join(dir, "simple.ts"), "function s() { return 1; }\n");
    const easy = await ComplexityAnalysisTool.call({ file_path: "simple.ts" } as never, ctx(dir), allow);
    expect(String(easy.data)).toContain("评级：简单");

    const branches: string[] = ["function c(x) {"];
    for (let i = 0; i < 12; i++) branches.push(`  if (x === ${i}) { x++; }`);
    branches.push("  return x;", "}");
    fs.writeFileSync(path.join(dir, "mid.ts"), branches.join("\n") + "\n");
    const mid = await ComplexityAnalysisTool.call({ file_path: "mid.ts" } as never, ctx(dir), allow);
    expect(String(mid.data)).toContain("评级：中等");

    const miss = await ComplexityAnalysisTool.call({ file_path: "no.ts" } as never, ctx(dir), allow);
    expect(String(miss.data)).toContain("文件不存在");
  });
});
