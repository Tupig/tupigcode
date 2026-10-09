/**
 * tools/MultiEdit.ts — 多组替换原子编辑（issue #55，claude-code#3513）
 *
 * 按序把 edits 应用到内存（定位复用 FileEdit 同源 previewEdit），
 * 任一处不匹配即整体不落盘并精确报「第 N 处」；全部成功才单次写入。
 */
import { MAX_RESULT_CHARS } from "../engine/constants.js";
import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { buildTool, type ToolResult } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";
import { runPostEditLint, formatLintResult } from "./lint.js";
import { writeWithRollback } from "./rollback.js";
import { resolveSandboxPolicy, checkPath } from "../services/sandbox.js";
import { pushTurnOp } from "../engine/diff-review.js";
import { previewEdit } from "./FileEdit.js";

const MultiEditItem = z.object({
  old_string: z.string().describe("要查找并替换的精确文本"),
  new_string: z.string().describe("替换后的新文本"),
  replace_all: z.boolean().optional().describe("该处是否替换所有匹配"),
});

export const MultiEditInput = z.object({
  file_path: z.string().describe("文件路径"),
  edits: z.array(MultiEditItem).min(1).describe("按序应用的多组替换（原子：全部匹配才落盘）"),
});

export const MultiEditTool = buildTool<string>({
  name: "MultiEdit",
  inputSchema: MultiEditInput,
  maxResultSizeChars: MAX_RESULT_CHARS,
  description: () =>
    "对同一文件按序应用多组字符串替换，全部匹配才一次性落盘（原子）；任一处失败整体不生效并报第 N 处。",
  prompt: () =>
    "一次完成同文件多处替换。每处 old_string 应唯一（或配合 replace_all）；失败时文件保持原样，按报错的第 N 处修正后重试。",
  userFacingName: () => "MultiEdit",
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

    // 按序应用到内存；任一失败 → 整体不落盘
    const original = content;
    for (let i = 0; i < input.edits.length; i++) {
      const e = input.edits[i];
      const next = previewEdit(content, {
        old_string: e.old_string,
        new_string: e.new_string,
        replace_all: e.replace_all,
      });
      if (next === null) {
        const msg =
          `错误：第 ${i + 1} 处不匹配（old_string: ${JSON.stringify(e.old_string.slice(0, 120))}）；` +
          `原子语义：本次共 ${input.edits.length} 处编辑，全部未生效。请重新读取文件核对第 ${i + 1} 处后重试。`;
        return { data: msg, resultForAssistant: msg, isError: true };
      }
      content = next;
    }

    if (content === original) {
      return { data: `多处编辑完成，但内容无变化（${input.edits.length} 处）：${resolved}` };
    }

    const lintFn = () => runPostEditLint(context.workDir, resolved);
    const r = await writeWithRollback(resolved, content, lintFn);
    if (!r.ok) {
      const msg = `${r.error}\n${formatLintResult(r.lint!)}\n请修正后重试，本次编辑未生效。`;
      return { data: msg, resultForAssistant: msg, isError: true };
    }

    pushTurnOp({ path: resolved, before: r.prev, after: content });

    const s = await stat(resolved);
    context.readFileState.set(resolved, { mtime: s.mtimeMs });
    const lintMsg = r.lint ? "\n" + formatLintResult(r.lint) : "";
    const result = `已成功编辑 ${resolved}（${input.edits.length} 处替换，原子落盘）${lintMsg}`;
    return { data: result, resultForAssistant: result };
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { type: "tool_result", tool_use_id: toolUseID, content };
  },
});
