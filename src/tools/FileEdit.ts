/**
 * tools/FileEdit.ts — 文件编辑工具
 */
import { MAX_RESULT_CHARS } from "../engine/constants.js";
import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { buildTool, type ToolResult } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";
import { runPostEditLint, formatLintResult } from "./lint.js";
import { formatNoMatchFeedback, fuzzyLocate } from "./similar.js";
import { writeWithRollback } from "./rollback.js";
import { resolveSandboxPolicy, checkPath } from "../services/sandbox.js";
import { pushTurnOp } from "../engine/diff-review.js";

export const FileEditInput = z.object({
  file_path: z.string().describe("文件路径"),
  old_string: z.string().describe("要查找并替换的精确文本"),
  new_string: z.string().describe("替换后的新文本"),
  replace_all: z.boolean().optional().describe("替换所有匹配项"),
});

function findActualString(content: string, oldString: string): number {
  const idx = content.indexOf(oldString);
  if (idx !== -1) return idx;
  const normalize = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  return normalize(content).indexOf(normalize(oldString));
}

/**
 * 审批 diff 预览（issue #54）：与 call 同源的定位逻辑（精确 → 模糊单命中 →
 * replace_all）。多处匹配/不匹配等会被执行拒绝的场景返回 null，调用方回退 JSON。
 */
export function previewEdit(
  content: string,
  input: { old_string: string; new_string: string; replace_all?: boolean },
): string | null {
  const idx = findActualString(content, input.old_string);
  if (idx === -1) {
    const fuzzy = fuzzyLocate(content, input.old_string);
    if (fuzzy.length === 1 && !input.replace_all) {
      const { start, end } = fuzzy[0];
      return content.slice(0, start) + input.new_string + content.slice(end);
    }
    return null;
  }
  if (input.replace_all) return content.split(input.old_string).join(input.new_string);
  const secondIdx = findActualString(content.slice(idx + input.old_string.length), input.old_string);
  if (secondIdx !== -1) return null;
  return content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
}

export const FileEditTool = buildTool<string>({
  name: "Edit",
  inputSchema: FileEditInput,
  maxResultSizeChars: MAX_RESULT_CHARS,
  description: () => "通过替换文本来编辑文件。优先精确匹配，失败时自动容忍缩进/空白差异做模糊回退。",
  prompt: () => "执行字符串替换。old_string 应在文件中恰好出现一次（精确或唯一模糊命中），除非设置 replace_all。",
  userFacingName: () => "Edit",
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,

  async checkPermissions(input, ctx) {
    const policy = resolveSandboxPolicy(ctx.workDir);
    if (checkPath(policy, safePath(ctx.workDir, (input as any).file_path), "write") === "deny") {
      return { behavior: "deny", message: "沙箱策略：目标路径不可写（仅允许工作目录与 TUPIG_SANDBOX_WRITE 白名单）" } as any;
    }
    return { behavior: "allow", updatedInput: input };
  },

  async call(input, context): Promise<ToolResult<string>> {
    const resolved = safePath(context.workDir, input.file_path);

    let content: string;
    try {
      content = await readFile(resolved, "utf-8");
    } catch {
      return { data: `错误：文件未找到：${resolved}`, isError: true };
    }

    const cached = context.readFileState.get(resolved);
    if (cached) {
      try {
        const s = await stat(resolved);
        if (s.mtimeMs !== cached.mtime && cached.mtime !== 0) {
          return { data: "错误：文件在上次读取后已被修改，请重新读取后再编辑。", isError: true };
        }
      } catch {}
    }

    const idx = findActualString(content, input.old_string);
    if (idx === -1) {
      const fuzzy = fuzzyLocate(content, input.old_string);
      if (fuzzy.length === 1 && !input.replace_all) {
        const { start, end } = fuzzy[0];
        const lintFn = () => runPostEditLint(context.workDir, resolved);
        const next = content.slice(0, start) + input.new_string + content.slice(end);
        const fr = await writeWithRollback(resolved, next, lintFn);
        if (!fr.ok) {
          const msg = `${fr.error}\n${formatLintResult(fr.lint!)}\n请修正后重试，本次编辑未生效。`;
          return { data: msg, resultForAssistant: msg, isError: true };
        }
        pushTurnOp({ path: resolved, before: fr.prev, after: next });

        const s = await stat(resolved);
        context.readFileState.set(resolved, { mtime: s.mtimeMs });
        const lintMsg = fr.lint ? "\n" + formatLintResult(fr.lint) : "";
        const result = `已成功编辑 ${resolved}（模糊匹配：已容忍缩进/空白差异）${lintMsg}`;
        return { data: result, resultForAssistant: result };
      }
      if (fuzzy.length > 1) {
        const msg = `错误：old_string 精确匹配失败，且有 ${fuzzy.length} 处模糊相似位置，无法确定目标。请重新读取文件并提供更多上下文（或更精确的 old_string）。`;
        return { data: msg, resultForAssistant: msg, isError: true };
      }
      const fb = formatNoMatchFeedback(content, input.old_string, resolved);
      return { data: fb, resultForAssistant: fb, isError: true };
    }

    if (!input.replace_all) {
      const secondIdx = findActualString(content.slice(idx + input.old_string.length), input.old_string);
      if (secondIdx !== -1) {
        return { data: "错误：old_string 匹配了多次。请使用 replace_all 或提供更多上下文。", isError: true };
      }
    }

    const lintFn = () => runPostEditLint(context.workDir, resolved);

    if (input.replace_all) {
      const count = content.split(input.old_string).length - 1;
      const next = content.split(input.old_string).join(input.new_string);
      const r = await writeWithRollback(resolved, next, lintFn);
      if (!r.ok) {
        const msg = `${r.error}\n${formatLintResult(r.lint!)}\n请修正后重试，本次替换未生效（${count} 处待替换）`;
        return { data: msg, resultForAssistant: msg, isError: true };
      }
      pushTurnOp({ path: resolved, before: r.prev, after: next });
      const s = await stat(resolved);
      context.readFileState.set(resolved, { mtime: s.mtimeMs });
      const lintMsg = r.lint ? "\n" + formatLintResult(r.lint) : "";
      const result = `已在 ${resolved} 中替换 ${count} 处${lintMsg}`;
      return { data: result, resultForAssistant: result };
    }

    const next = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
    const r = await writeWithRollback(resolved, next, lintFn);
    if (!r.ok) {
      const msg = `${r.error}\n${formatLintResult(r.lint!)}\n请修正后重试，本次编辑未生效。`;
      return { data: msg, resultForAssistant: msg, isError: true };
    }
    pushTurnOp({ path: resolved, before: r.prev, after: next });

    const s = await stat(resolved);
    context.readFileState.set(resolved, { mtime: s.mtimeMs });
    const lintMsg = r.lint ? "\n" + formatLintResult(r.lint) : "";
    const result = `已成功编辑 ${resolved}${lintMsg}`;
    return { data: result, resultForAssistant: result };
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: "tool_result", tool_use_id: toolUseID, content };
  },
});
