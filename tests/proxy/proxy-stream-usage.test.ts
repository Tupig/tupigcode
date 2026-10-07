/**
 * proxy 流式 usage 透传：include_usage 注入 + Anthropic/Responses/Chat 三协议。对应 issue #4。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { createProxyServer } from "../../src/proxy/server";

type Mode = "sse" | "sse_no_usage" | "json";

let backend: http.Server;
let proxy: http.Server;
let backendPort = 0;
let proxyPort = 0;
let lastBody: any = null;
let mode: Mode = "json";

const listen = (srv: http.Server) =>
  new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
const port = (srv: http.Server) => (srv.address() as any).port;

const USAGE_CHUNK =
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';

beforeAll(async () => {
  backend = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastBody = JSON.parse(data || "{}");
      if (mode === "json") {
        const body = JSON.stringify({
          id: "chatcmpl-x",
          choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      if (mode === "sse") res.write(USAGE_CHUNK);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await listen(backend);
  backendPort = port(backend);

  proxy = createProxyServer({ port: 0, backend: `http://127.0.0.1:${backendPort}/v1/chat/completions`, authToken: "" });
  await new Promise<void>((resolve) => proxy.on("listening", resolve));
  proxyPort = port(proxy);
});

afterAll(async () => {
  await new Promise((r) => proxy.close(() => r(null)));
  await new Promise((r) => backend.close(() => r(null)));
});

const anthropicStream = async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-3", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  return { text: await r.text() };
};

describe("proxy 流式 usage 透传", () => {
  it("流式请求注入 stream_options.include_usage；非流式不注入", async () => {
    mode = "sse";
    await anthropicStream();
    expect(lastBody.stream).toBe(true);
    expect(lastBody.stream_options).toEqual({ include_usage: true });

    mode = "json";
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(lastBody.stream).toBeUndefined();
    expect(lastBody.stream_options).toBeUndefined();
  });

  it("anthropic 流式：message_delta.usage 反映后端 usage", async () => {
    mode = "sse";
    const { text } = await anthropicStream();
    expect(text).toContain('"input_tokens":10');
    expect(text).toContain('"output_tokens":5');
  });

  it("responses 流式：response.completed 带 usage", async () => {
    mode = "sse";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi", stream: true }),
    });
    const text = await r.text();
    expect(text).toContain("response.completed");
    expect(text).toContain('"input_tokens":10');
    expect(text).toContain('"output_tokens":5');
    expect(text).toContain('"total_tokens":15');
  });

  it("chat 直通：后端末 chunk 的 usage 原样透传", async () => {
    mode = "sse";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const text = await r.text();
    expect(text).toContain("prompt_tokens");
    expect(lastBody.stream_options).toEqual({ include_usage: true });
  });

  it("后端不发 usage 时不崩：message_delta usage 为 0 且 message_stop 正常", async () => {
    mode = "sse_no_usage";
    const { text } = await anthropicStream();
    expect(text).toContain('"input_tokens":0');
    expect(text).toContain("event: message_stop");
    expect(text).toContain("Hello");
  });
});
