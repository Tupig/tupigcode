/**
 * proxy server 集成测试 — mock 后端 + 真实 http
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { createProxyServer } from "../../src/proxy/server";

let backend: http.Server;
let proxy: http.Server;
let backendPort = 0;
let proxyPort = 0;
let lastBackendBody: any = null;
let backendMode: "json" | "sse" = "json";

const listen = (srv: http.Server) =>
  new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
const port = (srv: http.Server) => (srv.address() as any).port;

beforeAll(async () => {
  backend = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastBackendBody = JSON.parse(data || "{}");
      if (backendMode === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const body = JSON.stringify({
          id: "chatcmpl-x",
          choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
      }
    });
  });
  await listen(backend);
  backendPort = port(backend);

  proxy = createProxyServer({
    port: 0,
    backend: `http://127.0.0.1:${backendPort}/v1/chat/completions`,
    authToken: "",
  });
  await new Promise<void>((resolve) => proxy.on("listening", resolve));
  proxyPort = port(proxy);
});

afterAll(async () => {
  await new Promise((r) => proxy.close(() => r(null)));
  await new Promise((r) => backend.close(() => r(null)));
});

describe("proxy server", () => {
  it("GET /health", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("ok");
  });

  it("GET / 元信息", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/`);
    const j = await r.json();
    expect(j.protocols).toContain("/v1/messages");
  });

  it("POST 未知路径 404", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/unknown`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });

  it("无效 JSON → 400", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });

  it("anthropic 非流式：转换后端响应为 messages 格式", async () => {
    backendMode = "json";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    const j = await r.json();
    expect(j.type).toBe("message");
    expect(j.content[0].text).toBe("Hi!");
    expect(j.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
    expect(lastBackendBody.model).toBeTruthy();
    expect(lastBackendBody.stream).toBeUndefined();
  });

  it("anthropic 流式：SSE message_start/delta/message_stop", async () => {
    backendMode = "sse";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta"');
    expect(text).toContain("Hello");
    expect(text).toContain(" world");
    expect(text).toContain("event: message_stop");
    expect(lastBackendBody.stream).toBe(true);
  });

  it("chat/completions：模型覆盖为 backend model + 响应直通", async () => {
    backendMode = "json";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content: "hi" }] }),
    });
    const j = await r.json();
    expect(j.choices[0].message.content).toBe("Hi!");
    expect(lastBackendBody.model).toBe("default_model");
  });

  it("responses 非流式：转换为 response 对象", async () => {
    backendMode = "json";
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
    });
    const j = await r.json();
    expect(j.object).toBe("response");
    expect(j.output[0].content[0].text).toBe("Hi!");
    expect(j.usage.input_tokens).toBe(12);
  });

  it("count_tokens 存根", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hi" }] }),
    });
    expect((await r.json()).input_tokens).toBe(1);
  });

  it("后端 502 → 代理返回错误 JSON", async () => {
    backendMode = "json";
    await new Promise<void>((resolve) => {
      backend.close(() => resolve());
    });
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.type).toBe("error");
    expect(j.error.message).toContain("backend error");
  });
});
