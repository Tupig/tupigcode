#!/usr/bin/env node
/**
 * cli/claude-local.ts — 用本地 MLX 模型运行 Claude Code（原 bin/claude-local）
 */
import { join } from "path";
import { launchAgent } from "./agent-local.js";
import { die } from "./common.js";

launchAgent({
  name: "claude-local",
  checkFiles: [join(process.env.HOME ?? "", ".claude", "settings-local.json")],
  startArgs: ["14b"],
  waitSeconds: 60,
  exec: () => ({
    cmd: "claude",
    args: ["--settings", join(process.env.HOME ?? "", ".claude", "settings-local.json"), ...process.argv.slice(2)],
  }),
}).catch((e) => die("claude-local", e instanceof Error ? e.message : String(e)));
