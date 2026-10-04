/**
 * services/api.ts — API 客户端
 * 支持三种模式：Anthropic / OpenAI 兼容 / Mock
 */
import Anthropic from "@anthropic-ai/sdk";
import { MAX_RETRIES, API_FETCH_TIMEOUT_MS, DEFAULT_MODEL, resolveStreamIdleTimeoutMs } from "../engine/constants.js";
import { wireEnabled, appendWire } from "../utils/wire.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; inputJsonDelta: string }
  | { type: "tool_use_stop"; id: string }
  | { type: "message_start"; message: Anthropic.Message }
  | { type: "message_delta"; stopReason: string | null; usage: Anthropic.Usage }
  | { type: "message_stop" };

export type ApiClient = {
  type: "anthropic" | "openai" | "mock";
  anthropic?: Anthropic;
};

export type ProviderKind = "anthropic" | "openai" | "mock";

/** system 可为纯字符串或带 cache_control 的分层 blocks（issue #45 prompt cache） */
export type SystemInput = string | Anthropic.TextBlockParam[];

/** system 展平为字符串（OpenAI/mock 用；blocks 不外泄 cache_control） */
export function systemText(system: SystemInput): string {
  if (typeof system === "string") return system;
  return system.map((b) => b.text ?? "").join("\n\n");
}

/**
 * tools 末项打 cache_control 断点（仅 anthropic 请求用，issue #45）。
 * 每次请求重新构造 toolDefs，断点不会跨轮累积（Anthropic 上限 4 个）。
 */
export function withToolsCacheBreakpoint(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : { ...t },
  );
}

/**
 * 末条消息打 cache_control 断点，并清理历史残留断点（防止跨轮累积超限）。
 * 返回新数组，不改原 messages（issue #45）。
 */
export function withMessageCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  // 断点必须打在 content block 级（fix #63）：MessageParam 无顶层 cache_control 字段
  const cleaned = messages.map((m) => {
    const { cache_control: _topStale, ...rest } = m as Anthropic.MessageParam & {
      cache_control?: unknown;
    };
    const blocks = Array.isArray(rest.content)
      ? rest.content.map((b) => {
          if (b === null || typeof b !== "object") return b;
          const { cache_control: _stale, ...blockRest } = b as unknown as Record<
            string,
            unknown
          > & { cache_control?: unknown };
          return blockRest;
        })
      : rest.content;
    return { ...rest, content: blocks } as Anthropic.MessageParam;
  });
  const last = cleaned[cleaned.length - 1];
  if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.map((b, i) =>
      i === last.content.length - 1 && b !== null && typeof b === "object"
        ? ({ ...b, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam)
        : b,
    );
    cleaned[cleaned.length - 1] = { ...last, content: blocks } as Anthropic.MessageParam;
  } else if (typeof last.content === "string") {
    cleaned[cleaned.length - 1] = {
      ...last,
      content: [
        { type: "text", text: last.content, cache_control: { type: "ephemeral" } },
      ],
    } as Anthropic.MessageParam;
  }
  return cleaned;
}

/**
 * 解析 provider 优先级：TUPIG_MOCK > TUPIG_PROVIDER(显式) > OpenAI env > Anthropic env
 * 配置缺失时抛中文错误（由调用方决定 exit 或传递）
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  if (env.TUPIG_MOCK === "1") return "mock";
  const explicit = env.TUPIG_PROVIDER;
  if (explicit) {
    if (explicit !== "openai" && explicit !== "anthropic" && explicit !== "mock")
      throw new Error(`TUPIG_PROVIDER 非法：${explicit}（可选 openai / anthropic / mock）`);
    if (explicit === "openai" && (!env.OPENAI_BASE_URL || !env.OPENAI_API_KEY))
      throw new Error("TUPIG_PROVIDER=openai 需要同时设置 OPENAI_BASE_URL 和 OPENAI_API_KEY");
    if (explicit === "anthropic" && !env.ANTHROPIC_API_KEY)
      throw new Error("TUPIG_PROVIDER=anthropic 需要设置 ANTHROPIC_API_KEY");
    return explicit;
  }
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  throw new Error("请设置 ANTHROPIC_API_KEY、OPENAI_BASE_URL+OPENAI_API_KEY、TUPIG_PROVIDER 或 TUPIG_MOCK=1");
}

/** baseURL 归一 → 统一 chat/completions 地址（避免 /v1/v1 重复） */
export function chatUrl(base: string): string {
  let b = base.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(b) && !/\/v\d+\//.test(b)) b += "/v1";
  return `${b}/chat/completions`;
}

export function resolveModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TUPIG_MODEL || DEFAULT_MODEL;
}

export function createClient(): ApiClient {
  let kind: ProviderKind;
  try {
    kind = resolveProvider();
  } catch (e) {
    console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (kind === "mock") return { type: "mock" };
  if (kind === "openai") return { type: "openai" };
  return { type: "anthropic", anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }) };
}

function mockUsage(): Anthropic.Usage {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  } as any;
}

function mockResponse(messages: Anthropic.MessageParam[]): Anthropic.Message {
  const lastMsg = messages[messages.length - 1];
  const ut =
    typeof lastMsg?.content === "string"
      ? lastMsg.content
      : Array.isArray(lastMsg?.content)
        ? ((lastMsg!.content as any[]).find((b: any) => b.type === "text") as any)?.text || ""
        : "";
  const hasTR =
    Array.isArray(lastMsg?.content) &&
    (lastMsg!.content as any[]).some((b: any) => b.type === "tool_result");

  if (hasTR) {
    return {
      id: `msg_${Date.now()}`, type: "message", role: "assistant",
      content: [{ type: "text", text: "\n\n已完成。还有其他需要吗？" }],
      model: "mock", stop_reason: "end_turn", stop_sequence: null, usage: mockUsage(),
    } as any;
  }

  const t = ut.toLowerCase(), n = Date.now();

  if (t.includes("压缩")) {
    const fm = ut.match(/压缩\s*(?:焦点|focus)[：:]?\s*(.+)/);
    return {
      id: `msg_${n}`, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "CompactContext", input: { focus: fm?.[1] } }],
      model: "mock", stop_reason: "tool_use", stop_sequence: null, usage: mockUsage(),
    } as any;
  }
  if (t.includes("读") || t.includes("read") || t.includes("看看")) {
    const fp = ut.match(/(?:读|read|看看)\s+(.+)/)?.[1] || "src/index.ts";
    return {
      id: `msg_${n}`, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "Read", input: { file_path: fp } }],
      model: "mock", stop_reason: "tool_use", stop_sequence: null, usage: mockUsage(),
    } as any;
  }
  if (t.includes("列") || t.includes("list") || t.includes("有什么")) {
    return {
      id: `msg_${n}`, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "Glob", input: { pattern: "src/**/*.ts", path: "." } }],
      model: "mock", stop_reason: "tool_use", stop_sequence: null, usage: mockUsage(),
    } as any;
  }
  if (t.includes("运行") || t.includes("run") || t.includes("执行")) {
    const cmd = ut.match(/(?:运行|run|执行)\s+(.+)/)?.[1] || "echo hello";
    return {
      id: `msg_${n}`, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: cmd } }],
      model: "mock", stop_reason: "tool_use", stop_sequence: null, usage: mockUsage(),
    } as any;
  }
  if (t.includes("搜索") || t.includes("search") || t.includes("grep")) {
    const p = ut.match(/(?:搜索|search|grep)\s+(.+)/)?.[1] || "TODO";
    return {
      id: `msg_${n}`, type: "message", role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "Grep", input: { pattern: p, path: "src" } }],
      model: "mock", stop_reason: "tool_use", stop_sequence: null, usage: mockUsage(),
    } as any;
  }
  return {
    id: `msg_${n}`, type: "message", role: "assistant",
    content: [{ type: "text", text: '\n\nMock 模式。试试："读 src/index.ts"、"列 src"、"运行 echo hi"、"搜索 QueryEngine"' }],
    model: "mock", stop_reason: "end_turn", stop_sequence: null, usage: mockUsage(),
  } as any;
}

/**
 * 流式内容进度看门狗（issue #46）：距上一个事件超过 timeoutMs 无新事件即中断，
 * 复用既有 retry/failover 通道。仅事件重置计时——字节级 keepalive 不产生事件不重置；
 * timeoutMs<=0 关闭。中断时 best-effort 回收内层迭代器（挂死中的 pending read 无法同步取消，
 * 连接由服务端超时/进程退出兜底）。
 */
export async function* withIdleWatchdog(
  inner: AsyncGenerator<StreamEvent>,
  timeoutMs: number,
): AsyncGenerator<StreamEvent> {
  if (timeoutMs <= 0) { yield* inner; return; }
  const it = inner[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`流式响应空闲超时（${timeoutMs}ms 无内容进度），已中断`)),
          timeoutMs,
        );
      });
      let res: IteratorResult<StreamEvent>;
      try {
        res = await Promise.race([it.next(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    // 不 await：async generator 的 return() 排在 pending next() 之后，await 会阻塞当前流
    void Promise.resolve(it.return?.(undefined as never)).catch(() => {});
  }
}

async function* streamMessageInner(
  client: ApiClient, model: string, maxTokens: number, system: SystemInput,
  messages: Anthropic.MessageParam[], tools: Anthropic.Tool[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (client.type === "mock") {
    const msg = mockResponse(messages);
    yield { type: "message_start", message: msg };
    for (const block of msg.content) {
      if (block.type === "text") {
        for (const ch of (block as any).text) {
          yield { type: "text_delta", text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
      } else if (block.type === "tool_use") {
        const id = (block as any).id;
        yield { type: "tool_use_start", id, name: (block as any).name };
        yield { type: "tool_use_delta", id, inputJsonDelta: JSON.stringify((block as any).input) };
        yield { type: "tool_use_stop", id };
      }
    }
    yield { type: "message_delta", stopReason: msg.stop_reason, usage: msg.usage };
    yield { type: "message_stop" };
    return;
  }

  if (client.type === "anthropic" && client.anthropic) {
    // 三断点（issue #45）：system 稳定层由调用方带 cache_control；tools 末项 + 末条消息在此打点
    const stream = client.anthropic.messages.stream({
      model, max_tokens: maxTokens, system,
      messages: withMessageCacheBreakpoint(messages),
      tools: tools.length > 0 ? withToolsCacheBreakpoint(tools) : undefined,
    }, signal ? { signal } : undefined);
    let curToolId = "";
    for await (const ev of stream) {
      if (ev.type === "message_start") { yield { type: "message_start", message: ev.message }; continue; }
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "tool_use") {
          curToolId = ev.content_block.id;
          yield { type: "tool_use_start", id: curToolId, name: ev.content_block.name };
        }
        continue;
      }
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") yield { type: "text_delta", text: ev.delta.text };
        else if (ev.delta.type === "input_json_delta")
          yield { type: "tool_use_delta", id: curToolId, inputJsonDelta: ev.delta.partial_json };
        continue;
      }
      if (ev.type === "content_block_stop") {
        if (curToolId) { yield { type: "tool_use_stop", id: curToolId }; curToolId = ""; }
        continue;
      }
      if (ev.type === "message_delta") {
        yield { type: "message_delta", stopReason: ev.delta.stop_reason, usage: ev.usage as Anthropic.Usage };
        continue;
      }
      if (ev.type === "message_stop") { yield { type: "message_stop" }; continue; }
    }
    return;
  }

  if (client.type === "openai") yield* streamOpenAI(model, maxTokens, systemText(system), messages, tools, signal);
}

/**
 * 对外入口：TUPIG_WIRE=1 时旁路记录原始报文（request + 流式合并后 response），
 * 共享 req_id 配对；开关关直接透传，零开销。
 */
export async function* streamMessage(
  client: ApiClient, model: string, maxTokens: number, system: SystemInput,
  messages: Anthropic.MessageParam[], tools: Anthropic.Tool[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // 空闲看门狗（issue #46）：内容进度超时即中断，交给 retry/failover
  const guarded = () =>
    withIdleWatchdog(
      streamMessageInner(client, model, maxTokens, system, messages, tools, signal),
      resolveStreamIdleTimeoutMs(),
    );
  if (!wireEnabled()) {
    yield* guarded();
    return;
  }
  const reqId = appendWire({
    kind: "llm.request",
    provider: client.type,
    model,
    data: { maxTokens, system, messages, tools },
  })!;
  const acc = { text: "", toolUses: [] as { id: string; name: string; inputJson: string }[], stopReason: undefined as string | null | undefined };
  const toolIdx = new Map<string, number>();
  try {
    for await (const ev of guarded()) {
      if (ev.type === "text_delta") acc.text += ev.text;
      else if (ev.type === "tool_use_start") {
        toolIdx.set(ev.id, acc.toolUses.length);
        acc.toolUses.push({ id: ev.id, name: ev.name, inputJson: "" });
      } else if (ev.type === "tool_use_delta") {
        const i = toolIdx.get(ev.id);
        if (i !== undefined) acc.toolUses[i].inputJson += ev.inputJsonDelta;
      } else if (ev.type === "message_delta") acc.stopReason = ev.stopReason;
      yield ev;
    }
    appendWire({ kind: "llm.response", provider: client.type, model, data: { ...acc, done: true }, req_id: reqId });
  } catch (e) {
    appendWire({ kind: "llm.response", provider: client.type, model, data: { ...acc, done: false, error: String(e) }, req_id: reqId });
    throw e;
  }
}


/**
 * Anthropic 消息 → OpenAI chat 格式。
 * tool_result 含图片时：文本走 role:tool（OpenAI tool content 仅 string），
 * 图片追加一条 user 消息（image_url data URI）。
 */
export function toOpenAIMessages(messages: Anthropic.MessageParam[], system: string): any[] {
  const oaiMsgs: any[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (typeof m.content === "string") {
      oaiMsgs.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const toolUseBlocks = m.content.filter((b: any) => b.type === "tool_use");
      const toolResultBlocks = m.content.filter((b: any) => b.type === "tool_result");
      const textBlocks = m.content.filter((b: any) => b.type === "text");

      if (m.role === "assistant" && toolUseBlocks.length > 0) {
        const textContent = textBlocks.map((b: any) => b.text).join("\n");
        oaiMsgs.push({
          role: "assistant", content: textContent || null,
          tool_calls: toolUseBlocks.map((b: any) => ({
            id: b.id, type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        });
      } else if (m.role === "user" && toolResultBlocks.length > 0) {
        for (const tr of toolResultBlocks) {
          const trId = (tr as any).tool_use_id;
          const c = (tr as any).content;
          if (typeof c === "string") {
            oaiMsgs.push({ role: "tool", tool_call_id: trId, content: c });
          } else if (Array.isArray(c)) {
            const texts = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
            oaiMsgs.push({ role: "tool", tool_call_id: trId, content: texts });
            for (const b of c) {
              if (b.type === "image") {
                oaiMsgs.push({
                  role: "user",
                  content: [
                    { type: "text", text: "工具返回的图片：" },
                    { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } },
                  ],
                });
              }
            }
          } else {
            oaiMsgs.push({ role: "tool", tool_call_id: trId, content: String(c ?? "") });
          }
        }
        const textContent = textBlocks.map((b: any) => b.text).join("\n");
        if (textContent) oaiMsgs.push({ role: "user", content: textContent });
      } else {
        const textContent = m.content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n");
        oaiMsgs.push({ role: m.role, content: textContent });
      }
    }
  }
  return oaiMsgs;
}

async function* streamOpenAI(
  model: string, maxTokens: number, system: string,
  messages: Anthropic.MessageParam[], tools: Anthropic.Tool[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) throw new Error("必须设置 OPENAI_BASE_URL 和 OPENAI_API_KEY 环境变量");

  const oaiMsgs: any[] = toOpenAIMessages(messages, system);

  const oaiTools = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  // 外部中断（Ctrl+C → interrupt）：联动 abort，与超时共用同一 controller（issue #98）
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  const resp = await fetch(chatUrl(base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages: oaiMsgs,
      tools: oaiTools.length > 0 ? oaiTools : undefined,
      max_tokens: maxTokens, stream: true,
      // 末帧 usage（issue #44）：直连也拿 prompt_tokens，与 proxy 注入口径一致
      stream_options: { include_usage: true },
    }),
    signal: controller.signal,
  }).finally(() => { clearTimeout(timeout); signal?.removeEventListener("abort", onOuterAbort); });

  if (!resp.ok) throw new Error(`OpenAI API 返回错误 ${resp.status}：${await resp.text()}`);

  yield* parseOpenAISSE(resp.body, model);
}

/**
 * OpenAI SSE → StreamEvent 解析（纯函数段，便于测试）
 * tool_calls 按 index 分片累积；首包缺 id 时自生成并全程保持一致。
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array> | null, model: string,
): AsyncGenerator<StreamEvent> {
  if (!body) throw new Error("响应体为空");
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const tcs = new Map<number, { id: string; name: string; args: string }>();
  const msgId = `msg_${Date.now()}`;
  const usage = new UsageTracker();
  let stopReason: string | null = null;

  yield {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as any,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      try {
        const p = JSON.parse(data);
        // usage 可能在 finish 之后的 usage-only chunk（include_usage，issue #44）→ 统一先入账
        if (p.usage) usage.record({
          input_tokens: p.usage.prompt_tokens,
          output_tokens: p.usage.completion_tokens,
        });
        const ch = p.choices?.[0];
        if (!ch) continue;
        const d = ch.delta;
        if (d?.content) yield { type: "text_delta", text: d.content };
        if (d?.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            if (!tcs.has(idx)) {
              const id = tc.id || `toolu_${Date.now()}_${idx}`;
              tcs.set(idx, { id, name: tc.function?.name || "", args: "" });
              if (tc.function?.name) yield { type: "tool_use_start", id, name: tc.function.name };
            }
            const ex = tcs.get(idx)!;
            if (tc.function?.name) ex.name = tc.function.name;
            if (tc.function?.arguments) {
              ex.args += tc.function.arguments;
              yield { type: "tool_use_delta", id: ex.id, inputJsonDelta: tc.function.arguments };
            }
          }
        }
        if (ch.finish_reason) {
          for (const [, tc] of tcs) yield { type: "tool_use_stop", id: tc.id };
          // length=输出截断（issue #96）：保留 max_tokens 语义交给升级阶梯，不能吞成 end_turn
          stopReason =
            ch.finish_reason === "tool_calls" ? "tool_use" :
            ch.finish_reason === "length" ? "max_tokens" :
            "end_turn";
        }
      } catch { /* SSE 解析失败时跳过 */ }
    }
  }
  // message_delta 延后到流末发（issue #44）：末帧 usage chunk 可能晚于 finish_reason
  if (stopReason !== null) {
    yield {
      type: "message_delta",
      stopReason,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } as Anthropic.Usage,
    };
  }
  yield { type: "message_stop" };
}

/**
 * 帧级 usage 累计（issue #44）：非零后写覆盖——首帧（message_start）记入，
 * 末帧（非首帧）优先；input 口径 = input_tokens + cache_read + cache_creation 全量入账。
 */
export class UsageTracker {
  private _input = 0;
  private _output = 0;
  record(u?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null): void {
    if (!u) return;
    const input =
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (input > 0) this._input = input;
    const out = u.output_tokens || 0;
    if (out > 0) this._output = out;
  }
  get inputTokens(): number { return this._input; }
  get outputTokens(): number { return this._output; }
}

/** full-jitter 退避（issue #25）：rand(0, min(cap, base*2^attempt)） */
export function computeBackoffMs(
  attempt: number,
  opts?: { base?: number; cap?: number },
): number {
  const base = opts?.base ?? 1000;
  const cap = opts?.cap ?? 10_000;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * (ceiling + 1));
}

/**
 * 带抖动与总预算的重试（issue #25）：
 * - full jitter 防多请求同步重试风暴
 * - 总预算 TUPIG_RETRY_BUDGET_MS（默认 60s）超限立即抛最后一次错误
 * - 401/403 语义错误立即抛
 */
export async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const budgetMs = Number(process.env.TUPIG_RETRY_BUDGET_MS ?? 60_000);
  const startedAt = Date.now();
  let lastErr: Error | undefined;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.message.includes("401") || lastErr.message.includes("403")) throw lastErr;
      if (i >= MAX_RETRIES) break;
      if (Date.now() - startedAt >= budgetMs) break; // 超预算即停
      const wait = computeBackoffMs(i);
      if (Date.now() - startedAt + wait > budgetMs) break; // 等待会超预算也不等
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
