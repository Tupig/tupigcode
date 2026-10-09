#!/usr/bin/env node
/**
 * cli/opencode-local.ts — 用本地 MLX 模型运行 opencode（原 bin/opencode-local）
 */
import { launchAgent } from "./agent-local.js";
import { die } from "./common.js";

launchAgent({
  name: "opencode-local",
  startArgs: ["14b"],
  waitSeconds: 60,
  exec: () => ({
    cmd: "opencode",
    args: ["-m", "local-mlx/default_model", ...process.argv.slice(2)],
  }),
}).catch((e) => die("opencode-local", e instanceof Error ? e.message : String(e)));
