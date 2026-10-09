/**
 * Web 搜索与抓取工具
 *
 * 提供 Web 搜索和页面抓取能力。
 * 灵感来自 Continue 的 @Web 上下文和 Cline 的 WebSearch。
 */
import { z } from "zod";
import { defineTool } from "../engine/Tool.js";
import { truncationHint } from "../utils/truncation-hint.js";

/**
 * Web 搜索工具
 */
export const WebSearchTool = defineTool({
  name: "WebSearch",
  description: "搜索互联网获取最新信息",
  input: z.object({
    query: z.string().describe("搜索查询"),
    numResults: z.number().optional().describe("返回结果数量（默认 5）"),
  }),
  readOnly: true,
  async execute(input) {
    const numResults = input.numResults ?? 5;

    try {
      // 使用 DuckDuckGo 搜索（无需 API Key）
      const encoded = encodeURIComponent(input.query);
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encoded}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TupigCode/1.0)",
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      const html = await response.text();
      const results = parseSearchResults(html, numResults);

      if (results.length === 0) {
        return "未找到相关结果";
      }

      const lines: string[] = [`搜索「${input.query}」的结果：`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`\n${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) {
          lines.push(`   ${r.snippet}`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `搜索失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * Web 抓取工具
 */
export const WebFetchTool = defineTool({
  name: "WebFetch",
  description: "抓取网页内容",
  input: z.object({
    url: z.string().url().describe("要抓取的 URL"),
    format: z.enum(["text", "markdown"]).optional().describe("输出格式（默认 text）"),
    maxLength: z.number().optional().describe("最大字符数（默认 10000）"),
    offset: z.number().optional().describe("起始字符偏移（截断后按此续取，默认 0）"),
  }),
  readOnly: true,
  async execute(input) {
    // 非正/非法回退默认（fix #71：0/负数曾产出空 window 原地续取）
    const maxLength =
      typeof input.maxLength === "number" && Number.isFinite(input.maxLength) && input.maxLength > 0
        ? Math.floor(input.maxLength)
        : 10000;
    const offset = Math.max(0, Math.floor(input.offset ?? 0));

    try {
      const response = await fetch(input.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TupigCode/1.0)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return `请求失败：${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return `不支持的内容类型：${contentType}`;
      }

      let content = await response.text();

          if (contentType.includes("text/html")) {
        content = htmlToText(content);
      }

      // 字符窗口 + 截断续取交接（issue #56）
      if (offset >= content.length) {
        return `未找到更多内容（offset=${offset}，共 ${content.length} 字符）`;
      }
      const window = content.slice(offset, offset + maxLength);
      if (content.length > offset + window.length) {
        return window + "\n\n" + truncationHint({
          total: content.length,
          shown: window.length,
          offset,
          limit: maxLength,
          unit: "字符",
          limitParam: "maxLength",
        });
      }
      return window;
    } catch (err) {
      return `抓取失败：${err instanceof Error ? err.message : err}`;
    }
  },
});

/**
 * 解析 DuckDuckGo 搜索结果
 */
function parseSearchResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    const url = decodeUrl(match[1]);
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/**
 * 解码 DuckDuckGo URL
 */
function decodeUrl(encoded: string): string {
  const match = encoded.match(/uddg=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return encoded;
}

/**
 * 移除 HTML 标签
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * HTML 转纯文本
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");

  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return text;
}
