/**
 * cli/mlxcmd.ts — MLX 本地模型服务管理（mlx/ 五个 shell 对译，统一语言到 TS）
 * 对译：mlx-local.sh + lib.sh + healthcheck.sh + model_utils.sh + metrics.sh
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import { basename, join } from "path";
import { createInterface } from "readline";
import { cliRoot } from "./common.js";

// ------------------------------------------------------------------ 配置（config.env 等价：env 优先 + 内置默认）

const mlxHome = () => process.env.MLX_HOME || join(cliRoot(), "mlx");
const venv = () => process.env.MLX_VENV || join(mlxHome(), "venv");
const logs = () => process.env.MLX_LOGS || join(mlxHome(), "logs");
const models = () => process.env.MLX_MODELS || join(mlxHome(), "models");
const state = () => process.env.MLX_STATE || join(mlxHome(), "state");
const UNIFIED_PORT = Number(process.env.MLX_UNIFIED_PORT || 4100);
const SERVER_PORT = Number(process.env.MLX_SERVER_PORT || 8080);
const DEFAULT_KEY = process.env.MLX_DEFAULT_MODEL || "14b";

const log = (msg: string) => process.stdout.write(`[mlx] ${msg}\n`);
const warn = (msg: string) => process.stderr.write(`[mlx] 错误: ${msg}\n`);
function die(msg: string): never {
  warn(msg);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ensureDirs(): void {
  mkdirSync(logs(), { recursive: true });
  mkdirSync(state(), { recursive: true });
}
ensureDirs();

// ------------------------------------------------------------------ 进程管理

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const lsofPid = (port: number): number | null => {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const first = (r.stdout || "").split("\n").find((l) => l.trim());
  return first ? Number(first.trim()) : null;
};

function portPid(port: number, pidFile?: string): number | null {
  if (pidFile && existsSync(pidFile)) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid && alive(pid)) return pid;
    } catch { /* fallthrough */ }
  }
  return lsofPid(port);
}

async function waitPort(port: number, label: string, pid: number | null, timeoutSec: number): Promise<boolean> {
  for (let i = 0; i < timeoutSec; i++) {
    if (pid && !alive(pid)) return false;
    if (lsofPid(port)) return true;
    await sleep(1000);
  }
  warn(`等待 ${label}(port ${port}) 超时(${timeoutSec}s)`);
  return false;
}

// ------------------------------------------------------------------ 模型管理（models.json 直读，替代 python 内嵌查询）

type ModelInfo = { name: string; size?: string; description?: string; alias?: string; huggingface?: string; size_warning?: string };

function readCatalog(): Record<string, ModelInfo> {
  const f = join(mlxHome(), "models.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")).models ?? {};
  } catch {
    return {};
  }
}

const HARD_CODED: Record<string, string> = {
  "14b": "Qwen3-14B-4bit", "qwen3-14b": "Qwen3-14B-4bit",
  "8b": "Qwen3-8B-4bit", "qwen3-8b": "Qwen3-8B-4bit",
  "30b": "Qwen3-Coder-30B-A3B-Instruct-4bit", "coder": "Qwen3-30B", "qwen3-coder": "Qwen3-Coder-30B-A3B-Instruct-4bit",
  "qwen-vl-8b": "Qwen3-VL-8B-Instruct-4bit", "vl-8b": "Qwen3-VL-8B-Instruct-4bit",
};

function modelDirFor(key: string): string | null {
  const info = readCatalog()[key];
  if (info) return info.name;
  return HARD_CODED[key] ?? null;
}

const checkVenv = () => existsSync(join(venv(), "bin", "python"));

// ------------------------------------------------------------------ 服务启动 / 停止

function spawnDetached(cmd: string, args: string[], logFile: string): number {
  const out = openSync(logFile, "a");
  try {
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    return child.pid!;
  } finally {
    closeSync(out);
  }
}

function proxyLauncher(): { cmd: string; args: string[] } {
  const dist = join(cliRoot(), "dist", "proxy", "server.js");
  if (existsSync(dist)) return { cmd: process.execPath, args: [dist] };
  const tsx = join(cliRoot(), "node_modules", ".bin", "tsx");
  return existsSync(tsx)
    ? { cmd: tsx, args: [join(cliRoot(), "src", "proxy", "server.ts")] }
    : { cmd: process.execPath, args: ["--import", "tsx", join(cliRoot(), "src", "proxy", "server.ts")] };
}

async function modelReady(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default_model", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: ac.signal,
    }).catch(() => null);
    clearTimeout(t);
    if (!r) return false;
    const txt = await r.text();
    return txt.includes('"choices"');
  } catch {
    return false;
  }
}

async function cmdStart(key = DEFAULT_KEY): Promise<number> {
  process.stdout.write("启动 MLX 本地模型服务\n────────────────────────────────────────────────\n");

  if (!checkVenv()) die("Python虚拟环境不存在，请先运行: python3 -m venv venv && venv/bin/pip install mlx-lm");

  const modelDir = modelDirFor(key);
  if (!modelDir) die(`未知模型别名: ${key}`);
  if (!existsSync(join(models(), modelDir))) {
    process.stdout.write(`模型目录不存在: ${models()}/${modelDir}\n使用 'mlx-local model download ${key}' 下载\n`);
    return 1;
  }

  writeFileSync(join(state(), "current_model"), key);

  process.stdout.write("启动推理服务...\n");
  // 并发上限为1：24GB机器上多路大上下文并发会触发Metal OOM
  const serverPid = spawnDetached(join(venv(), "bin", "mlx_lm.server"), [
    "--model", join(models(), modelDir),
    "--host", "127.0.0.1",
    "--port", String(SERVER_PORT),
    "--prompt-concurrency", "1",
    "--decode-concurrency", "1",
    "--prompt-cache-size", "1",
    "--prefill-step-size", "1024",
    "--chat-template-args", '{"enable_thinking":false}',
  ], join(logs(), "server.log"));
  writeFileSync(join(state(), "server.pid"), String(serverPid));
  process.stdout.write(`  PID: ${serverPid}\n`);

  process.stdout.write("等待推理服务端口就绪...\n");
  if (!(await waitPort(SERVER_PORT, "server", serverPid, 120))) die("推理服务启动超时（120秒）");

  process.stdout.write("等待模型加载完成...\n");
  let ready = false;
  for (let i = 0; i < 120; i += 2) {
    if (await modelReady()) {
      ready = true;
      break;
    }
    if (!alive(serverPid)) die("推理服务进程已退出");
    await sleep(2000);
  }
  if (!ready) die("模型加载超时（120秒）");
  process.stdout.write("  ✓ 推理服务已就绪（模型已加载）\n");

  process.stdout.write("启动统一代理...\n");
  const { cmd, args } = proxyLauncher();
  const proxyPid = spawnDetached(cmd, args, join(logs(), "unified_proxy.log"));
  writeFileSync(join(state(), "unified_proxy.pid"), String(proxyPid));
  process.stdout.write(`  PID: ${proxyPid}\n`);

  process.stdout.write("等待统一代理就绪...\n");
  if (!(await waitPort(UNIFIED_PORT, "unified_proxy", proxyPid, 30))) die("统一代理启动超时（30秒）");
  process.stdout.write("  ✓ 统一代理已就绪\n");

  process.stdout.write(`\n全部就绪。\n\n  端口: ${UNIFIED_PORT} (Chat/Responses/Anthropic)\n  模型: ${key} (${modelDir})\n  状态: mlx-local status\n  停止: mlx-local stop\n`);
  return 0;
}

async function cmdStop(): Promise<void> {
  const targets: [string, number, string][] = [
    ["server", SERVER_PORT, join(state(), "server.pid")],
    ["unified_proxy", UNIFIED_PORT, join(state(), "unified_proxy.pid")],
  ];
  for (const [name, port, pidFile] of targets) {
    let pid = portPid(port, pidFile);
    if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8").trim()) || null;
    if (pid && alive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
      // 细粒度等待：前3次200ms，之后2次1s
      for (let i = 0; i < 3 && alive(pid); i++) await sleep(200);
      for (let i = 0; i < 2 && alive(pid); i++) await sleep(1000);
      if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      log(`${name.padEnd(10)} 已停止   pid ${pid}`);
    } else {
      log(`${name.padEnd(10)} 未运行`);
    }
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ 状态 / 诊断

function serviceLine(name: string, port: number, pidFile: string): string {
  const pid = portPid(port, pidFile);
  return pid && alive(pid) ? `✓ ${name} (PID: ${pid})` : `✗ ${name}`;
}

function humanSize(p: string): string {
  try {
    const b = statSync(p).size;
    const units = ["B", "K", "M", "G", "T"];
    let i = 0;
    let n = b;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
  } catch {
    return "?";
  }
}

async function cmdStatus(): Promise<void> {
  process.stdout.write("本地 MLX 模型服务\n\n");
  const currentKey = existsSync(join(state(), "current_model")) ? readFileSync(join(state(), "current_model"), "utf8").trim() : "未知";
  const currentModel = modelDirFor(currentKey) ?? "";

  process.stdout.write(`  环境目录    ${mlxHome()}\n`);
  process.stdout.write(`  架构        单端口(:${UNIFIED_PORT})\n`);
  process.stdout.write(`  当前模型    ${currentKey}  (${currentModel})\n\n`);

  process.stdout.write("  服务\n");
  process.stdout.write(`    ${serviceLine("server", SERVER_PORT, join(state(), "server.pid"))}\n`);
  process.stdout.write(`    ${serviceLine("unified_proxy", UNIFIED_PORT, join(state(), "unified_proxy.pid"))}\n\n`);
  process.stdout.write(`  对外端口    :${UNIFIED_PORT} (支持 Chat/Responses/Anthropic 协议)\n\n`);

  process.stdout.write("  已下载模型\n");
  const cat = readCatalog();
  for (const [key, info] of Object.entries(cat)) {
    const path = join(models(), info.name);
    if (existsSync(path)) {
      process.stdout.write(`    ${info.name.padEnd(45)} ${(info.size ?? "?").padEnd(8)} ${info.alias ?? key}\n`);
    }
  }
}

function cmdDoctor(): number {
  process.stdout.write("MLX 环境诊断\n\n");
  let errors = 0;

  process.stdout.write("1. 检查基础目录\n");
  for (const dir of [mlxHome(), venv(), logs(), models(), state()]) {
    if (existsSync(dir)) process.stdout.write(`  ✓ ${dir}\n`);
    else { process.stdout.write(`  ✗ ${dir} (不存在)\n`); errors++; }
  }
  process.stdout.write("\n");

  process.stdout.write("2. 检查Python环境\n");
  if (checkVenv()) {
    const v = spawnSync(join(venv(), "bin", "python"), ["--version"], { encoding: "utf8" });
    process.stdout.write(`  ✓ Python: ${(v.stdout || v.stderr || "").trim()}\n`);
  } else {
    process.stdout.write("  ✗ Python虚拟环境不存在\n");
    errors++;
  }
  process.stdout.write("\n");

  process.stdout.write("3. 检查模型\n");
  const cur = existsSync(join(state(), "current_model")) ? readFileSync(join(state(), "current_model"), "utf8").trim() : "";
  if (cur) {
    const md = modelDirFor(cur);
    if (md && existsSync(join(models(), md))) process.stdout.write(`  ✓ 当前模型: ${cur} (${md})\n`);
    else { process.stdout.write(`  ✗ 当前模型目录不存在: ${md ?? cur}\n`); errors++; }
  } else {
    process.stdout.write("  ! 未设置当前模型\n");
  }
  process.stdout.write("\n");

  process.stdout.write("4. 检查服务状态\n");
  process.stdout.write(`  ${serviceLine("server", SERVER_PORT, join(state(), "server.pid"))}\n`);
  process.stdout.write(`  ${serviceLine("unified_proxy", UNIFIED_PORT, join(state(), "unified_proxy.pid"))}\n\n`);

  process.stdout.write("5. 检查端口\n");
  process.stdout.write(lsofPid(SERVER_PORT) ? `  ✓ 端口 ${SERVER_PORT} 可用\n` : `  ✗ 端口 ${SERVER_PORT} 不可用\n`);
  process.stdout.write(lsofPid(UNIFIED_PORT) ? `  ✓ 端口 ${UNIFIED_PORT} 可用\n` : `  ✗ 端口 ${UNIFIED_PORT} 不可用\n\n`);

  process.stdout.write("6. 检查日志文件\n");
  for (const lf of [join(logs(), "server.log"), join(logs(), "unified_proxy.log")]) {
    if (existsSync(lf)) process.stdout.write(`  ✓ ${basename(lf)} (${humanSize(lf)})\n`);
    else process.stdout.write(`  ! ${basename(lf)} (不存在)\n`);
  }
  process.stdout.write("\n");

  process.stdout.write("诊断完成\n");
  if (errors === 0) process.stdout.write("✓ 未发现问题\n");
  else process.stdout.write(`✗ 发现 ${errors} 个问题\n`);
  return errors;
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal }).catch(() => null);
    clearTimeout(t);
    return !!r?.ok;
  } catch {
    return false;
  }
}

async function cmdHealthcheck(autoRestart: boolean, autoDowngrade: boolean): Promise<void> {
  process.stdout.write("健康检查\n\n");

  const serverPid = portPid(SERVER_PORT);
  const proxyPid = portPid(UNIFIED_PORT);

  let serverOk = false;
  if (serverPid) {
    serverOk = await httpOk(`http://127.0.0.1:${SERVER_PORT}/v1/models`);
    process.stdout.write(serverOk ? "✓ 推理服务响应正常\n" : "✗ 推理服务无响应\n");
  } else process.stdout.write("✗ 推理服务未运行\n");

  let proxyOk = false;
  if (proxyPid) {
    proxyOk = await httpOk(`http://127.0.0.1:${UNIFIED_PORT}/health`);
    process.stdout.write(proxyOk ? "✓ 统一代理响应正常\n" : "✗ 统一代理无响应\n");
  } else process.stdout.write("✗ 统一代理未运行\n");

  process.stdout.write("\n");

  if (!serverOk || !proxyOk) {
    process.stdout.write("检测到服务异常\n");
    if (autoRestart) {
      process.stdout.write("自动重启服务...\n");
      await cmdStop();
      await sleep(2000);
      await cmdStart();
    }
    if (autoDowngrade && !serverOk) {
      process.stdout.write("自动降级到轻量模型...\n");
      await cmdStop();
      await sleep(2000);
      await cmdStart("8b");
    }
  } else {
    process.stdout.write("✓ 所有服务正常\n");
  }
}

// ------------------------------------------------------------------ 模型管理命令

function cmdModelList(): number {
  process.stdout.write("可用模型\n\n");
  const f = join(mlxHome(), "models.json");
  if (!existsSync(f)) die("models.json 不存在");
  const cat = readCatalog();
  for (const [key, info] of Object.entries(cat)) {
    const downloaded = existsSync(join(models(), info.name));
    const status = downloaded ? "[✓]" : "[ ]";
    process.stdout.write(`  ${status} ${(info.alias ?? key).padEnd(12)} ${info.name.padEnd(45)} ${(info.size ?? "?").padEnd(8)} ${info.description ?? ""}\n`);
  }
  process.stdout.write("\n状态: [✓] 已下载  [ ] 未下载\n");
  return 0;
}

function cmdModelInfo(key: string): number {
  const modelDir = modelDirFor(key);
  if (!modelDir) die(`未知模型别名: ${key}`);
  const dir = join(models(), modelDir);
  if (!existsSync(dir)) {
    process.stdout.write(`模型目录不存在: ${dir}\n使用 'mlx-local model download ${key}' 下载\n`);
    return 1;
  }
  process.stdout.write(`模型信息: ${key}\n────────────────────────────────────────────────\n  目录: ${dir}\n`);
  const files = readdirSync(dir, { recursive: true }).filter((f) => typeof f === "string" && statSync(join(dir, f as string)).isFile());
  process.stdout.write(`  文件数: ${files.length}\n  总大小: ${humanSize(dir)}\n  模型文件:\n`);
  const weights = readdirSync(dir).filter((f) => /\.(safetensors|gguf|mlx)$/.test(f));
  for (const f of weights) process.stdout.write(`    - ${f} (${humanSize(join(dir, f))})\n`);
  return 0;
}

function cmdModelDownload(key: string): number {
  const modelDir = modelDirFor(key);
  if (!modelDir) die(`未知模型别名: ${key}`);
  const target = join(models(), modelDir);
  if (existsSync(target)) {
    process.stdout.write(`模型目录已存在: ${target}\n如需重新下载，请先删除: mlx-local model remove ${key}\n`);
    return 0;
  }

  const info = readCatalog()[key];
  if (!info) die(`未知模型: ${key}`);
  const hfRepo = info.huggingface;
  if (!hfRepo) die(`models.json 缺少 huggingface 字段: ${key}`);
  if (info.size_warning) process.stdout.write(`WARNING:${info.size_warning}\n`);

  process.stdout.write(`下载模型: ${key} (${hfRepo})\n目标目录: ${target}\n\n`);

  // huggingface 下载属 MLX 生态，保留 venv python 执行
  const r = spawnSync(join(venv(), "bin", "python"), ["-c", `
import sys
from huggingface_hub import snapshot_download
try:
    path = snapshot_download(${JSON.stringify(hfRepo)}, local_dir=${JSON.stringify(target)}, resume_download=True, max_workers=4)
    print(f'下载完成: {path}')
except Exception as e:
    print(f'下载失败: {e}', file=sys.stderr)
    sys.exit(1)
`], { stdio: "inherit" });
  if (r.status === 0) log(`模型下载完成: ${modelDir}`);
  else die(`模型下载失败（退出码: ${r.status ?? 1}）`);
  return 0;
}

async function cmdModelRemove(key: string): Promise<number> {
  const info = readCatalog()[key];
  if (!info) die(`未知模型: ${key}`);
  const modelName = info.name;
  const dir = join(models(), modelName);
  if (!existsSync(dir)) {
    process.stdout.write(`模型目录不存在: ${dir}\n`);
    return 1;
  }
  const currentKey = existsSync(join(state(), "current_model")) ? readFileSync(join(state(), "current_model"), "utf8").trim() : "";
  if (currentKey === key) die("不能删除正在使用的模型，请先切换到其他模型");

  process.stdout.write(`将删除模型: ${key} (${modelName})\n目录: ${dir}\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm: string = await new Promise((res) => rl.question("确认删除？(y/N): ", res));
  rl.close();
  if (!/^[Yy]$/.test(confirm)) {
    process.stdout.write("已取消\n");
    return 0;
  }
  rmSync(dir, { recursive: true, force: true });
  log(`模型已删除: ${modelName}`);
  return 0;
}

// ------------------------------------------------------------------ 日志 / 监控

function cmdLogs(type: string): number {
  const map: Record<string, string> = { server: "server.log", s: "server.log", proxy: "unified_proxy.log", p: "unified_proxy.log" };
  const f = map[type];
  if (!f) {
    process.stdout.write("用法: mlx-local logs [server|proxy]\n");
    return 1;
  }
  const child = spawn("tail", ["-f", join(logs(), f)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  return 0;
}

function countLogRequests(): number {
  try {
    const txt = readFileSync(join(logs(), "server.log"), "utf8");
    return txt.split("POST /v1/chat/completions").length - 1;
  } catch {
    return 0;
  }
}

async function cmdMetrics(intervalSec: number, count: number): Promise<void> {
  process.stdout.write(`性能监控（按 Ctrl+C 停止）\n刷新间隔: ${intervalSec}s\n\n`);
  const currentKey = existsSync(join(state(), "current_model")) ? readFileSync(join(state(), "current_model"), "utf8").trim() : "未知";

  let prevRequests = 0;
  let iteration = 0;

  for (;;) {
    iteration++;
    const serverPid = portPid(SERVER_PORT);
    const proxyPid = portPid(UNIFIED_PORT);

    let serverCpu = "0", serverMem = "0";
    if (serverPid) {
      serverCpu = (spawnSync("ps", ["-p", String(serverPid), "-o", "%cpu="], { encoding: "utf8" }).stdout || "0").trim() || "0";
      serverMem = (spawnSync("ps", ["-p", String(serverPid), "-o", "%mem="], { encoding: "utf8" }).stdout || "0").trim() || "0";
    }

    let memTotal = "?", memUsed = "?";
    if (spawnSync("sh", ["-c", "command -v vm_stat"], { stdio: "ignore" }).status === 0) {
      const t = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout.trim();
      if (t) memTotal = (Number(t) / 1024 ** 3).toFixed(1);
      const mp = spawnSync("sh", ["-c", "memory_pressure | grep 'System-wide memory' | awk '{print $5}' | tr -d '%'"], { encoding: "utf8" }).stdout.trim();
      memUsed = mp || "0";
    }

    const currentRequests = countLogRequests();
    const rps = iteration > 1 ? ((currentRequests - prevRequests) / intervalSec).toFixed(1) : "0.0";
    prevRequests = currentRequests;

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(
      `MLX 性能监控\n` +
      `══════════════════════════════════════════════════════════════════════════════\n` +
      `  模型: ${currentKey}\n` +
      `  服务: server=${serverPid ? "✓" : "✗"} unified_proxy=${proxyPid ? "✓" : "✗"}\n` +
      `──────────────────────────────────────────────────────────────────────────────\n` +
      `  推理服务 (PID: ${serverPid ?? "无"})\n` +
      `    CPU: ${serverCpu}%    内存: ${serverMem}%\n` +
      `──────────────────────────────────────────────────────────────────────────────\n` +
      `  请求统计\n` +
      `    总请求数: ${currentRequests}    请求速率: ${rps}/s\n` +
      `──────────────────────────────────────────────────────────────────────────────\n` +
      `  系统内存\n` +
      `    总计: ${memTotal}GB    使用率: ${memUsed}%\n` +
      `══════════════════════════════════════════════════════════════════════════════\n` +
      `  按 Ctrl+C 停止    刷新: ${intervalSec}s    迭代: ${iteration}\n`,
    );

    if (count > 0 && iteration >= count) break;
    await sleep(intervalSec * 1000);
  }
}

// ------------------------------------------------------------------ 切换模型 / 帮助

async function cmdUse(key: string): Promise<number> {
  if (!key) die("用法: mlx-local use <模型别名>");
  const modelDir = modelDirFor(key);
  if (!modelDir) die(`未知模型别名: ${key}`);
  const currentKey = existsSync(join(state(), "current_model")) ? readFileSync(join(state(), "current_model"), "utf8").trim() : "";
  if (currentKey === key) {
    process.stdout.write(`当前已是模型: ${key}\n`);
    return 0;
  }
  process.stdout.write(`切换模型: ${currentKey} -> ${key}\n`);
  if (portPid(SERVER_PORT)) {
    await cmdStop();
    await sleep(2000);
    return cmdStart(key);
  }
  writeFileSync(join(state(), "current_model"), key);
  log(`模型设置已保存: ${key}`);
  return 0;
}

const USAGE = `用法: mlx-local <命令> [参数]

启动与停止:
  start [模型别名]           启动服务（默认14b）
  stop                       停止所有服务
  restart [模型别名]         重启服务

状态与诊断:
  status                     查看服务状态
  doctor                     健康检查
  healthcheck                健康检查（自动恢复）

模型管理:
  model list                 列出模型
  model info <别名>          查看模型详情
  model download <别名>      下载模型
  model remove <别名>        删除模型

监控与日志:
  metrics [间隔] [次数]      性能监控
  logs [server|proxy]        查看日志

可用模型:
  14b          Qwen3-14B-4bit         7.8G   默认模型
  8b           Qwen3-8B-4bit          4.3G   轻量快速
  30b          Qwen3-Coder-30B-A3B    16G    代码专精
  qwen-vl-8b   Qwen3-VL-8B            5.5G   视觉语言

示例:
  mlx-local start 14b       启动14B模型
  mlx-local use 8b          切换到8B模型
  mlx-local status          查看状态
  mlx-local metrics         性能监控
  mlx-local logs server     查看推理日志`;

export async function runMlxCmd(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "status";
  const rest = argv.slice(1);
  let code = 0;

  switch (cmd) {
    case "start": code = await cmdStart(rest[0] || DEFAULT_KEY); break;
    case "stop": await cmdStop(); break;
    case "restart": {
      await cmdStop();
      await sleep(2000);
      code = await cmdStart(rest[0] || DEFAULT_KEY);
      break;
    }
    case "status": await cmdStatus(); break;
    case "use": code = await cmdUse(rest[0] ?? ""); break;
    case "logs": code = cmdLogs(rest[0] ?? "server"); break;
    case "doctor": code = cmdDoctor(); break;
    case "healthcheck": {
      const flags = new Set(rest);
      if (rest.some((a) => !a.startsWith("--") || !["--auto-restart", "--auto-downgrade"].includes(a))) {
        const bad = rest.find((a) => !a.startsWith("--") || !["--auto-restart", "--auto-downgrade"].includes(a));
        die(`未知参数: ${bad}`);
      }
      await cmdHealthcheck(flags.has("--auto-restart"), flags.has("--auto-downgrade"));
      break;
    }
    case "model": {
      const action = rest[0] ?? "list";
      const key = rest[1] ?? "";
      if (action === "list") code = cmdModelList();
      else if (action === "info") { if (!key) die("用法: mlx-local model info <模型别名>"); code = cmdModelInfo(key); }
      else if (action === "download") { if (!key) die("用法: mlx-local model download <模型别名>"); code = cmdModelDownload(key); }
      else if (action === "remove") { if (!key) die("用法: mlx-local model remove <模型别名>"); code = await cmdModelRemove(key); }
      else die(`未知操作: ${action} (可用: list, info, download, remove)`);
      break;
    }
    case "metrics": {
      const interval = Number(rest[0] ?? 1);
      const count = Number(rest[1] ?? 0);
      if (!(interval > 0)) die(`刷新间隔必须为正数`);
      await cmdMetrics(interval, count);
      break;
    }
    case "help": case "-h": case "--help": process.stdout.write(USAGE + "\n"); break;
    default: {
      process.stderr.write(`[mlx] 错误: 未知命令 ${cmd}\n\n${USAGE}\n`);
      process.exit(1);
    }
  }
  if (code) process.exitCode = code;
}

