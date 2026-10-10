/**
 * gameqa/executors.ts — Agent 侧非 Unity 执行器（Rust unitylogs.rs / adb.rs 移植）
 *   unity_log_scan   ：Unity Player.log / 自定义日志的错误与异常扫描
 *   device_inventory ：ADB 设备清单与关键属性
 * 纯文本/命令行实现，无第三方依赖。adb 可通过 ADB_PATH 覆盖可执行文件（测试用）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Json, Job } from "./store.js";
import { outcomeFailure, type Outcome } from "./outcome.js";
import { runAirtestScript } from "./airtest.js";
import { runGamePerf } from "./gameperf.js";
import { runAiExploratory } from "./ai.js";

export { outcomeFailure, type Outcome } from "./outcome.js";

// ---------- ADB（实现见 adb.ts） ----------

import { adbBase, adbOutput, adbShell } from "./adb.js";
export { adbBase, adbOutput, adbShell };

// ---------- unity_log_scan ----------

/** 各平台 Unity Player.log 默认路径 */
export function defaultPlayerLog(platform: string): string | null {
  const home = process.env["HOME"];
  const localAppData = process.env["LOCALAPPDATA"];
  if (platform === "mac" && home) return path.join(home, "Library/Logs/Unity/Player.log");
  if (platform === "linux" && home) return path.join(home, ".config/unity3d/Player.log");
  if (platform === "windows" && localAppData) return path.join(localAppData, "Low");
  return null;
}

/** 扫描日志文本：统计 Error/Exception/Fatal 行 */
export function scanLogText(text: string): { count: number; details: string[]; exceptions: number } {
  const details: string[] = [];
  let exceptions = 0;
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\s+$/, "");
    const isError = line.includes("Error") || line.includes("error");
    const isException = line.includes("Exception") || line.includes("exception");
    const isFatal = line.includes("Fatal") || line.includes("abort");
    if (isError || isException || isFatal) {
      details.push(`L${String(idx + 1)}: ${Array.from(line).slice(0, 240).join("")}`);
      if (isException || isFatal) exceptions++;
    }
  }
  return { count: details.length, details, exceptions };
}

const LOG_SCAN_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 可选路径白名单（fix #126）：env 未设置 → 恒放行（默认行为完全不变）；
 * 设置后（冒号/逗号分隔多前缀）→ 路径 resolve 后必须等于或位于任一前缀之下（前缀边界用 path.sep，防 /a-b 逃逸 /a）。
 */
export function pathAllowed(value: string, envVar: string): boolean {
  const spec = (process.env[envVar] ?? "").trim();
  if (spec === "") return true;
  const target = path.resolve(value);
  const roots = spec
    .split(/[,:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  if (roots.length === 0) return true;
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

/** unity_log_scan：extra.log_path 优先，缺省用平台 Player.log；extra.max_errors 阈值 */
export function runLogScan(job: Job, workdir: string): Outcome {
  const extra = (job["extra"] ?? {}) as Record<string, Json>;
  const platform = typeof job["platform"] === "string" ? job["platform"] : "mac";

  const explicit = typeof extra["log_path"] === "string" ? extra["log_path"] : null;
  if (explicit !== null && !pathAllowed(explicit, "GAMEQA_SAFE_PATHS")) {
    return outcomeFailure(`extra.log_path 不在白名单 GAMEQA_SAFE_PATHS 内: ${explicit}`);
  }
  const p = explicit ?? defaultPlayerLog(platform);
  if (p === null) {
    return outcomeFailure("无法确定日志路径，请通过 extra.log_path 显式指定");
  }
  if (!fs.existsSync(p)) {
    return outcomeFailure(`日志文件不存在: ${p}`, {
      hint: "Unity Player 首次运行前日志不存在；或用 extra.log_path 指定自定义日志",
    });
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    throw new Error(`读取日志失败: ${(err as Error).message}`);
  }
  if (buf.length > LOG_SCAN_MAX_BYTES) {
    buf = buf.subarray(buf.length - LOG_SCAN_MAX_BYTES);
  }
  const { count, details, exceptions } = scanLogText(buf.toString("utf-8"));

  const maxErrors = typeof extra["max_errors"] === "number" ? extra["max_errors"] : 0;
  const success = count <= maxErrors;
  const message = success
    ? `日志扫描通过（${String(count)} 条错误/异常，阈值 ${String(maxErrors)}）`
    : `日志扫描未通过（${String(count)} 条错误/异常 > 阈值 ${String(maxErrors)}；Exception ${String(exceptions)} 条）`;

  fs.mkdirSync(workdir, { recursive: true });
  const artifact = details.join("\n");
  fs.writeFileSync(path.join(workdir, "log_errors.txt"), artifact, "utf-8");

  return {
    success,
    logPath: p,
    summary: { message, log: p, error_count: count, exceptions, threshold: maxErrors },
    artifacts: [["log_errors.txt", artifact]],
  };
}

// ---------- device_inventory ----------

/** device_inventory：枚举 adb 设备并采集型号/Android 版本/分辨率/电量 */
export function runDeviceInventory(workdir: string): Outcome {
  const list = adbOutput(adbBase());
  const devices: Record<string, Json>[] = [];
  for (const line of list.split("\n").slice(1)) {
    const it = line.trim().split(/\s+/);
    const serial = it[0];
    const state = it[1];
    if (serial === undefined || state === undefined || serial === "") continue;
    if (state !== "device") {
      devices.push({ serial, state, note: "不可用" });
      continue;
    }
    const wmSize = adbShell(serial, "wm size");
    const resolution =
      wmSize
        .split("\n")
        .find((l) => l.includes("size"))
        ?.split(":")[1]
        ?.trim() ?? "?";
    const battery =
      adbShell(serial, "dumpsys battery")
        .split("\n")
        .find((l) => l.includes("level"))
        ?.split(":")[1]
        ?.trim() ?? "?";
    const model = adbShell(serial, "getprop ro.product.model");
    const brand = adbShell(serial, "getprop ro.product.brand");
    devices.push({
      serial,
      state,
      online: true,
      model: `${brand} ${model}`.trim(),
      android: adbShell(serial, "getprop ro.build.version.release"),
      resolution,
      battery,
    });
  }

  const online = devices.filter((d) => d["online"] === true).length;
  fs.mkdirSync(workdir, { recursive: true });
  const invPath = path.join(workdir, "devices.json");
  const text = JSON.stringify(devices, null, 2);
  fs.writeFileSync(invPath, text, "utf-8");

  return {
    success: true,
    logPath: invPath,
    summary: { message: `设备清单：共 ${String(devices.length)} 台，在线 ${String(online)} 台`, devices, online },
    artifacts: [["devices.json", text]],
  };
}

/** 产物收集（Rust collect_artifacts 对齐：按 job_type 从 workdir 取文本，尾部截断 64KB） */
export function collectArtifacts(jobType: string, workdir: string): [string, string][] {
  const files: [string, string][] = [];
  const push = (name: string, p: string): void => {
    try {
      const buf = fs.readFileSync(p);
      files.push([name, buf.length > 64 * 1024 ? buf.subarray(buf.length - 64 * 1024).toString("utf-8") : buf.toString("utf-8")]);
    } catch {
      /* 文件不存在 */
    }
  };
  if (jobType === "ai_exploratory") push("steps.json", path.join(workdir, "steps.json"));
  if (jobType === "airtest") {
    push("airtest_stdout.log", path.join(workdir, "airtest_stdout.log"));
    push("airtest_stderr.log", path.join(workdir, "airtest_stderr.log"));
  }
  return files;
}

/**
 * 非 Unity job_type 分发入口；返回 null 表示未命中（调用方走占位逻辑）。
 * 执行异常统一转结构化失败，不向上抛。
 */
export async function executeAgentJobType(
  jobType: string,
  job: Job,
  workdir: string,
): Promise<Outcome | null> {
  try {
    switch (jobType) {
      case "unity_log_scan":
        return runLogScan(job, workdir);
      case "device_inventory":
        return runDeviceInventory(workdir);
      case "airtest": {
        const out = await runAirtestScript(job, typeof job["platform"] === "string" ? job["platform"] : "", workdir);
        out.artifacts = [...out.artifacts, ...collectArtifacts("airtest", workdir)];
        return out;
      }
      case "game_perf":
        return runGamePerf(job, workdir);
      case "ai_exploratory": {
        const out = await runAiExploratory(job, typeof job["platform"] === "string" ? job["platform"] : "", workdir);
        out.artifacts = [...out.artifacts, ...collectArtifacts("ai_exploratory", workdir)];
        return out;
      }
      default:
        return null;
    }
  } catch (err) {
    return outcomeFailure("集成执行异常", { error: (err as Error).message, job_type: jobType });
  }
}

