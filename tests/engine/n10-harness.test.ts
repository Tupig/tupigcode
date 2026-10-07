/**
 * N10 本地 harness：XML 工具注入（无原生 tool call 兜底）
 */
import { describe, expect, it } from "vitest";
import { parseXmlToolCalls, buildXmlToolSection, resolveHarness } from "../../src/engine/harness";

const tools = [
  { name: "Read", description: "读取文件", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Bash", description: "执行命令", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
] as any[];

describe("parseXmlToolCalls", () => {
  it("解析单个工具块", () => {
    const text = '好的，读取文件：\n<tool name="Read">\n{"file_path":"src/index.ts"}\n</tool>\n完成。';
    const calls = parseXmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("Read");
    expect(calls[0].input).toEqual({ file_path: "src/index.ts" });
  });
  it("解析多个块（按序）", () => {
    const text = '<tool name="Read">{"file_path":"a.ts"}</tool>接着<tool name="Bash">{"command":"ls"}</tool>';
    const calls = parseXmlToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["Read", "Bash"]);
  });
  it("JSON 坏 → 返回 parseError 标记而非抛错", () => {
    const calls = parseXmlToolCalls('<tool name="Read">{not json}</tool>');
    expect(calls).toHaveLength(1);
    expect(calls[0].parseError).toBe(true);
  });
  it("name 属性缺失 → 跳过该块", () => {
    expect(parseXmlToolCalls('<tool>{"a":1}</tool>')).toHaveLength(0);
  });
  it("无块 → 空数组", () => {
    expect(parseXmlToolCalls("普通文本")).toHaveLength(0);
  });
  it("name 前后空白归一", () => {
    const calls = parseXmlToolCalls('<tool name="  Read  " >{"file_path":"x"}</tool>');
    expect(calls[0].name).toBe("Read");
  });
});

describe("buildXmlToolSection", () => {
  it("含每个工具的名称/描述/参数 schema", () => {
    const s = buildXmlToolSection(tools);
    expect(s).toContain('<tool name="Read">');
    expect(s).toContain("读取文件");
    expect(s).toContain("file_path");
    expect(s).toContain("<tool");
  });
  it("空工具列表返回空串", () => {
    expect(buildXmlToolSection([])).toBe("");
  });
});

describe("resolveHarness 模式判定", () => {
  const base = { OPENAI_BASE_URL: "http://x", OPENAI_API_KEY: "k", TUPIG_MODEL: "14b" };
  it("TUPIG_HARNESS=off 强制关闭", () => {
    expect(resolveHarness({ ...base, TUPIG_HARNESS: "off" } as any)).toBe("off");
  });
  it("TUPIG_HARNESS=xml 强制开启", () => {
    expect(resolveHarness({ ...base, TUPIG_HARNESS: "xml" } as any)).toBe("xml");
  });
  it("auto + 本地 openai provider → xml", () => {
    expect(resolveHarness(base as any)).toBe("xml");
  });
  it("auto + anthropic 云端 → native", () => {
    expect(resolveHarness({ ANTHROPIC_API_KEY: "a", TUPIG_MODEL: "claude-x" } as any)).toBe("native");
  });
  it("auto + mock → native", () => {
    expect(resolveHarness({ TUPIG_MOCK: "1" } as any)).toBe("native");
  });
});
