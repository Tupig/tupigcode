/**
 * proxy/server.ts — 统一协议代理 HTTP 层（unified_proxy.py 对译）
 * 单端口三协议：/v1/chat/completions、/v1/responses、/v1/messages → 后端 mlx_lm.server
 */
import http from "http";
import { appendWire } from "../utils/wire.js";
import readline from "readline";
import { randomUUID, timingSafeEqual } from "crypto";
import { anthropicToOpenAI, openaiToAnthropic, responsesToChat, chatToResponses, textOf, BACKEND_MODEL, STOP_MAP } from "./convert.js";

export type ProxyOptions = {
  port?: number;
  backend?: string;
  authToken?: string;
  requestTimeoutSec?: number;
};

const hex = (n: number) => randomUUID().replace(/-/g, "").slice(0, n);
const MAX_BODY = 10 * 1024 * 1024;

export function createProxyServer(opts: ProxyOptions = {}): http.Server {
  const port = opts.port ?? Number(process.env.MLX_UNIFIED_PORT || 4100);
  const backend = opts.backend ?? process.env.MLX_BACKEND ?? "http://127.0.0.1:8080/v1/chat/completions";
  const authToken = opts.authToken ?? process.env.MLX_AUTH_TOKEN ?? "";
  const timeoutMs = (opts.requestTimeoutSec ?? Number(process.env.MLX_REQUEST_TIMEOUT || 1800)) * 1000;

  const log = (msg: string) => process.stderr.write(`[unified-proxy] ${msg}\n`);

  const sendJson = (res: http.ServerResponse, code: number, obj: unknown) => {
    const raw = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
    res.end(raw);
  };

  const sendErr = (res: http.ServerResponse, code: number, msg: string, type = "api_error") =>
    sendJson(res, code, { type: "error", error: { type, message: msg } });

  const checkAuth = (req: http.IncomingMessage): boolean => {
    if (!authToken) return true;
    const auth = req.headers.authorization ?? "";
    const m = /^(?:Bearer|Token) (.+)$/.exec(auth);
    if (!m) return false;
    // 恒时比较（fix #123：对齐 gameqa server 的 tokenEqual）
    const a = Buffer.from(m[1]);
    const b = Buffer.from(authToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const readBody = (req: http.IncomingMessage): Promise<any | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch {
          resolve("__invalid_json__");
        }
      });
      req.on("error", () => resolve("__read_error__"));
    });

  /** POST 后端，返回 fetch Response。clientSignal：客户端断开时中止后端请求（fix #123 防空跑烧 token） */
  const callBackend = (payload: any, clientSignal?: AbortSignal) => {
    const ctrl = new AbortController();
    const timer = AbortSignal.timeout(timeoutMs);
    timer.addEventListener("abort", () => ctrl.abort(), { once: true });
    if (clientSignal) {
      if (clientSignal.aborted) ctrl.abort();
      else clientSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return fetch(backend, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  };

  const sse = (res: http.ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const openStream = (res: http.ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  };

  /** 流式转换：OpenAI SSE → Anthropic SSE */
  const relayStreamAnthropic = async (backendResp: Response, res: http.ServerResponse, body: any) => {
    openStream(res);
    const msgId = `msg_${hex(24)}`;
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant",
        model: body.model || BACKEND_MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sse(res, "ping", { type: "ping" });

    let inTokens = 0, outTokens = 0;
    let blockIndex = -1;
    let blockOpen = false;
    let blockKind: "text" | "tool" | null = null;
    const toolSlot = new Map<number, number>();
    let stopReason = "end_turn";

    const closeBlock = () => {
      if (blockOpen) {
        sse(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockOpen = false;
      }
    };

    try {
      for await (const line of sseLines(backendResp)) {
        if (!line.startsWith("data:")) continue;
        const chunkS = line.slice(5).trim();
        if (!chunkS || chunkS === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(chunkS);
        } catch {
          continue;
        }

        const usage = chunk.usage ?? {};
        if (usage.prompt_tokens) inTokens = usage.prompt_tokens;
        if (usage.completion_tokens) outTokens = usage.completion_tokens;

        const choice = (chunk.choices ?? [{}])[0];
        const delta = choice.delta ?? {};
        if (choice.finish_reason) stopReason = STOP_MAP[choice.finish_reason] || "end_turn";

        const piece = delta.content;
        if (piece) {
          if (!(blockOpen && blockKind === "text")) {
            closeBlock();
            blockIndex++;
            sse(res, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
            blockOpen = true;
            blockKind = "text";
          }
          sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: piece } });
        }

        for (const tcall of delta.tool_calls ?? []) {
          const oi = tcall.index ?? 0;
          const fn = tcall.function ?? {};
          if (!toolSlot.has(oi)) {
            closeBlock();
            blockIndex++;
            toolSlot.set(oi, blockIndex);
            sse(res, "content_block_start", {
              type: "content_block_start", index: blockIndex,
              content_block: { type: "tool_use", id: tcall.id || `toolu_${hex(16)}`, name: fn.name || "", input: {} },
            });
            blockOpen = true;
            blockKind = "tool";
          }
          if (fn.arguments) {
            sse(res, "content_block_delta", {
              type: "content_block_delta", index: toolSlot.get(oi)!,
              delta: { type: "input_json_delta", partial_json: fn.arguments },
            });
          }
        }
      }
      closeBlock();
      sse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: inTokens, output_tokens: outTokens },
      });
      sse(res, "message_stop", { type: "message_stop" });
    } finally {
      res.end();
    }
  };

  /** 流式转换：OpenAI SSE → Responses SSE */
  const relayStreamResponses = async (backendResp: Response, res: http.ServerResponse) => {
    openStream(res);
    const responseId = `resp_${hex(24)}`;
    sse(res, "response.created", {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    });

    let contentText = "";
    let inTokens = 0, outTokens = 0;
    try {
      for await (const line of sseLines(backendResp)) {
        if (!line.startsWith("data:")) continue;
        const chunkS = line.slice(5).trim();
        if (!chunkS || chunkS === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(chunkS);
        } catch {
          continue;
        }
        const usage = chunk.usage ?? {};
        if (usage.prompt_tokens) inTokens = usage.prompt_tokens;
        if (usage.completion_tokens) outTokens = usage.completion_tokens;
        const choice = (chunk.choices ?? [{}])[0];
        const piece = (choice.delta ?? {}).content;
        if (piece) {
          contentText += piece;
          sse(res, "response.output_item.delta", { type: "response.output_item.delta", delta: { type: "content_block_delta", text: piece } });
        }
      }
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        item: { type: "message", id: `msg_${hex(16)}`, role: "assistant", content: [{ type: "output_text", text: contentText }], status: "completed" },
      });
      sse(res, "response.completed", {
        type: "response.completed",
        response: {
          id: responseId, object: "response", status: "completed", output: [],
          usage: { input_tokens: inTokens, output_tokens: outTokens, total_tokens: inTokens + outTokens },
        },
      });
      sse(res, "response.completed", {
        type: "response.completed",
        response: { id: responseId, object: "response", status: "completed", output: [] },
      });
    } finally {
      res.end();
    }
  };

  /** 流式直通：后端 SSE → 客户端原样 */
  const relayStreamChat = async (backendResp: Response, res: http.ServerResponse) => {
    openStream(res);
    try {
      for await (const line of sseLines(backendResp)) res.write(line + "\n");
    } finally {
      res.end();
    }
  };

  const relay = async (res: http.ServerResponse, payload: any, originalBody: any, protocol: "chat" | "anthropic" | "responses", wantStream: boolean) => {
    const wireReqId = appendWire({
      kind: "proxy.request",
      provider: "proxy",
      model: payload?.model,
      data: { protocol, inbound: originalBody, outbound: payload },
    });
    // 客户端断开 → 中止后端请求（fix #123）
    const gone = new AbortController();
    const onClientClose = (): void => gone.abort();
    res.on("close", onClientClose);
    try {
      if (wantStream) {
        payload.stream = true;
        // OpenAI 兼容后端默认不在流末 chunk 附 usage，需显式请求
        payload.stream_options = { include_usage: true };
      }
      const backendResp = await callBackend(payload, gone.signal);

      if (wantStream) {
        if (protocol === "anthropic") await relayStreamAnthropic(backendResp, res, originalBody);
        else if (protocol === "responses") await relayStreamResponses(backendResp, res);
        else await relayStreamChat(backendResp, res);
        appendWire({ kind: "proxy.response", provider: "proxy", data: { protocol, stream: true }, req_id: wireReqId ?? undefined });
        return;
      }

      const data: any = await backendResp.json();
      if (protocol === "anthropic") sendJson(res, 200, openaiToAnthropic(data, originalBody));
      else if (protocol === "responses") sendJson(res, 200, chatToResponses(data, originalBody));
      else sendJson(res, 200, data);
      appendWire({ kind: "proxy.response", provider: "proxy", data: { protocol, stream: false, body: data }, req_id: wireReqId ?? undefined });
    } catch (e: any) {
      appendWire({ kind: "proxy.response", provider: "proxy", data: { protocol, error: String(e?.message ?? e) }, req_id: wireReqId ?? undefined });
      const cause = e?.cause ?? {};
      if (e?.name === "TimeoutError") safeErr(res, 502, "backend timeout");
      else if (e?.name === "AbortError" || e?.code === "ECONNREFUSED" || cause.code === "ECONNREFUSED" || String(e?.message ?? e) === "fetch failed")
        safeErr(res, 502, `backend error: ${cause.message ?? e?.message ?? e}`);
      else if (res.headersSent) res.end();
      else safeErr(res, 500, String(e));
      log(`proxy error: ${e?.message ?? e}`);
    } finally {
      res.off("close", onClientClose);
    }
  };

  const safeErr = (res: http.ServerResponse, code: number, msg: string) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendErr(res, code, msg);
  };

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";

    if (req.method === "GET") {
      if (path === "/health" || path === "/v1/health") return sendJson(res, 200, { status: "ok", backend });
      if (path === "/" || path === "") {
        return sendJson(res, 200, { service: "mlx-unified-proxy", protocols: ["/v1/chat/completions", "/v1/responses", "/v1/messages"], backend });
      }
      return sendErr(res, 404, "not found", "not_found_error");
    }

    if (req.method !== "POST") return sendErr(res, 404, "not found", "not_found_error");

    if (!checkAuth(req)) return sendJson(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });

    const isAnthropic = "anthropic-version" in req.headers;
    const isResponses = path.endsWith("/responses");

    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, { error: { message: "Request body too large", type: "invalid_request_error" } });
    if (body === "__invalid_json__") return sendJson(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } });
    if (body === "__read_error__") return sendJson(res, 500, { error: { message: "Failed to read request body", type: "api_error" } });

    if (path.endsWith("/messages/count_tokens")) return sendJson(res, 200, { input_tokens: 1 });

    if (isResponses || (path === "/v1/responses" && !isAnthropic)) {
      log(`responses: stream=${!!body.stream}`);
      return relay(res, responsesToChat(body), body, "responses", !!body.stream);
    }
    if (isAnthropic || path.endsWith("/messages")) {
      const approx = (body.messages ?? []).reduce((n: number, m: any) => n + textOf(m.content).length, 0);
      log(`anthropic: messages=${(body.messages ?? []).length} tools=${(body.tools ?? []).length} stream=${!!body.stream} approx_chars=${approx}`);
      return relay(res, anthropicToOpenAI(body), body, "anthropic", !!body.stream);
    }
    if (path.endsWith("/chat/completions")) {
      const payload = { ...body, model: BACKEND_MODEL };
      return relay(res, payload, body, "chat", !!body.stream);
    }
    return sendErr(res, 404, "not found", "not_found_error");
  });

  server.listen(port, "127.0.0.1", () => {
    log(`listening on 127.0.0.1:${port} → ${backend}`);
    log("protocols: chat/completions, responses, messages");
    if (!authToken) log("警告：未设 authToken，代理完全放行——仅限本机使用（fix #123 提示）");
  });
  return server;
}

/** 按行异步迭代后端 SSE 流 */
async function* sseLines(resp: Response): AsyncGenerator<string> {
  const body = resp.body;
  if (!body) return;
  const rl = readline.createInterface({ input: (await import("stream")).Readable.fromWeb(body as any), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = createProxyServer();
  const shutdown = () => {
    process.stderr.write("[unified-proxy] shutting down...\n");
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
