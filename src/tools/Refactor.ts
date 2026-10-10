/**
 * 重构工具集
 *
 * 提供代码重构能力：重命名符号、提取函数、移动文件等。
 * 灵感来自 IDE 的重构功能和 Aider 的多格式编辑。
 */
import { z } from "zod";
import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { defineTool } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";

const execFileAsync = promisify(execFile);

/**
 * 重命名符号工具
 *
 * 在整个项目中重命名变量、函数、类等符号。
 */
export const RenameSymbolTool = defineTool({
  name: "RenameSymbol",
  description: "在整个项目中重命名变量、函数、类等符号",
  input: z.object({
    oldName: z.string().describe("旧符号名"),
    newName: z.string().describe("新符号名"),
    fileType: z.enum(["auto", "ts", "js", "py", "go", "rs"]).optional().describe("文件类型（默认 auto）"),
    dryRun: z.boolean().optional().describe("仅预览变更，不实际修改"),
  }),
  destructive: true,
  async execute(input, ctx) {
    const fileType = input.fileType ?? "auto";
    const dryRun = input.dryRun ?? false;

    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*." + getFileExtension(fileType), input.oldName, ctx.workDir],
        { cwd: ctx.workDir, timeout: 10000, encoding: "utf-8" },
      );

      const matches = stdout.trim().split("\n").filter(Boolean);
      if (matches.length === 0) {
        return `未找到符号「${input.oldName}」的引用`;
      }

      const lines: string[] = [];
      let changedFiles = 0;
      let changedCount = 0;

      for (const match of matches) {
        const [filePath, ...rest] = match.split(":");
        const lineNum = rest[0];
        const content = rest.slice(1).join(":");

        // 跳过 node_modules、.git 等目录
        if (filePath.includes("node_modules") || filePath.includes(".git")) continue;

        lines.push(`${filePath}:${lineNum}: ${content.trim()}`);
        changedFiles++;
      }

      if (dryRun) {
        return `预览重命名「${input.oldName}」→「${input.newName}」：\n\n${lines.join("\n")}\n\n共 ${lines.length} 处引用，涉及 ${changedFiles} 个文件`;
      }

      for (const match of matches) {
        const [filePath] = match.split(":");
        if (filePath.includes("node_modules") || filePath.includes(".git")) continue;

        const content = await readFile(filePath, "utf-8");
        const newContent = content.replace(new RegExp(escapeRegex(input.oldName), "g"), input.newName);

        if (content !== newContent) {
          await writeFile(filePath, newContent, "utf-8");
          changedCount++;
        }
      }

      return `已重命名「${input.oldName}」→「${input.newName}」\n修改了 ${changedCount} 个文件`;
    } catch (err) {
      // grep 无匹配 exit 1 → 设计文案「未找到符号」（fix #127）
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: number }).code === 1) {
        return `未找到符号「${input.oldName}」的引用`;
      }
      return `重命名失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 提取函数工具
 *
 * 将选中的代码提取为独立函数。
 */
export const ExtractFunctionTool = defineTool({
  name: "ExtractFunction",
  description: "将选中的代码提取为独立函数",
  input: z.object({
    file_path: z.string().describe("文件路径"),
    startLine: z.number().describe("起始行号（从 1 开始）"),
    endLine: z.number().describe("结束行号（从 1 开始）"),
    functionName: z.string().describe("新函数名"),
    params: z.array(z.string()).optional().describe("函数参数列表"),
  }),
  destructive: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");

      if (input.startLine < 1 || input.startLine > lines.length) {
        return `起始行号无效：${input.startLine}`;
      }
      if (input.endLine < input.startLine || input.endLine > lines.length) {
        return `结束行号无效：${input.endLine}`;
      }

      const selectedLines = lines.slice(input.startLine - 1, input.endLine);

      const indent = selectedLines[0].match(/^(\s*)/)?.[1] ?? "";

      const params = input.params?.join(", ") ?? "";
      const functionCode = [
        `${indent}function ${input.functionName}(${params}) {`,
        ...selectedLines.map((l) => l),
        `${indent}}`,
        "",
      ].join("\n");

      const callCode = `${indent}${input.functionName}(${params});`;
      const newLines = [
        ...lines.slice(0, input.startLine - 1),
        callCode,
        ...lines.slice(input.endLine),
      ];

      const newContent = newLines.join("\n");
      const insertPos = findInsertPosition(newContent);
      const finalContent =
        newContent.slice(0, insertPos) +
        functionCode +
        newContent.slice(insertPos);

      await writeFile(resolved, finalContent, "utf-8");

      return `已提取函数「${input.functionName}」\n行 ${input.startLine}-${input.endLine} → 函数调用\n函数定义已添加到文件顶部`;
    } catch (err) {
      return `提取函数失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 移动文件工具
 */
export const MoveFileTool = defineTool({
  name: "MoveFile",
  description: "移动/重命名文件，自动更新导入引用",
  input: z.object({
    source: z.string().describe("源文件路径"),
    destination: z.string().describe("目标文件路径"),
    updateImports: z.boolean().optional().describe("自动更新导入引用（默认 true）"),
  }),
  destructive: true,
  async execute(input, ctx) {
    const src = safePath(ctx.workDir, input.source);
    const dest = safePath(ctx.workDir, input.destination);
    const updateImports = input.updateImports ?? true;

    if (!existsSync(src)) {
      return `源文件不存在：${src}`;
    }

    if (existsSync(dest)) {
      return `目标文件已存在：${dest}`;
    }

    try {
      await rename(src, dest);

      const lines: string[] = [`已移动 ${input.source} → ${input.destination}`];

      if (updateImports) {
        const updated = await updateImportReferences(ctx.workDir, src, dest);
        if (updated > 0) {
          lines.push(`已更新 ${updated} 个文件的导入引用`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `移动文件失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 内联变量工具
 */
export const InlineVariableTool = defineTool({
  name: "InlineVariable",
  description: "将变量的所有引用替换为其值，然后删除变量声明",
  input: z.object({
    file_path: z.string().describe("文件路径"),
    variableName: z.string().describe("变量名"),
  }),
  destructive: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");

      let declarationLine = -1;
      let variableValue = "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(
          new RegExp(`(?:const|let|var)\\s+${escapeRegex(input.variableName)}\\s*=\\s*(.+);`),
        );
        if (match) {
          declarationLine = i;
          variableValue = match[1].trim();
          break;
        }
      }

      if (declarationLine === -1) {
        return `未找到变量「${input.variableName}」的声明`;
      }

      let replacedCount = 0;
      const newLines = lines.map((line, i) => {
        if (i === declarationLine) return null; // 删除声明行

        const newLine = line.replace(
          new RegExp(escapeRegex(input.variableName), "g"),
          `(${variableValue})`,
        );

        if (newLine !== line) replacedCount++;
        return newLine;
      });

      const newContent = newLines.filter((l) => l !== null).join("\n");
      await writeFile(resolved, newContent, "utf-8");

      return `已内联变量「${input.variableName}」\n替换了 ${replacedCount} 处引用\n值：${variableValue}`;
    } catch (err) {
      return `内联变量失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 提取常量工具
 */
export const ExtractConstantTool = defineTool({
  name: "ExtractConstant",
  description: "将魔法数字或字符串提取为命名常量",
  input: z.object({
    file_path: z.string().describe("文件路径"),
    value: z.string().describe("要提取的值"),
    constantName: z.string().describe("常量名"),
  }),
  destructive: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const content = await readFile(resolved, "utf-8");

      const constantDecl = `const ${input.constantName} = ${input.value};\n`;
      // 先替换正文再前插声明，避免声明行自身被替换成自引用（fix #127）
      const finalContent = constantDecl + content.replace(new RegExp(escapeRegex(input.value), "g"), input.constantName);

      await writeFile(resolved, finalContent, "utf-8");

      return `已提取常量「${input.constantName}」\n值：${input.value}`;
    } catch (err) {
      return `提取常量失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

function getFileExtension(type: string): string {
  const extensions: Record<string, string> = {
    ts: "ts",
    js: "js",
    py: "py",
    go: "go",
    rs: "rs",
    auto: "ts",
  };
  return extensions[type] ?? "ts";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findInsertPosition(content: string): number {
  const lines = content.split("\n");
  let lastImport = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^import\s/) || lines[i].match(/^from\s.*import/)) {
      lastImport = i;
    }
  }

  if (lastImport === -1) return 0;

  let pos = 0;
  for (let i = 0; i <= lastImport; i++) {
    pos += lines[i].length + 1; // +1 for newline
  }
  return pos;
}

async function updateImportReferences(
  workDir: string,
  oldPath: string,
  newPath: string,
): Promise<number> {
  const oldRelative = relative(workDir, oldPath);
  const newRelative = relative(workDir, newPath);
  let updated = 0;

  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-rn", oldRelative, workDir],
      { cwd: workDir, timeout: 10000, encoding: "utf-8" },
    );

    const matches = stdout.trim().split("\n").filter(Boolean);
    for (const match of matches) {
      const [filePath] = match.split(":");
      if (filePath.includes("node_modules") || filePath.includes(".git")) continue;

      const content = await readFile(filePath, "utf-8");
      const newContent = content.replace(
        new RegExp(escapeRegex(oldRelative), "g"),
        newRelative,
      );

      if (content !== newContent) {
        await writeFile(filePath, newContent, "utf-8");
        updated++;
      }
    }
  } catch {
    // grep 未找到匹配时会抛出错误
  }

  return updated;
}
