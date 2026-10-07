/**
 * E11 多模态图像输入：FileRead 读图 + Anthropic/OpenAI 两协议 tool_result 图像转换。
 * 来源思路：Cline vision（Apache-2.0）；对应 issue #2。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileReadTool } from "../../src/tools/FileRead";
import { anthropicToolResultContent, type ToolUseContext, type CanUseToolFn } from "../../src/engine/Tool";
import { toOpenAIMessages } from "../../src/services/api";

const allow: CanUseToolFn = async () => ({ behavior: "allow" });

// 最小合法 PNG（1x1 透明像素）
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, "base64");

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-input-"));
  ctx = mkCtx(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileRead 图片读取", () => {
  it("png 返回图片 output：base64 + media type，data 为摘要文本", async () => {
    const p = path.join(dir, "shot.png");
    fs.writeFileSync(p, TINY_PNG);
    const result = await FileReadTool.call({ file_path: p }, ctx, allow);
    expect(result.output).toBeDefined();
    expect(result.output!.type).toBe("image");
    const img = result.output as { type: "image"; data: string; mimeType: string };
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(TINY_PNG_BASE64);
    // 助手侧收到可读摘要而非二进制乱码
    const text = result.resultForAssistant ?? String(result.data);
    expect(text).toContain("图片");
    expect(text).toContain("shot.png");
  });

  it("jpg/webp/gif 扩展名识别为对应 media type", async () => {
    const cases: Array<[string, string]> = [
      ["a.jpg", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.webp", "image/webp"],
      ["d.gif", "image/gif"],
    ];
    for (const [name, mime] of cases) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, TINY_PNG);
      const r = await FileReadTool.call({ file_path: p }, mkCtx(dir), allow);
      expect((r.output as any)?.mimeType).toBe(mime);
      // 每次用新 ctx 避免 FILE_UNCHANGED 短路
      ctx = mkCtx(dir);
    }
  });

  it("非图片扩展名仍走文本路径（无 image output）", async () => {
    const p = path.join(dir, "note.ts");
    fs.writeFileSync(p, "export const x = 1;\n");
    const r = await FileReadTool.call({ file_path: p }, ctx, allow);
    expect(r.output).toBeUndefined();
    expect(String(r.data)).toContain("1:");
  });

  it("超过 5MB 的图片拒绝并给中文错误", async () => {
    const p = path.join(dir, "big.png");
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(5 * 1024 * 1024)]);
    fs.writeFileSync(p, big);
    const r = await FileReadTool.call({ file_path: p }, ctx, allow);
    expect(r.output).toBeUndefined();
    expect(String(r.data)).toContain("错误");
    expect(String(r.data)).toContain("图片");
  });

  it("损坏/缺失文件仍报文件未找到", async () => {
    const r = await FileReadTool.call({ file_path: path.join(dir, "missing.png") }, ctx, allow);
    expect(String(r.data)).toContain("文件未找到");
  });
});

describe("anthropicToolResultContent（tool 结果 → Anthropic block）", () => {
  it("带 image output 时 content 为 [text, image] 数组，source 为 base64", () => {
    const out = anthropicToolResultContent(
      { output: { type: "image", data: "QUJD", mimeType: "image/png" } },
      "摘要",
    );
    expect(Array.isArray(out)).toBe(true);
    const arr = out as any[];
    expect(arr[0]).toEqual({ type: "text", text: "摘要" });
    expect(arr[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });

  it("无 image output 时保持字符串（现状零变化）", () => {
    const out = anthropicToolResultContent({}, "普通文本");
    expect(out).toBe("普通文本");
  });
});

describe("toOpenAIMessages（Anthropic 消息 → OpenAI chat 格式）", () => {
  const tools = [] as never[];

  it("文本 tool_result 仍是 role:tool 单消息（现状零变化）", () => {
    const msgs = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "Read", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "文件内容" }] },
    ];
    const oai = toOpenAIMessages(msgs, "sys");
    expect(oai[0]).toEqual({ role: "system", content: "sys" });
    expect(oai[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "t1" }] });
    expect(oai[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "文件内容" });
    expect(tools.length).toBe(0);
  });

  it("带图 tool_result → tool(文本摘要) + 紧随 user(image_url data URI)", () => {
    const msgs = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "Read", input: {} }] },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: [
              { type: "text" as const, text: "图片 shot.png" },
              { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "QUJD" } },
            ],
          },
        ],
      },
    ];
    const oai = toOpenAIMessages(msgs, "sys");
    expect(oai[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "t1" }] });
    // tool 消息只带文本（OpenAI tool content 仅 string）
    expect(oai[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "图片 shot.png" });
    // 紧随的 user 消息带 image_url
    expect(oai[3].role).toBe("user");
    const blocks = oai[3].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  });
});
