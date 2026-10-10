/**
 * gameqa/gameperf.ts — 游戏性能测试：帧率 / 卡顿 / 内存（Rust gameperf.rs 移植）
 * Android，dumpsys gfxinfo + meminfo：可选拉起应用 → 重置帧统计 → 采样窗口 → 阈值断言。
 * 纯解析函数（parseGfxinfo / parseMeminfoTotal）可单测。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Json, Job } from "./store.js";
import { adbBase, adbOutput, adbShell } from "./adb.js";
import { outcomeFailure, type Outcome } from "./outcome.js";

export interface GfxStats {
  frames: number;
  janky: number;
  jank_pct: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

function splitPercentile(line: string): [number, number] | null {
  const idx = line.indexOf("th percentile");
  if (idx < 0) return null;
  const label = parseInt(line.slice(0, idx).trim(), 10);
  if (Number.isNaN(label)) return null;
  const rest = line.slice(idx).split(":")[1];
  if (rest === undefined) return null;
  const v = parseInt(rest.trim().replace(/ms$/, "").trim(), 10);
  if (Number.isNaN(v)) return null;
  return [label, v];
}

/** 解析 `dumpsys gfxinfo <pkg>` 摘要 */
export function parseGfxinfo(text: string): GfxStats {
  const stats: GfxStats = { frames: 0, janky: 0, jank_pct: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Total frames rendered:")) {
      stats.frames = parseInt(line.slice("Total frames rendered:".length).trim(), 10) || 0;
    } else if (line.startsWith("Janky frames:")) {
      // 形如 "5 (4.76%)"
      const rest = line.slice("Janky frames:".length).trim();
      const parts = rest.split(/\s+/);
      stats.janky = parseInt(parts[0] ?? "", 10) || 0;
      const pct = (parts[1] ?? "").replace(/^\(/, "").replace(/\)%?$/, "").replace("%", "");
      const p = parseFloat(pct);
      if (!Number.isNaN(p)) stats.jank_pct = p;
    } else {
      const pair = splitPercentile(line);
      if (pair) {
        const [label, v] = pair;
        if (label === 50) stats.p50 = v;
        else if (label === 90) stats.p90 = v;
        else if (label === 95) stats.p95 = v;
        else if (label === 99) stats.p99 = v;
      }
    }
  }
  return stats;
}

/** 解析 `dumpsys meminfo <pkg>` 的 TOTAL PSS（kB → MB） */
export function parseMeminfoTotal(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("TOTAL PSS:")) {
      const kb = parseFloat(line.slice("TOTAL PSS:".length).trim().split(/\s+/)[0] ?? "");
      if (Number.isNaN(kb)) return null;
      return kb / 1024.0;
    }
  }
  return null;
}

function adbGfxinfoArgs(serial: string | undefined, pkg: string): string[] {
  const args = adbBase(serial);
  args.push("shell", "dumpsys", "gfxinfo", pkg);
  return args;
}

function adbMeminfoArgs(serial: string | undefined, pkg: string): string[] {
  const args = adbBase(serial);
  args.push("shell", "dumpsys", "meminfo", pkg);
  return args;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** adb shell 参数白名单（fix #118：防设备端命令注入——禁 ;|&$`() 等 shell 元字符） */
const ADB_PARAM_SAFE = /^[A-Za-z0-9_./:-]+$/;

/** game_perf 主流程。extra: package / duration_s / launch_activity / max_jank_pct / min_fps / max_mem_mb / device_serial */
export async function runGamePerf(job: Job, workdir: string): Promise<Outcome> {
  const extra = (job["extra"] ?? {}) as Record<string, Json>;
  const pkg = (typeof extra["package"] === "string" ? (extra["package"] as string) : "").trim();
  if (pkg === "") {
    return outcomeFailure("缺少 extra.package（游戏包名，如 com.example.game）");
  }
  if (!ADB_PARAM_SAFE.test(pkg)) {
    return outcomeFailure("extra.package 含非法字符（仅允许字母/数字/._:-）");
  }

  const serialRaw = typeof extra["device_serial"] === "string" ? (extra["device_serial"] as string) : "";
  const serial = serialRaw !== "" ? serialRaw : process.env["ANDROID_SERIAL"] ?? "";
  const serialOpt = serial !== "" ? serial : undefined;

  const durationRaw = typeof extra["duration_s"] === "number" ? extra["duration_s"] : 30;
  const duration = Math.min(300, Math.max(5, Math.trunc(durationRaw)));
  const maxJankPct = typeof extra["max_jank_pct"] === "number" ? extra["max_jank_pct"] : 20.0;
  const minFps = typeof extra["min_fps"] === "number" ? extra["min_fps"] : 30.0;
  const maxMemMb = typeof extra["max_mem_mb"] === "number" ? extra["max_mem_mb"] : 0.0;

  // 可选：拉起游戏
  const launchAct = typeof extra["launch_activity"] === "string" ? (extra["launch_activity"] as string).trim() : "";
  if (launchAct !== "") {
    if (!ADB_PARAM_SAFE.test(launchAct)) {
      return outcomeFailure("extra.launch_activity 含非法字符（仅允许字母/数字/._:/-）");
    }
    try {
      adbShell(serialOpt, `am start -n ${launchAct}`);
    } catch (err) {
      return outcomeFailure(`拉起应用失败: ${(err as Error).message}`);
    }
    await sleep(3000);
  }

  // 重置帧统计，开始采样窗口（每秒采一次内存）
  try {
    adbShell(serialOpt, `dumpsys gfxinfo ${pkg} reset`);
  } catch (err) {
    return outcomeFailure(`重置帧统计失败: ${(err as Error).message}`);
  }

  const memSamples: number[] = [];
  for (let i = 0; i < duration; i++) {
    await sleep(1000);
    try {
      const out = adbOutput(adbMeminfoArgs(serialOpt, pkg));
      const mb = parseMeminfoTotal(out);
      if (mb !== null) memSamples.push(mb);
    } catch {
      /* 单次采样失败跳过 */
    }
  }

  let dumpText: string;
  try {
    dumpText = adbOutput(adbGfxinfoArgs(serialOpt, pkg));
  } catch (err) {
    return outcomeFailure(`采集帧统计失败: ${(err as Error).message}`);
  }
  const stats = parseGfxinfo(dumpText);

  const fps = duration > 0 ? stats.frames / duration : 0.0;
  const memAvg = memSamples.length === 0 ? 0.0 : memSamples.reduce((a, b) => a + b, 0) / memSamples.length;
  const memMax = memSamples.length === 0 ? 0.0 : Math.max(...memSamples);

  const jankOk = stats.jank_pct <= maxJankPct;
  const fpsOk = stats.frames > 0 && fps >= minFps;
  const memOk = maxMemMb <= 0.0 || memMax <= maxMemMb;
  const appRunning = stats.frames > 0;
  const success = jankOk && fpsOk && memOk && appRunning;

  let message: string;
  if (!appRunning) {
    message = "应用未运行（帧统计为 0），请确认包名与游戏已启动";
  } else {
    const parts = [
      `平均帧率 ${fps.toFixed(1)} FPS`,
      `卡顿率 ${stats.jank_pct.toFixed(1)}%（阈值 ${maxJankPct.toFixed(1)}%）`,
      `p95 帧耗时 ${String(stats.p95)}ms`,
      `内存峰值 ${memMax.toFixed(0)}MB`,
    ];
    if (!jankOk) parts.unshift("卡顿率超限");
    if (!fpsOk) parts.unshift("帧率低于下限");
    message = parts.join("，");
  }

  // 产物：原始 dumpsys 数据
  fs.mkdirSync(workdir, { recursive: true });
  const rawPath = path.join(workdir, "gfxinfo.txt");
  fs.writeFileSync(rawPath, dumpText, "utf-8");

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    success,
    logPath: rawPath,
    summary: {
      message,
      package: pkg,
      duration_s: duration,
      fps: round1(fps),
      frames: stats.frames,
      janky: stats.janky,
      jank_pct: stats.jank_pct,
      p50_ms: stats.p50,
      p95_ms: stats.p95,
      p99_ms: stats.p99,
      mem_avg_mb: round1(memAvg),
      mem_max_mb: round1(memMax),
      thresholds: { max_jank_pct: maxJankPct, min_fps: minFps, max_mem_mb: maxMemMb },
    },
    artifacts: [["gfxinfo.txt", dumpText]],
  };
}
