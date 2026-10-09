#!/usr/bin/env node
/**
 * cli/codex-local.ts — 用本地 MLX 模型运行 Codex CLI（原 bin/codex-local）
 */
import { launchAgent } from "./agent-local.js";
import { die } from "./common.js";

launchAgent({
  name: "codex-local",
  gpuWarning: true,
  startArgs: ["14b"],
  waitSeconds: 90,
  exec: () => ({ cmd: "codex", args: ["--profile", "local", ...process.argv.slice(2)] }),
}).catch((e) => die("codex-local", e instanceof Error ? e.message : String(e)));
