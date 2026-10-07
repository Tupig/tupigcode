/**
 * E65 MCP http/SSE 传输 + OAuth + 状态机（issue #62）
 *
 * - buildMcpTransport：无 url→Stdio、url→StreamableHTTP、url+sse→SSE
 * - resolveMcpFailureState：UnauthorizedError→needs_auth、其他→failed
 * - FileOAuthProvider：tokens/clientInformation/codeVerifier 持久化、
 *   redirectUrl 本地回调收 code、redirectToAuthorization 告警+开浏览器
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import {
  buildMcpTransport,
  resolveMcpFailureState,
  FileOAuthProvider,
  clearMcpApprovals,
  type McpServerEntry,
} from "../../src/engine/mcp";

const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({ command: "noop", ...over });

beforeEach(() => clearMcpApprovals());
afterEach(() => clearMcpApprovals());

describe("buildMcpTransport 分派", () => {
  it("无 url → StdioClientTransport", () => {
    const { transport, provider } = buildMcpTransport(entry({ command: "node", args: ["s.js"] }));
    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(provider).toBeUndefined();
  });

  it("url → StreamableHTTPClientTransport + 挂 provider", () => {
    const { transport, provider } = buildMcpTransport(entry({ url: "https://mcp.example.com/rpc" }));
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(provider).toBeInstanceOf(FileOAuthProvider);
    expect((transport as any)._url.href).toContain("mcp.example.com");
  });

  it("url + transport=sse → SSEClientTransport", () => {
    const { transport } = buildMcpTransport(entry({ url: "https://mcp.example.com/sse", transport: "sse" }));
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });

  it("oauth:false → 不挂 provider", () => {
    const { provider } = buildMcpTransport(entry({ url: "https://x.example/rpc", oauth: false }));
    expect(provider).toBeUndefined();
  });
});

describe("resolveMcpFailureState", () => {
  it("UnauthorizedError → needs_auth；其他 → failed", () => {
    expect(resolveMcpFailureState(new UnauthorizedError("401"))).toBe("needs_auth");
    expect(resolveMcpFailureState(new Error("spawn ENOENT"))).toBe("failed");
    expect(resolveMcpFailureState("boom")).toBe("failed");
  });
});

describe("FileOAuthProvider", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tupig-oauth-"));
  });

  it("tokens/clientInformation/codeVerifier 往返持久化", async () => {
    const p = new FileOAuthProvider("https://mcp.example.com/rpc", { dir });
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({ access_token: "at", token_type: "Bearer" } as any);
    await p.saveClientInformation({ client_id: "cid" } as any);
    await p.saveCodeVerifier("verifier-123");

    const p2 = new FileOAuthProvider("https://mcp.example.com/rpc", { dir });
    expect((await p2.tokens())!.access_token).toBe("at");
    expect((await p2.clientInformation())!.client_id).toBe("cid");
    expect(await p2.codeVerifier()).toBe("verifier-123");
    expect(existsSync(dir)).toBe(true);
  });

  it("clientMetadata.redirect_uris 指向本地 127.0.0.1 回调", async () => {
    const p = new FileOAuthProvider("https://mcp.example.com/rpc", { dir });
    await p.whenReady;
    const url = String(p.redirectUrl);
    expect(url).toContain("http://127.0.0.1:");
    expect(url).not.toContain(":0/");
    expect(url).toContain("/callback");
    expect(p.clientMetadata.redirect_uris).toEqual([url]);
    expect(p.clientMetadata.client_name).toBe("tupigcode");
    p.dispose();
  });

  it("本地回调收到 code → onCode；redirectToAuthorization 告警 + 开浏览器", async () => {
    const open = vi.fn();
    const onWarn = vi.fn();
    const p = new FileOAuthProvider("https://mcp.example.com/rpc", { dir, open, onWarn });
    const gotCode = new Promise<string>((resolve) => {
      p.onCode = resolve;
    });

    await p.whenReady;
    const redirect = String(p.redirectUrl);
    const authUrl = new URL("https://as.example.com/authorize?x=1");
    await p.redirectToAuthorization(authUrl);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("https://as.example.com/authorize"));
    expect(open).toHaveBeenCalledTimes(1);
    // state 必须原样回传（issue #77），否则拒收
    const state = authUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const res = await fetch(`${redirect}?code=CODE-42&state=${encodeURIComponent(state!)}`);
    expect(res.status).toBe(200);
    expect(await gotCode).toBe("CODE-42");
    p.dispose();
  });

  it("dispose 后端口释放（二次 dispose 不抛）", async () => {
    const p = new FileOAuthProvider("https://mcp.example.com/rpc", { dir });
    await p.whenReady;
    void p.redirectUrl;
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
  });
});
