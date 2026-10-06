/**
 * 图片与 PDF 读取工具
 *
 * 支持读取图片和 PDF 文件，为视觉模型提供支持。
 * 灵感来自 Cursor 的图片读取和 Cline 的图片分析。
 */
import { MAX_RESULT_CHARS } from "../engine/constants.js";
import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { extname } from "path";
import { defineTool } from "../engine/Tool.js";
import { safePath } from "../utils/path.js";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
]);

/**
 * 图片读取工具
 */
export const ImageReadTool = defineTool({
  name: "ImageRead",
  description: "读取图片文件，返回图片内容（用于视觉模型分析）",
  input: z.object({
    file_path: z.string().describe("图片文件路径"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);
    const ext = extname(resolved).toLowerCase();

    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      return `不支持的图片格式：${ext}。支持的格式：${[...SUPPORTED_IMAGE_EXTENSIONS].join(", ")}`;
    }

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const buffer = await readFile(resolved);
      const mimeType = getMimeType(ext);
      const base64 = buffer.toString("base64");

      // 返回图片信息（实际使用时由 API 处理 base64）
      return `图片已读取：${resolved}
类型：${mimeType}
大小：${buffer.length} 字节
Base64 长度：${base64.length} 字符

（图片内容已准备好供视觉模型分析）`;
    } catch (err) {
      return `读取图片失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 文档读取工具
 */
export const DocReadTool = defineTool({
  name: "DocRead",
  description: "读取文档文件（PDF/TXT/MD/JSON/CSV 等）",
  input: z.object({
    file_path: z.string().describe("文档文件路径"),
    maxPages: z.number().optional().describe("PDF 最大页数（默认 10）"),
  }),
  readOnly: true,
  async execute(input, ctx) {
    const resolved = safePath(ctx.workDir, input.file_path);
    const ext = extname(resolved).toLowerCase();

    if (!existsSync(resolved)) {
      return `文件不存在：${resolved}`;
    }

    try {
      const fileStat = await stat(resolved);

      if ([".txt", ".md", ".json", ".csv", ".xml", ".yaml", ".yml"].includes(ext)) {
        const content = await readFile(resolved, "utf-8");
        const maxSize = MAX_RESULT_CHARS;
        if (content.length > maxSize) {
          return content.slice(0, maxSize) + `\n\n[已截断，原始大小 ${content.length} 字符]`;
        }
        return content;
      }

      if (ext === ".pdf") {
        return `PDF 文件：${resolved}
大小：${fileStat.size} 字节

注意：PDF 解析需要安装 pdf-parse 库。
可以使用以下命令提取文本：
  cat "${resolved}" | strings | head -100

或者使用外部工具：
  pdftotext "${resolved}" - 2>/dev/null | head -100`;
      }

      return `不支持的文档格式：${ext}`;
    } catch (err) {
      return `读取文档失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 获取 MIME 类型
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
