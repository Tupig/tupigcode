/**
 * engine/mcp.ts — MCP 客户端工具桥（协议/握手交给 @modelcontextprotocol/sdk）
 * 配置：workDir/.tupigcode/mcp.json（Claude Code 兼容 { mcpServers: { name: { command, args, env } } }）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer as createHttpServer, type Server as HttpServer } from "http";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { z } from "zod";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { buildTool, type Tool, type ToolUseContext, type CanUseToolFn } from "./Tool.js";

export type McpApproval = "allow" | "ask" | "deny";

/** stdio 子进程随父进程清理（fix #122：exit 监听只挂一次，pid 集合维护，防重连累积监听器） */
const stdioCleanupPids = new Set<number>();
let stdioCleanupArmed = false;
function armStdioCleanup(pid: number): void {
  stdioCleanupPids.add(pid);
  if (stdioCleanupArmed) return;
  stdioCleanupArmed = true;
  process.once("exit", () => {
    for (const p of stdioCleanupPids) {
      try { process.kill(p, "SIGTERM"); } catch { /* 已退出 */ }
    }
  });
}

export type McpServerEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** callTool 单次调用超时（毫秒，issue #60）；未配走 SDK 默认 */
  timeout?: number;
  /** 工具白名单（MCP 原始名，issue #61）；空数组=不裁剪 */
  includeTools?: string[];
  /** 工具黑名单（MCP 原始名，issue #61）；优先于 includeTools */
  excludeTools?: string[];
  /** 远程 server URL（issue #62）；存在则走 http/SSE 传输而非 stdio */
  url?: string;
  /** 远程传输类型：默认 "http"（Streamable HTTP），"sse" 走 SSE */
  transport?: "stdio" | "http" | "sse";
  /** 远程传输附加请求头 */
  headers?: Record<string, string>;
  /** 远程 server OAuth 授权（默认开启；false 则不挂 authProvider） */
  oauth?: boolean;
  /** server 级审批：allow=白名单放行 / ask=强制问 / deny=阻断；未配置=沿用通用链 */
  approval?: McpApproval;
  /** per-tool 覆盖 server 级，key 为 MCP 原始工具名 */
  tools?: Record<string, McpApproval>;
};
export type McpConfigFile = { mcpServers?: Record<string, McpServerEntry> };

// ---------- 审批表（连接时填充；permissions.canUseTool 查询） ----------
type ApprovalDecision = McpApproval | "default";
const approvalTable = new Map<string, ApprovalDecision>();

/** 查询 MCP 工具审批决策；非 MCP 工具返回 undefined */
export function getMcpApproval(toolName: string): ApprovalDecision | undefined {
  return approvalTable.get(toolName);
}

/** 清空审批表（重连/测试隔离用） */
export function clearMcpApprovals(): void {
  approvalTable.clear();
}

// ---------- 远程传输 / OAuth（issue #62） ----------
export type McpServerState = "connected" | "failed" | "needs_auth";

/** 连接失败归类：UnauthorizedError → needs_auth（需用户授权），其他 → failed */
export function resolveMcpFailureState(err: unknown): McpServerState {
  return err instanceof UnauthorizedError ? "needs_auth" : "failed";
}

function defaultOpen(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 打不开浏览器时由告警文案给出 URL */
  }
}

type OAuthStored = { tokens?: OAuthTokens; clientInformation?: OAuthClientInformationMixed; codeVerifier?: string };

/**
 * 文件持久化 OAuthClientProvider（issue #62）：
 * tokens/clientInformation/codeVerifier 落 `<dir>/<server>.json`；
 * 一次性本地 HTTP listener 承接 redirectUrl 回调，收到 code 交给 onCode（finishAuth 接线）。
 */
export class FileOAuthProvider implements OAuthClientProvider {
  onCode?: (code: string) => void;
  /** 本次授权的 state（issue #77）：回调不匹配一律拒收 */
  private oauthState?: string;
  private readonly file: string;
  private readonly open?: (url: string) => void;
  private readonly warn?: (msg: string) => void;
  private server: HttpServer | null = null;
  private port = 0;
  /** 回调 listener 端口就绪后 resolve（redirectUrl/clientMetadata 读取前须 await） */
  readonly whenReady: Promise<void>;

  constructor(serverUrl: string, opts: { dir?: string; open?: (url: string) => void; onWarn?: (msg: string) => void } = {}) {
    const base = opts.dir ?? join(homedir(), ".tupigcode", "mcp-auth");
    try { mkdirSync(base, { recursive: true }); } catch { /* 目录不可写时保存步骤会再报错 */ }
    this.file = join(base, serverUrl.replace(/[^a-zA-Z0-9.-]/g, "_") + ".json");
    this.open = opts.open ?? defaultOpen;
    this.warn = opts.onWarn;
    this.whenReady = new Promise<void>((resolve) => this.ensureListener(resolve));
  }

  private read(): OAuthStored {
    try { return JSON.parse(readFileSync(this.file, "utf-8")) as OAuthStored; } catch { return {}; }
  }
  private write(next: OAuthStored): void {
    writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* 兼容已存在文件 */ }
  }

  get redirectUrl(): string | URL {
    this.ensureListener();
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "tupigcode",
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    } as OAuthClientMetadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined { return this.read().clientInformation; }
  saveClientInformation(info: OAuthClientInformationMixed): void { this.write({ ...this.read(), clientInformation: info }); }
  tokens(): OAuthTokens | undefined { return this.read().tokens; }
  saveTokens(tokens: OAuthTokens): void { this.write({ ...this.read(), tokens }); }
  saveCodeVerifier(v: string): void { this.write({ ...this.read(), codeVerifier: v }); }
  codeVerifier(): string { return this.read().codeVerifier ?? ""; }

  redirectToAuthorization(authorizationUrl: URL): void {
    // 拼入随机 state（issue #77）：授权服务器原样回传，回调比对不匹配拒收
    this.oauthState = randomBytes(16).toString("hex");
    authorizationUrl.searchParams.set("state", this.oauthState);
    this.warn?.(`MCP OAuth 授权：请在浏览器完成授权 ${authorizationUrl.href}`);
    try { this.open?.(authorizationUrl.href); } catch { /* 依赖告警文案展示 URL */ }
  }

  private ensureListener(onReady?: () => void): void {
    if (this.server) return;
    this.server = createHttpServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (code && (!this.oauthState || state !== this.oauthState)) {
        // state 不匹配/缺失（issue #77）：拒绝注入的 code，保持监听等正确回调
        res.end("拒绝：state 校验失败，请从授权页面重新发起。");
        this.warn?.("MCP OAuth 回调 state 校验失败，已拒收该 code");
        return;
      }
      res.end(code ? "授权成功，可关闭本页。" : `授权失败：${u.searchParams.get("error") ?? "缺少 code"}`);
      if (code) {
        const cb = this.onCode;
        this.dispose();
        cb?.(code);
      }
    });
    this.server.listen(0, "127.0.0.1", () => {
      const addr = this.server?.address();
      if (addr && typeof addr === "object") this.port = addr.port;
      onReady?.();
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
  }
}

export type BuiltTransport = { transport: Transport; provider?: FileOAuthProvider };

/** 按 entry 分派传输（issue #62）：无 url→stdio、url→StreamableHTTP、url+sse→SSE；远程默认挂 OAuth provider */
export function buildMcpTransport(
  entry: McpServerEntry,
  opts: { oauthDir?: string; open?: (url: string) => void; onWarn?: (msg: string) => void } = {},
): BuiltTransport {
  if (!entry.url) {
    const merged = { ...process.env, ...entry.env };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) env[k] = v;
    return { transport: new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env, stderr: "pipe" }) };
  }
  const url = new URL(entry.url);
  const provider =
    entry.oauth === false
      ? undefined
      : new FileOAuthProvider(entry.url, { dir: opts.oauthDir, open: opts.open, onWarn: opts.onWarn });
  const requestInit: RequestInit | undefined = entry.headers ? { headers: entry.headers } : undefined;
  if (entry.transport === "sse") {
    return { transport: new SSEClientTransport(url, { requestInit, authProvider: provider }), provider };
  }
  return { transport: new StreamableHTTPClientTransport(url, { requestInit, authProvider: provider }), provider };
}

/** 读取 .tupigcode/mcp.json；不存在/非法 → null（不抛） */
export function loadMcpConfig(workDir: string): McpConfigFile | null {
  try {
    const raw = readFileSync(join(workDir, ".tupigcode", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw) as McpConfigFile;
    return parsed && typeof parsed === "object" && parsed.mcpServers ? parsed : null;
  } catch {
    return null;
  }
}

export type McpAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpAnnotations;
};

/**
 * 按 server 配置裁剪工具列表（issue #61）：
 * exclude 命中先剔除（exclude 优先）；配了非空 include → 只留名单内；均未配 → 全量。
 */
export function filterMcpToolDefs(defs: McpToolDef[], entry: McpServerEntry): McpToolDef[] {
  const exclude = new Set(entry.excludeTools ?? []);
  const include = entry.includeTools?.length ? new Set(entry.includeTools) : null;
  return defs.filter((d) => !exclude.has(d.name) && (!include || include.has(d.name)));
}

/**
 * 把 MCP 工具桥接为 tupigcode Tool（issue #58）：
 * annotations 全量消费——readOnlyHint 决定只读分级；显式 destructiveHint=true
 * 且非只读 → 审批登记时升为 ask（deny 优先、allow 被覆盖）；annotations 缺省不强制。
 */
export function wrapMcpTool(serverName: string, def: McpToolDef, client: Pick<Client, "callTool">, entry: McpServerEntry): Tool {
  const toolName = `mcp_${serverName}_${def.name}`;
  const an = def.annotations ?? {};
  const readOnly = an.readOnlyHint === true;
  // 审批登记：per-tool 覆盖 server 级，均未配置 = default（走通用权限链）
  let approval: McpApproval | "default" = entry.tools?.[def.name] ?? entry.approval ?? "default";
  if (approval !== "deny" && !readOnly && an.destructiveHint === true) {
    approval = "ask"; // 破坏性标注强制确认（issue #58）
  }
  approvalTable.set(toolName, approval);
  const jsonSchema = def.inputSchema ?? { type: "object", properties: {} };
  const title = def.annotations?.title ?? def.title;
  const desc = (title ? `${title} — ` : "") + (def.description || "MCP 工具（无描述）");
  return buildTool<string>({
    name: toolName,
    inputSchema: z.any(),
    jsonSchema,
    maxResultSizeChars: 100_000,
    description: () => `[MCP:${serverName}] ${desc}\n参数 JSON Schema：${JSON.stringify(jsonSchema)}`,
    prompt: () => desc,
    userFacingName: () => toolName,
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async checkPermissions() {
      // 与审批表对齐（主链路判定在 permissions.canUseTool；此处为防御一致性）
      const d = getMcpApproval(toolName);
      if (d === "deny") return { behavior: "deny" as const, message: `MCP 工具「${toolName}」已被 mcp.json 审批禁止` };
      if (d === "ask") return { behavior: "ask" as const, message: `MCP 工具「${toolName}」需要用户确认（mcp.json 审批）` };
      return { behavior: "allow" as const };
    },
    async call(input, _ctx: ToolUseContext, _canUseTool: CanUseToolFn) {
      try {
        const opts = typeof entry.timeout === "number" && entry.timeout > 0 ? { timeout: entry.timeout } : undefined;
        const r = await client.callTool(
          { name: def.name, arguments: (input ?? {}) as Record<string, unknown> },
          undefined,
          opts,
        );
        const content = (r?.content ?? []) as Array<{ type: string; text?: string }>;
        const texts = content.filter((b) => b.type === "text").map((b) => b.text ?? "");
        const joined = texts.length > 0 ? texts.join("\n") : JSON.stringify(content);
        if ((r as any)?.isError) {
          return { data: `错误：MCP 工具 ${toolName} 返回失败\n${joined}`, isError: true };
        }
        return { data: joined, resultForAssistant: joined };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { data: `错误：调用 MCP 工具 ${toolName} 失败：${msg}`, isError: true };
      }
    },
    mapToolResultToToolResultBlockParam(content, toolUseID) {
      return { type: "tool_result", tool_use_id: toolUseID, content };
    },
  });
}

/** transport.onclose：摘除断开 server 的全部工具（issue #60），模型不再看到死工具 */
export function handleServerDrop(
  serverName: string,
  serverTools: Map<string, Tool[]>,
  fireChanged: () => void,
  onWarn?: (msg: string) => void,
): void {
  if (!serverTools.has(serverName)) return;
  serverTools.delete(serverName);
  onWarn?.(`MCP server "${serverName}" 连接断开，已摘除其工具（重连中）`);
  fireChanged();
}

/** 退避延迟（issue #60）：1s 起指数翻倍，30s 封顶 */
export function backoffDelayMs(attempt: number): number {
  const exp = 1_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, 30_000);
}

/**
 * 重连单飞守卫（issue #76）：同一 key 的重连循环同时只允许一个——
 * acquire 失败即拒绝重复触发，release 后才可再次获取。
 */
export function createReconnectGuard(): {
  acquire: (key: string) => boolean;
  release: (key: string) => void;
} {
  const busy = new Set<string>();
  return {
    acquire: (key) => {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    release: (key) => {
      busy.delete(key);
    },
  };
}

/**
 * 断开重连循环（issue #60）：退避重试，成功返回 true；
 * 耗尽 maxAttempts 调 onGaveUp 返回 false。
 */
export async function reconnectLoop(opts: {
  tryConnect: () => Promise<boolean>;
  maxAttempts?: number;
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  onGaveUp?: () => void;
}): Promise<boolean> {
  const max = opts.maxAttempts ?? 5;
  const delay = opts.delayMs ?? backoffDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= max; attempt++) {
    await sleep(delay(attempt));
    try {
      if (await opts.tryConnect()) return true;
    } catch {
      /* 单次重连失败 → 继续退避 */
    }
  }
  opts.onGaveUp?.();
  return false;
}

export type McpConnection = {
  tools: Tool[];
  /** 全量重拉所有 server 的 tools/list 并 diff 同步（issue #59） */
  refresh: () => Promise<{ added: string[]; removed: string[] }>;
  /** 各 server 状态：connected/failed/needs_auth（issue #62） */
  states: Map<string, McpServerState>;
  close: () => Promise<void>;
};

type RefreshableClient = Pick<Client, "callTool"> & { listTools?: () => Promise<{ tools?: McpToolDef[] }> };

/**
 * 构建单 server 的 tools/list 重拉器（issue #59）：
 * 重拉 → 重 wrap 全量 → diff added/removed → 写回 serverTools；
 * 变更才 fireChanged + onWarn；失败保留旧工具只告警。
 */
export function makeServerRefresher(opts: {
  serverName: string;
  entry: McpServerEntry;
  client: RefreshableClient;
  serverTools: Map<string, Tool[]>;
  fireChanged: () => void;
  onWarn?: (msg: string) => void;
}): () => Promise<{ added: string[]; removed: string[] }> {
  const { serverName, entry, client, serverTools, fireChanged, onWarn } = opts;
  return async () => {
    const old = serverTools.get(serverName) ?? [];
    try {
      const listed = await client.listTools?.();
      const fresh = filterMcpToolDefs(listed?.tools ?? [], entry).map((t) => wrapMcpTool(serverName, t, client, entry));
      const oldNames = new Set(old.map((t) => t.name));
      const newNames = new Set(fresh.map((t) => t.name));
      const added = [...newNames].filter((n) => !oldNames.has(n));
      const removed = [...oldNames].filter((n) => !newNames.has(n));
      // 同名工具 signature 变更也算变更（fix #75）：schema/description/readOnly
      // 变更后外部不换新 wrap 会残留旧免审面
      const sigOf = (t: Tool): string =>
        JSON.stringify([
          t.name,
          (t as { jsonSchema?: unknown }).jsonSchema ?? null,
          typeof t.description === "function" ? t.description({} as never) : String((t as { description?: unknown }).description ?? ""),
          (() => { try { return t.isReadOnly({} as never); } catch { return false; } })(),
        ]);
      const oldSig = new Map(old.map((t) => [t.name, sigOf(t)]));
      const updated = fresh.some((t) => oldSig.has(t.name) && oldSig.get(t.name) !== sigOf(t));
      serverTools.set(serverName, fresh);
      if (added.length || removed.length) {
        onWarn?.(
          `MCP server "${serverName}" 工具列表已变更：+${added.join(", ") || "无"} -${removed.join(", ") || "无"}`,
        );
        fireChanged();
      } else if (updated) {
        onWarn?.(`MCP server "${serverName}" 同名工具定义已变更，已刷新生效`);
        fireChanged();
      }
      return { added, removed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onWarn?.(`MCP server "${serverName}" tools/list 刷新失败（保留旧工具）：${msg}`);
      return { added: [], removed: [] };
    }
  };
}

/** 订阅 notifications/tools/list_changed → 触发刷新（issue #59）；不支持则静默 */
export function registerListChanged(
  client: Pick<Client, "setNotificationHandler">,
  refresh: () => Promise<unknown>,
): void {
  try {
    client.setNotificationHandler(ToolListChangedNotificationSchema as never, async () => {
      await refresh();
    });
  } catch {
    /* client 不支持通知处理器 */
  }
}

/**
 * 连接全部已配置的 MCP server 并桥接为 tupigcode Tool。
 * 单个 server 失败只降级跳过，从不 reject。
 * onToolsChanged：任一 server list_changed/refresh 后回调全量工具集（issue #59）。
 */
export async function connectMcpServers(
  workDir: string,
  onWarn?: (msg: string) => void,
  onToolsChanged?: (tools: Tool[]) => void,
): Promise<McpConnection> {
  const cfg = loadMcpConfig(workDir);
  const entries = Object.entries(cfg?.mcpServers ?? {});
  if (entries.length === 0) return { tools: [], refresh: async () => ({ added: [], removed: [] }), states: new Map(), close: async () => {} };

  const serverTools = new Map<string, Tool[]>();
  const refresherMap = new Map<string, () => Promise<{ added: string[]; removed: string[] }>>();
  const closers: Array<() => Promise<void>> = [];
  const serverStates = new Map<string, McpServerState>(); // connected/failed/needs_auth（issue #62）
  const fireChanged = () => onToolsChanged?.([...serverTools.values()].flat());

  let closed = false; // connection close 后不再重连（issue #60）
  const reconnectGuard = createReconnectGuard(); // 重连单飞（issue #76）

  await Promise.all(
    entries.map(async ([serverName, entry]) => {
      let curClient: Client | null = null;
      let curTransport: Transport | null = null;
      let curProvider: FileOAuthProvider | undefined;

      // needs_auth：等本地回调拿到 code → finishAuth → 自动重连（issue #62）
      const armOAuth = (provider: FileOAuthProvider, transport: Transport): void => {
        provider.onCode = async (code) => {
          try {
            const finish = (transport as { finishAuth?: (c: string) => Promise<void> }).finishAuth;
            if (finish) await finish.call(transport, code);
            await connectOnce();
            if (serverStates.get(serverName) === "connected") {
              onWarn?.(`MCP server "${serverName}" 授权完成，已重连`);
              fireChanged();
            }
          } catch (e) {
            serverStates.set(serverName, resolveMcpFailureState(e));
            onWarn?.(`MCP server "${serverName}" 授权后重连失败：${e instanceof Error ? e.message : String(e)}`);
          }
        };
      };

      // 首连、退避重连与授权后重连复用（issue #60/#62）
      const connectOnce = async (): Promise<void> => {
        try {
          const client = new Client({ name: "tupigcode-tupigcode", version: "1.0.0" });
          curClient = client;
          const built = buildMcpTransport(entry, { onWarn });
          curProvider?.dispose();
          curProvider = built.provider;
          const transport = built.transport;
          curTransport = transport;
          await built.provider?.whenReady; // 回调端口就绪后才能读 redirectUrl（issue #62）
          await client.connect(transport);
          const listed = await client.listTools();
          serverTools.set(
            serverName,
            filterMcpToolDefs((listed.tools ?? []) as McpToolDef[], entry).map((t) => wrapMcpTool(serverName, t, client, entry)),
          );
          const refreshOne = makeServerRefresher({ serverName, entry, client, serverTools, fireChanged, onWarn });
          refresherMap.set(serverName, refreshOne);
          registerListChanged(client, refreshOne);
          // 断开 → 立即摘除死工具 + 退避重连（issue #60/#76 单飞）
          transport.onclose = () => {
            if (closed) return;
            handleServerDrop(serverName, serverTools, fireChanged, onWarn);
            if (!reconnectGuard.acquire(serverName)) return; // 已有重连循环在跑
            void reconnectLoop({
              tryConnect: async () => {
                if (closed) return true;
                await connectOnce();
                if (serverStates.get(serverName) !== "connected") return true; // needs_auth → 停循环等授权回调
                onWarn?.(`MCP server "${serverName}" 已重连，工具恢复`);
                fireChanged();
                return true;
              },
              onGaveUp: () => onWarn?.(`MCP server "${serverName}" 重连放弃（最多 5 次退避重试）`),
            }).finally(() => reconnectGuard.release(serverName));
          };
          // 进程退出兜底：stdio 子进程随父进程清理（exit 监听全局单次注册，fix #122）
          if (transport instanceof StdioClientTransport) {
            const pid = transport.pid;
            if (pid) armStdioCleanup(pid);
          }
          serverStates.set(serverName, "connected");
        } catch (e) {
          if (resolveMcpFailureState(e) === "needs_auth" && curProvider) {
            serverStates.set(serverName, "needs_auth");
            armOAuth(curProvider, curTransport!); // provider.warn 已输出授权 URL/浏览器提示
            return;
          }
          serverStates.set(serverName, "failed");
          throw e;
        }
      };

      closers.push(async () => {
        try { await curClient?.close(); } catch { /* 已断开 */ }
        try { await curTransport?.close(); } catch { /* 已关闭 */ }
        curProvider?.dispose();
      });

      try {
        await connectOnce(); // 首连失败只降级跳过，不自动重连（与既有语义一致）
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onWarn?.(`MCP server "${serverName}" 连接失败，已跳过：${msg}`);
        const failed = curClient as Client | null;
        if (failed) {
          try { await failed.close(); } catch { /* 忽略 */ }
        }
      }
    }),
  );

  return {
    tools: [...serverTools.values()].flat(),
    states: serverStates,
    refresh: async () => {
      const results = await Promise.all([...refresherMap.values()].map((r) => r()));
      const added = results.flatMap((r) => r.added);
      const removed = results.flatMap((r) => r.removed);
      return { added, removed };
    },
    close: async () => {
      closed = true;
      await Promise.allSettled(closers.map((c) => c()));
    },
  };
}
