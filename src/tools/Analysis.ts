/**
 * 代码分析工具
 *
 * 提供代码结构分析、依赖分析、复杂度计算等功能。
 * 灵感来自 SWE-agent 的 ACI 和 Continue 的代码理解。
 */
import { z } from "zod";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { defineTool } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";

const execFileAsync = promisify(execFile);

/**
 * 代码统计工具
 */
export const CodeStatsTool = defineTool({
  name: "CodeStats",
  description: "统计代码行数、注释、空行等信息",
  input: z.object({
    path: z.string().describe("文件或目录路径"),
    recursive: z.boolean().optional().describe("递归统计子目录（默认 true）"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.path);

    if (!existsSync(resolved)) {
      return `路径不存在：${resolved}`;
    }

    try {
      // execFile 无 shell，-name 花括号不展开 → 显式 -o 组合；recursive:false 限 1 层（原 maxdepth 语义反了，一并修，fix #127）
      const exts = ["ts", "js", "py", "go", "rs", "java", "c", "cpp", "h", "hpp"];
      const nameArgs = exts.flatMap((e, i) => (i === 0 ? ["-name", `*.${e}`] : ["-o", "-name", `*.${e}`]));
      const depthArgs = input.recursive === false ? ["-maxdepth", "1"] : [];
      const { stdout } = await execFileAsync(
        "find",
        [resolved, "-type", "f", "(", ...nameArgs, ")", ...depthArgs].filter(Boolean),
        { cwd: ctx.workDir, timeout: 10000, encoding: "utf-8" },
      );

      const files = stdout.trim().split("\n").filter(Boolean);
      let totalLines = 0;
      let codeLines = 0;
      let commentLines = 0;
      let blankLines = 0;
      let totalFiles = 0;

      for (const file of files) {
        try {
          const content = await readFile(file, "utf-8");
          const lines = content.split("\n");
          totalFiles++;
          totalLines += lines.length;

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "") {
              blankLines++;
            } else if (
              trimmed.startsWith("//") ||
              trimmed.startsWith("#") ||
              trimmed.startsWith("/*") ||
              trimmed.startsWith("*")
            ) {
              commentLines++;
            } else {
              codeLines++;
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }

      const lines: string[] = [`代码统计（${resolved}）：`];
      lines.push(`  文件数：${totalFiles}`);
      lines.push(`  总行数：${totalLines}`);
      lines.push(`  代码行：${codeLines}`);
      lines.push(`  注释行：${commentLines}`);
      lines.push(`  空行：${blankLines}`);
      lines.push(`  注释率：${totalLines > 0 ? ((commentLines / totalLines) * 100).toFixed(1) : 0}%`);

      return lines.join("\n");
    } catch (err) {
      return `统计失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 函数列表工具
 */
export const ListFunctionsTool = defineTool({
  name: "ListFunctions",
  description: "列出文件中的函数/方法定义",
  input: z.object({
    file_path: z.string().describe("文件路径"),
    pattern: z.string().optional().describe("过滤模式（正则）"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const functions: Array<{ name: string; line: number; type: string }> = [];

      const ext = extname(resolved);
      const patterns = getFunctionPatterns(ext);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const { regex, type } of patterns) {
          const match = line.match(regex);
          if (match) {
            const name = match[1] || match[2] || "anonymous";

            if (input.pattern && !name.match(input.pattern)) continue;

            functions.push({ name, line: i + 1, type });
          }
        }
      }

      if (functions.length === 0) {
        return "未找到函数定义";
      }

      const lines2: string[] = [`文件 ${input.file_path} 中的函数：`];
      for (const fn of functions) {
        lines2.push(`  ${fn.type.padEnd(10)} L${fn.line}  ${fn.name}`);
      }

      return lines2.join("\n");
    } catch (err) {
      return `分析失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 依赖分析工具
 */
export const DependencyAnalysisTool = defineTool({
  name: "DependencyAnalysis",
  description: "分析文件的导入依赖关系",
  input: z.object({
    file_path: z.string().describe("文件路径"),
    depth: z.number().optional().describe("分析深度（默认 1）"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);
    const depth = input.depth ?? 1;

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const deps = await analyzeDependencies(resolved, depth, ctx.workDir);

      const lines: string[] = [`依赖分析（${input.file_path}）：`];
      lines.push(`  直接依赖：${deps.direct.length}`);
      for (const dep of deps.direct) {
        lines.push(`    ${dep}`);
      }

      if (depth > 1 && deps.indirect.length > 0) {
        lines.push(`  间接依赖：${deps.indirect.length}`);
        for (const dep of deps.indirect) {
          lines.push(`    ${dep}`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `依赖分析失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 复杂度分析工具
 */
export const ComplexityAnalysisTool = defineTool({
  name: "ComplexityAnalysis",
  description: "分析代码复杂度（圈复杂度、嵌套深度等）",
  input: z.object({
    file_path: z.string().describe("文件路径"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const metrics = analyzeComplexity(lines);

      const lines2: string[] = [`复杂度分析（${input.file_path}）：`];
      lines2.push(`  圈复杂度：${metrics.cyclomatic}`);
      lines2.push(`  最大嵌套深度：${metrics.maxNesting}`);
      lines2.push(`  函数数量：${metrics.functionCount}`);
      lines2.push(`  平均函数长度：${metrics.avgFunctionLength.toFixed(0)} 行`);
      lines2.push(`  最长函数：${metrics.longestFunction.name} (${metrics.longestFunction.length} 行)`);

      if (metrics.cyclomatic <= 10) {
        lines2.push(`  评级：简单`);
      } else if (metrics.cyclomatic <= 20) {
        lines2.push(`  评级：中等`);
      } else {
        lines2.push(`  评级：复杂（建议重构）`);
      }

      return lines2.join("\n");
    } catch (err) {
      return `复杂度分析失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

function getFunctionPatterns(ext: string): Array<{ regex: RegExp; type: string }> {
  const patterns: Record<string, Array<{ regex: RegExp; type: string }>> = {
    ".ts": [
      { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: "function" },
      { regex: /(?:public|private|protected|static)\s+(?:async\s+)?(\w+)\s*\(/, type: "method" },
      { regex: /(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: "arrow" },
    ],
    ".js": [
      { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: "function" },
      { regex: /(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: "arrow" },
    ],
    ".py": [
      { regex: /def\s+(\w+)\s*\(/, type: "function" },
      { regex: /class\s+(\w+)/, type: "class" },
    ],
    ".go": [
      { regex: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/, type: "function" },
    ],
    ".rs": [
      { regex: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, type: "function" },
    ],
  };

  return patterns[ext] ?? patterns[".ts"];
}

async function analyzeDependencies(
  filePath: string,
  depth: number,
  workDir: string,
): Promise<{ direct: string[]; indirect: string[] }> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const direct: string[] = [];

  for (const line of lines) {
    // TypeScript/JavaScript
    const tsMatch = line.match(/import\s+.*from\s+['"](.+)['"]/);
    if (tsMatch) {
      direct.push(tsMatch[1]);
      continue;
    }

    // Python
    const pyMatch = line.match(/(?:from\s+(\S+)\s+)?import\s+(\S+)/);
    if (pyMatch) {
      direct.push(pyMatch[1] || pyMatch[2]);
      continue;
    }

    // Go
    const goMatch = line.match(/import\s+['"](.+)['"]/);
    if (goMatch) {
      direct.push(goMatch[1]);
    }
  }

  const indirect: string[] = [];
  if (depth > 1) {
    // 递归分析间接依赖
    for (const dep of direct.slice(0, 5)) { // 限制递归数量
      if (dep.startsWith(".")) {
        // 相对路径依赖；TS ESM 的 ./x.js 实际文件是 x.ts → 回退映射（fix #127）
        const depPath0 = join(filePath, "..", dep);
        const depPath =
          dep.endsWith(".js") && !existsSync(depPath0) ? depPath0.slice(0, -3) + ".ts" : depPath0;
        try {
          const subDeps = await analyzeDependencies(depPath, depth - 1, workDir);
          indirect.push(...subDeps.direct);
        } catch {
          // 跳过无法读取的依赖
        }
      }
    }
  }

  return { direct, indirect };
}

function analyzeComplexity(lines: string[]): {
  cyclomatic: number;
  maxNesting: number;
  functionCount: number;
  avgFunctionLength: number;
  longestFunction: { name: string; length: number };
} {
  let cyclomatic = 1;
  let maxNesting = 0;
  let currentNesting = 0;
  let functionCount = 0;
  let totalFunctionLength = 0;
  let longestFunction = { name: "", length: 0 };
  let currentFunctionName = "";
  let currentFunctionLength = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (
      trimmed.match(/\b(if|else if|elif)\b/) ||
      trimmed.match(/\b(case|when)\b/) ||
      trimmed.match(/\b(for|while|do)\b/) ||
      trimmed.match(/&&|\|\||\?/)
    ) {
      cyclomatic++;
    }

    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    currentNesting += openBraces - closeBraces;
    if (currentNesting > maxNesting) maxNesting = currentNesting;

    const funcMatch = line.match(/(?:function|def|fn)\s+(\w+)/);
    if (funcMatch) {
      if (currentFunctionName && currentFunctionLength > longestFunction.length) {
        longestFunction = { name: currentFunctionName, length: currentFunctionLength };
      }
      currentFunctionName = funcMatch[1];
      currentFunctionLength = 0;
      functionCount++;
    }

    if (functionCount > 0) {
      currentFunctionLength++;
      totalFunctionLength++;
    }
  }

  if (currentFunctionName && currentFunctionLength > longestFunction.length) {
    longestFunction = { name: currentFunctionName, length: currentFunctionLength };
  }

  return {
    cyclomatic,
    maxNesting,
    functionCount,
    avgFunctionLength: functionCount > 0 ? totalFunctionLength / functionCount : 0,
    longestFunction,
  };
}
