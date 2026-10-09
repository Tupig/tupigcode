#!/usr/bin/env node
/**
 * cli/gameqa.ts — gameqa 平台 CLI（Go server/main.go 与 Rust/Python agent 的统一入口）
 *   gameqa serve   编排服务（看板 + API + 内置执行器 worker，支持 TLS auto/off）
 *   gameqa agent   测试 Agent（心跳→领取→执行→上报循环）
 */
import { Command } from "commander";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../gameqa/store.js";
import { createGameqaServer } from "../gameqa/server.js";
import { startBuiltinWorker } from "../gameqa/builtin.js";
import { ensureTLSCertificate } from "../gameqa/tls.js";
import { runAgent } from "../gameqa/agent.js";

const VERSION = process.env.GAMEQA_VERSION ?? "1.0.0";

/** 静态看板目录：dist/cli/../gameqa/static 或 src/cli/../gameqa/static（dev 与构建同构） */
function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "gameqa", "static");
}

function envOr(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

interface ServeOpts {
  port: string;
  data: string;
  static: string;
  tls: string;
  token?: string;
}

function serve(opts: ServeOpts): void {
  const port = opts.port;
  const dataDir = opts.data;
  const staticDir = path.resolve(opts.static);
  const tlsMode = opts.tls;
  if (!fs.existsSync(path.join(staticDir, "index.html"))) {
    console.error(`[启动] 静态资源目录缺少 index.html: ${staticDir}`);
    process.exit(1);
  }
  if (opts.token !== undefined) process.env["PLATFORM_TOKEN"] = opts.token;

  // 绑定面管控（fix #117）：默认仅环回；非环回必须有 token（或显式 GAMEQA_INSECURE=1）
  const host = envOr("GAMEQA_HOST", "127.0.0.1");
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback && (process.env["PLATFORM_TOKEN"] ?? "") === "") {
    if (process.env["GAMEQA_INSECURE"] !== "1") {
      console.error(
        "[启动] 拒绝启动：GAMEQA_HOST 非环回且未设 PLATFORM_TOKEN——无鉴权的编排服务可被同网段注册假 Agent 触发 RCE。请设置 token（--token/PLATFORM_TOKEN），或显式 GAMEQA_INSECURE=1 豁免",
      );
      process.exit(1);
    }
    console.warn("[启动][警告] GAMEQA_INSECURE=1：非环回监听且无鉴权——仅限可信内网");
  }

  const store = new Store(dataDir);
  const handler = createGameqaServer(store, staticDir);

  // 内置执行器（无需 Agent 的真实测试能力），随服务停机一起停止
  const staleMinutes = parseInt(envOr("STALE_MINUTES", "30"), 10);
  const staleMs = (Number.isNaN(staleMinutes) || staleMinutes <= 0 ? 30 : staleMinutes) * 60_000;
  const stopWorker = startBuiltinWorker(store, 500, staleMs);

  let srv: http.Server | https.Server;
  const scheme = tlsMode === "off" ? "http" : "https";
  if (tlsMode === "off") {
    console.log("[启动][警告] TLS 已关闭，流量明文传输——仅限可信内网使用");
    srv = http.createServer(handler);
  } else {
    const { certFile, keyFile, fingerprint } = ensureTLSCertificate(
      dataDir,
      process.env["TLS_CERT"] ?? "",
      process.env["TLS_KEY"] ?? "",
    );
    srv = https.createServer(
      {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
        minVersion: "TLSv1.2",
      },
      handler,
    );
    console.log(`[启动] TLS 证书: ${certFile}（自签名/用户证书，Agent 侧可用 PLATFORM_INSECURE_TLS=1 或 PLATFORM_TLS_CERT 指定信任）`);
    console.log(`[启动] TLS 指纹(SHA-256): ${fingerprint}`);
  }
  srv.headersTimeout = 10_000;

  // 优雅停机：SIGINT/SIGTERM 后排水 10s
  let closing = false;
  const shutdown = (sig: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[停机] 收到 ${sig}，排水 10s 内完成在途请求…`);
    stopWorker();
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  srv.listen(Number(port), host, () => {
    console.log(
      `[启动] gameqa 编排服务 ${VERSION} 监听 ${scheme}://${host}:${port}（数据目录 ${dataDir}，静态资源 ${staticDir}）`,
    );
  });
  srv.on("error", (err) => {
    console.error(`[启动] 端口监听失败: ${err.message}`);
    process.exit(1);
  });
}

async function agent(opts: {
  url: string;
  platform: string;
  id?: string;
  skills?: string;
  workdir: string;
  iterations?: string;
  pollInterval?: string;
}): Promise<void> {
  if (opts.id !== undefined) process.env["AGENT_ID"] = opts.id;
  if (opts.skills !== undefined) process.env["AGENT_SKILLS"] = opts.skills;
  process.env["AGENT_WORKDIR"] = opts.workdir;
  await runAgent({
    baseUrl: opts.url,
    platform: opts.platform,
    maxIterations: opts.iterations !== undefined ? parseInt(opts.iterations, 10) : undefined,
    pollIntervalMs: opts.pollInterval !== undefined ? parseInt(opts.pollInterval, 10) : undefined,
  });
}

const program = new Command();
program
  .name("gameqa")
  .description("Unity3D 游戏自动化测试平台（编排服务 + Agent）")
  .version(VERSION, "-V, --version");

program
  .command("serve")
  .description("启动编排服务（看板 + API + 内置执行器）")
  .option("-p, --port <port>", "监听端口", envOr("PORT", "9111"))
  .option("-d, --data <dir>", "数据目录", envOr("DATA_DIR", "data"))
  .option("-s, --static <dir>", "静态资源目录", envOr("STATIC_DIR", defaultStaticDir()))
  .option("--tls <mode>", "TLS 模式: auto（自签名/用户证书，默认）| off（明文，仅限可信内网）", envOr("TLS_MODE", "auto"))
  .option("--token <token>", "启用 Bearer Token 认证（等价 PLATFORM_TOKEN）")
  .action(serve);

program
  .command("agent")
  .description("启动测试 Agent（心跳→领取→执行→上报）")
  .option("-u, --url <url>", "编排服务地址", envOr("PLATFORM_URL", "http://localhost:9111"))
  .option("--platform <platform>", "平台标记", envOr("PLATFORM", "mac"))
  .option("--id <agentId>", "Agent ID（缺省随机）")
  .option("--skills <skills>", "技能列表（逗号分隔）")
  .option("-w, --workdir <dir>", "任务工作目录", envOr("AGENT_WORKDIR", "data/agent_runs"))
  .option("--iterations <n>", "轮询 N 轮后退出（调试用；默认无限）")
  .option("--poll-interval <ms>", "空轮询间隔毫秒（默认 15000）")
  .action(agent);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
