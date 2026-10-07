/**
 * proxy 协议转换 — unified_proxy.py 31 个 pytest 用例平移（B: 语言统一）
 * 蓝本：mlx/test_unified_proxy.py
 */
import { describe, expect, it } from "vitest";

const {
  anthropicToOpenAI,
  openaiToAnthropic,
  responsesToChat,
  chatToResponses,
  textOf,
  BACKEND_MODEL,
} = await import("../../src/proxy/convert");

describe("anthropicToOpenAI", () => {
  const model = "claude-3-5-sonnet-20241022";

  it("simple text message", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello, world!" }] });
    expect(r.model).toBe(BACKEND_MODEL);
    expect(r.max_tokens).toBe(1024);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toEqual({ role: "user", content: "Hello, world!" });
  });

  it("system message 置顶", () => {
    const r = anthropicToOpenAI({
      model, max_tokens: 1024, system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello!" }],
    });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(r.messages[1].role).toBe("user");
  });

  it("multi-turn conversation", () => {
    const r = anthropicToOpenAI({
      model, max_tokens: 1024,
      messages: [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "And 3+3?" },
      ],
    });
    expect(r.messages).toHaveLength(3);
    expect(r.messages.map((m: any) => m.content)).toEqual(["What is 2+2?", "4", "And 3+3?"]);
  });

  it("tool_use → tool_calls", () => {
    const r = anthropicToOpenAI({
      model, max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "tool_use", id: "call_123", name: "get_weather", input: { location: "Tokyo" } }] }],
    });
    expect(r.messages).toHaveLength(1);
    const msg = r.messages[0];
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].id).toBe("call_123");
    expect(msg.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ location: "Tokyo" });
  });

  it("tool_result → tool 消息", () => {
    const r = anthropicToOpenAI({
      model, max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_123", content: "Sunny, 25°C" }] }],
    });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toEqual({ role: "tool", tool_call_id: "call_123", content: "Sunny, 25°C" });
  });

  it("tools 定义 input_schema → parameters", () => {
    const r = anthropicToOpenAI({
      model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "get_weather", description: "Get weather info", input_schema: { type: "object", properties: { location: { type: "string" } } } }],
    });
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].type).toBe("function");
    expect(r.tools[0].function.name).toBe("get_weather");
    expect(r.tools[0].function.description).toBe("Get weather info");
  });

  it("tool_choice auto", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], tool_choice: { type: "auto" } });
    expect(r.tool_choice).toBe("auto");
  });

  it("tool_choice any → required", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], tool_choice: { type: "any" } });
    expect(r.tool_choice).toBe("required");
  });

  it("tool_choice none", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], tool_choice: { type: "none" } });
    expect(r.tool_choice).toBe("none");
  });

  it("tool_choice tool 指定", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], tool_choice: { type: "tool", name: "get_weather" } });
    expect(r.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("temperature / top_p", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], temperature: 0.7, top_p: 0.9 });
    expect(r.temperature).toBe(0.7);
    expect(r.top_p).toBe(0.9);
  });

  it("stop_sequences → stop", () => {
    const r = anthropicToOpenAI({ model, max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], stop_sequences: ["STOP", "END"] });
    expect(r.stop).toEqual(["STOP", "END"]);
  });
});

describe("openaiToAnthropic", () => {
  const body = { model: "claude-3-5-sonnet-20241022" };

  it("simple response", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello! How can I help?" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    const r = openaiToAnthropic(data, body);
    expect(r.type).toBe("message");
    expect(r.role).toBe("assistant");
    expect(r.model).toBe("claude-3-5-sonnet-20241022");
    expect(r.content).toEqual([{ type: "text", text: "Hello! How can I help?" }]);
    expect(r.stop_reason).toBe("end_turn");
  });

  it("tool_calls response → tool_use", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [{ id: "call_456", type: "function", function: { name: "get_weather", arguments: '{"location": "Tokyo"}' } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    const r = openaiToAnthropic(data, body);
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toEqual({ type: "tool_use", id: "call_456", name: "get_weather", input: { location: "Tokyo" } });
  });

  it("length → max_tokens", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: "This is a long response..." }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    };
    expect(openaiToAnthropic(data, body).stop_reason).toBe("max_tokens");
  });

  it("usage 转换", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
    };
    const r = openaiToAnthropic(data, body);
    expect(r.usage).toEqual({ input_tokens: 15, output_tokens: 25 });
  });
});

describe("responsesToChat", () => {
  it("simple text input", () => {
    const r = responsesToChat({ model: "gpt-4o", input: "Hello, world!" });
    expect(r.model).toBe(BACKEND_MODEL);
    expect(r.messages).toEqual([{ role: "user", content: "Hello, world!" }]);
  });

  it("instructions → system", () => {
    const r = responsesToChat({ model: "gpt-4o", input: "Hello!", instructions: "You are a helpful assistant." });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(r.messages[1].role).toBe("user");
  });

  it("list input 拼接", () => {
    const r = responsesToChat({
      model: "gpt-4o",
      input: [
        { type: "message", content: [{ type: "input_text", text: "Hello" }] },
        { type: "message", content: [{ type: "input_text", text: "World" }] },
      ],
    });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("Hello\nWorld");
  });

  it("max_output_tokens → max_tokens", () => {
    const r = responsesToChat({ model: "gpt-4o", input: "Hello", max_output_tokens: 2048 });
    expect(r.max_tokens).toBe(2048);
  });

  it("tools 扁平结构 → function 嵌套", () => {
    const r = responsesToChat({
      model: "gpt-4o", input: "Hello",
      tools: [{ type: "function", name: "get_weather", description: "Get weather info", parameters: { type: "object", properties: { location: { type: "string" } } } }],
    });
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].function.name).toBe("get_weather");
  });

  it("tool_choice 字符串", () => {
    expect(responsesToChat({ model: "gpt-4o", input: "Hello", tool_choice: "auto" }).tool_choice).toBe("auto");
  });

  it("tool_choice 字典", () => {
    expect(responsesToChat({ model: "gpt-4o", input: "Hello", tool_choice: { type: "required" } }).tool_choice).toBe("required");
  });
});

describe("chatToResponses", () => {
  it("simple response", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello! How can I help?" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    const r = chatToResponses(data, { model: "gpt-4o" });
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.output).toHaveLength(1);
    expect(r.output[0].type).toBe("message");
    expect(r.output[0].content[0].text).toBe("Hello! How can I help?");
  });

  it("tool_calls → function_call", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [{ id: "call_456", type: "function", function: { name: "get_weather", arguments: '{"location": "Tokyo"}' } }] },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };
    const r = chatToResponses(data, { model: "gpt-4o" });
    expect(r.status).toBe("completed");
    expect(r.output.length).toBeGreaterThanOrEqual(1);
    expect(r.output.some((o: any) => o.type === "function_call")).toBe(true);
  });

  it("usage 转换", () => {
    const data = {
      id: "chatcmpl-123",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
    };
    const r = chatToResponses(data, { model: "gpt-4o" });
    expect(r.usage.input_tokens).toBe(15);
    expect(r.usage.output_tokens).toBe(25);
  });
});

describe("textOf", () => {
  it("None → 空串", () => expect(textOf(null)).toBe(""));
  it("字符串原样", () => expect(textOf("Hello")).toBe("Hello"));
  it("字符串列表换行连接", () => expect(textOf(["Hello", "World"])).toBe("Hello\nWorld"));
  it("text block 列表", () => expect(textOf([{ type: "text", text: "Hello" }, { type: "text", text: "World" }])).toBe("Hello\nWorld"));
  it("混合内容全包含", () => {
    const r = textOf([{ type: "text", text: "Hello" }, { type: "tool_result", content: "Result" }, "Plain text"]);
    expect(r).toContain("Hello");
    expect(r).toContain("Result");
    expect(r).toContain("Plain text");
  });
});
