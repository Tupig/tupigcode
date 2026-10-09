/**
 * cli/agentLocal.ts — 本地 agent 包装器公共启动流程（claude/codex/opencode-local）
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { execReplace, ensureService, die } from "./common.js";

export type AgentSpec = {
  /** 展示名，用于日志前缀 */
  name: string;
  /** 必须存在的文件（缺失即退出） */
  checkFiles?: string[];
  /** codex 类：GPU 上限未提升时打印提示 */
  gpuWarning?: boolean;
  /** 服务 start 参数（模型别名等） */
  startArgs?: string[];
  /** 等待端口就绪秒数 */
  waitSeconds?: number;
  /** 实际要 exec 的命令与参数 */
  exec: () => { cmd: string; args: string[] };
};

const PORT = Number(process.env.MLX_UNIFIED_PORT ?? 4100);

function printGpuWarning(name: string): void {
  const r = spawnSync("sysctl", ["-n", "iogpu.wired_limit_mb"], { encoding: "utf-8" });
  const val = (r.stdout || "0").trim();
  if (val && val !== "0") return;
  process.stderr.write(
    `[${name}] 提示: codex 单个请求约 5.3 万 token，在 24GB 机器上很可能触发\n` +
      `[${name}]       [METAL] Insufficient Memory。如遇失败：\n` +
      `[${name}]         1) 提高 GPU 上限后重试: sudo sysctl iogpu.wired_limit_mb=21504\n` +
      `[${name}]         2) 改用 opencode-local / claude-local（prompt 小得多）\n`,
  );
}

export async function launchAgent(spec: AgentSpec): Promise<void> {
  for (const f of spec.checkFiles ?? []) {
    if (!existsSync(f)) die(spec.name, `配置文件缺失：${f}`);
  }
  if (spec.gpuWarning) printGpuWarning(spec.name);

  await ensureService(spec.name, PORT, spec.startArgs ?? [], spec.waitSeconds ?? 60);

  const { cmd, args } = spec.exec();
  execReplace(spec.name, cmd, args);
}
