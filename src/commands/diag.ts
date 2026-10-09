/**
 * diag/index.ts — /doctor 体检、/init 生成 AGENTS.md、/review 评审 prompt（N11 / A22）
 */
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "fs";
import { listTrust } from "../engine/hook-trust.js";
import { join } from "path";
import { resolveProvider, resolveModel } from "../services/api.js";
import { getDefaultTools } from "../engine/tool-registry.js";
import { loadSkills } from "../knowledge/skills.js";
import { parseAgentFile } from "../agents/agents.js";
import { MAX_CONTEXT_TOKENS } from "../engine/constants.js";

export type CheckLevel = "ok" | "warn" | "error";
export type CheckResult = { id: string; level: CheckLevel; label: string; detail?: string };

const AGENTS_ROOT = (w: string) => join(w, ".tupigcode", "agents");

function duplicateNames(pairs: Array<[string, string]>): string[] {
  const seen = new Map<string, number>();
  for (const [name] of pairs) seen.set(name, (seen.get(name) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

function scanAgentNames(workDir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const root of [AGENTS_ROOT(workDir), join(process.env.HOME ?? "", ".tupigcode", "agents")]) {
    if (!existsSync(root)) continue;
    try {
      for (const e of readdirSync(root)) {
        if (!e.endsWith(".md")) continue;
        try {
          const def = parseAgentFile(readFileSync(join(root, e), "utf-8"), e.replace(/\.md$/, ""));
          if (def) out.push([def.name, join(root, e)]);
        } catch {}
      }
    } catch {}
  }
  return out;
}

export function runDoctor(workDir: string, env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  const out: CheckResult[] = [];

  // workdir
  try {
    statSync(workDir);
    out.push({ id: "workdir", level: "ok", label: "工作目录", detail: workDir });
  } catch {
    out.push({ id: "workdir", level: "error", label: "工作目录", detail: `不可访问：${workDir}` });
  }

  // provider
  try {
    const kind = resolveProvider(env as NodeJS.ProcessEnv);
    out.push({ id: "provider", level: "ok", label: "模型 Provider", detail: `${kind} / ${env.TUPIG_MODEL || resolveModel(env as NodeJS.ProcessEnv)}` });
  } catch (e) {
    out.push({ id: "provider", level: "error", label: "模型 Provider", detail: e instanceof Error ? e.message : String(e) });
  }

  // 配置项
  const cfgIssues: string[] = [];
  if (env.TUPIG_HARNESS && !["xml", "native", "off", "auto"].includes(env.TUPIG_HARNESS)) {
    cfgIssues.push(`TUPIG_HARNESS 非法：${env.TUPIG_HARNESS}`);
  }
  if (env.TUPIG_MAX_CONTEXT_TOKENS && !/^\d+$/.test(env.TUPIG_MAX_CONTEXT_TOKENS)) {
    cfgIssues.push(`TUPIG_MAX_CONTEXT_TOKENS 非数字：${env.TUPIG_MAX_CONTEXT_TOKENS}`);
  }
  out.push({
    id: "config",
    level: cfgIssues.length ? "warn" : "ok",
    label: "环境配置",
    detail: cfgIssues.length ? cfgIssues.join("；") : `harness=${env.TUPIG_HARNESS || "auto"} 上下文=${MAX_CONTEXT_TOKENS}`,
  });

  // 工具
  try {
    const tools = getDefaultTools();
    const bad = tools.filter((t) => !t.name || !t.inputSchema);
    out.push({
      id: "tools",
      level: bad.length ? "error" : "ok",
      label: "默认工具集",
      detail: bad.length ? `异常工具：${bad.map((t) => t.name || "?").join(",")}` : `${tools.length} 个工具 schema 完整`,
    });
  } catch (e) {
    out.push({ id: "tools", level: "error", label: "默认工具集", detail: String(e) });
  }

  // 技能（重复名）
  try {
    const skills = loadSkills(workDir);
    const dups = duplicateNames(skills.map((s) => [s.name, s.dir] as [string, string]));
    out.push({
      id: "skill-dup",
      level: dups.length ? "warn" : "ok",
      label: "技能重名",
      detail: dups.length ? `重名：${dups.join(", ")}（后者覆盖前者）` : `${skills.length} 个技能无重名`,
    });
  } catch (e) {
    out.push({ id: "skill-dup", level: "warn", label: "技能重名", detail: String(e) });
  }

  // 子代理（重复名）
  const agentPairs = scanAgentNames(workDir);
  const agentDups = duplicateNames(agentPairs);
  out.push({
    id: "agent-dup",
    level: agentDups.length ? "warn" : "ok",
    label: "子代理重名",
    detail: agentDups.length ? `重名：${agentDups.join(", ")}（后者覆盖前者）` : `${agentPairs.length} 个 agent 文件无重名`,
  });

  // hooks
  const hooksFile = join(workDir, ".tupigcode", "hooks.json");
  if (!existsSync(hooksFile)) {
    out.push({ id: "hooks", level: "ok", label: "Hooks 配置", detail: "未配置（.tupigcode/hooks.json 不存在）" });
  } else {
    try {
      JSON.parse(readFileSync(hooksFile, "utf-8"));
      out.push({ id: "hooks", level: "ok", label: "Hooks 配置", detail: "hooks.json 可解析" });
    } catch (e) {
      out.push({ id: "hooks", level: "warn", label: "Hooks 配置", detail: `hooks.json 解析失败：${e instanceof Error ? e.message : e}` });
    }
  }

  // hook 信任清单（TOFU，issue #20）
  try {
    const trust = listTrust(workDir);
    out.push({
      id: "hook-trust",
      level: "ok",
      label: "Hook 信任",
      detail: trust.length
        ? `已信任 ${trust.length} 条：${trust.map((t) => t.command.slice(0, 40)).join(" | ")}（/hooks clear 清除）`
        : "暂无信任记录（hook 首次触发时询问）",
    });
  } catch (e) {
    out.push({ id: "hook-trust", level: "warn", label: "Hook 信任", detail: String(e) });
  }

  // 缓存体积
  const cacheFile = join(workDir, ".tupigcode", "cache", "repomap.json");
  if (existsSync(cacheFile)) {
    try {
      const mb = statSync(cacheFile).size / (1024 * 1024);
      out.push({
        id: "cache",
        level: mb > 5 ? "warn" : "ok",
        label: "repo 地图缓存",
        detail: `${mb.toFixed(2)} MB${mb > 5 ? "（>5MB，建议删 .tupigcode/cache 重建）" : ""}`,
      });
    } catch {
      out.push({ id: "cache", level: "ok", label: "repo 地图缓存", detail: "不可读" });
    }
  } else {
    out.push({ id: "cache", level: "ok", label: "repo 地图缓存", detail: "尚未生成" });
  }

  // git
  out.push({
    id: "git",
    level: existsSync(join(workDir, ".git")) ? "ok" : "warn",
    label: "Git 仓库",
    detail: existsSync(join(workDir, ".git")) ? "已检测到 .git" : "非 git 仓库（checkpoint/review 能力受限）",
  });

  return out;
}

export function renderDoctor(results: CheckResult[]): string {
  const symbol: Record<CheckLevel, string> = { ok: "✓", warn: "!", error: "✗" };
  const order: Record<CheckLevel, number> = { error: 0, warn: 1, ok: 2 };
  const sorted = [...results].sort((a, b) => order[a.level] - order[b.level]);
  const counts = { error: 0, warn: 0, ok: 0 };
  for (const r of results) counts[r.level]++;

  const lines = sorted.map((r) => `  ${symbol[r.level]} ${r.label}${r.detail ? `：${r.detail}` : ""}`);
  return [
    "# 体检报告",
    "",
    ...lines,
    "",
    `摘要：${counts.error} error / ${counts.warn} warn / ${counts.ok} ok`,
  ].join("\n");
}

export function initAgentMd(
  workDir: string,
  opts: { force?: boolean } = {},
): { path: string; created: boolean; content: string } {
  const path = join(workDir, "AGENTS.md");
  if (existsSync(path) && !opts.force) throw new Error("AGENTS.md 已存在（用 force 覆盖）");

  let name = "";
  let version = "";
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(workDir, "package.json"), "utf-8"));
    name = pkg.name || "";
    version = pkg.version || "";
    scripts = pkg.scripts || {};
  } catch {}

  const hasPytest =
    existsSync(join(workDir, "pytest.ini")) ||
    existsSync(join(workDir, "pyproject.toml")) ||
    existsSync(join(workDir, "setup.cfg")) ||
    existsSync(join(workDir, "tox.ini"));

  let dirs: string[] = [];
  try {
    dirs = readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "venv"].includes(e.name))
      .map((e) => e.name + "/");
  } catch {}

  const commands: string[] = [];
  if (scripts.test) commands.push("- 测试：`npm test`");
  if (scripts.build) commands.push("- 构建：`npm run build`");
  if (scripts.dev) commands.push("- 开发：`npm run dev`");
  if (hasPytest) commands.push("- Python 测试：`pytest`");
  if (commands.length === 0) commands.push("- （未发现 package.json scripts，补充常用命令）");

  const content = [
    `# AGENTS.md${name ? ` — ${name}${version ? `@${version}` : ""}` : ""}`,
    "",
    "> 本文件由 `/init` 生成，请按项目实际情况修订；保持精简，领域知识放 skill。",
    "",
    "## 常用命令",
    ...commands,
    "",
    "## 目录概览",
    dirs.length ? dirs.map((d) => `- ${d}`).join("\n") : "- （无可列目录）",
    "",
    "## 约定",
    "- 修改前先读取相邻代码，遵循现有风格",
    "- 不添加不必要的注释",
    "- 项目状态与计划落 `.tupigcode/specs/`（`/spec new`），技能放 `.tupigcode/skills/`，子代理定义放 `.tupigcode/agents/`",
    "",
  ].join("\n");

  writeFileSync(path, content);
  return { path, created: true, content };
}

export const REVIEW_DIFF_BUDGET = 12_000;

/** /review 的 ref 白名单（防 shell 注入）：git rev 简化字符集 */
export function isValidRef(ref: string): boolean {
  return /^[A-Za-z0-9_.\/~^@{}-]+$/.test(ref);
}

export function buildReviewPrompt(diff: string): string {
  if (!diff.trim()) {
    return "没有可评审的改动（工作区与暂存区均无 diff）。";
  }
  let body = diff;
  let truncated = false;
  if (body.length > REVIEW_DIFF_BUDGET) {
    body = body.slice(0, REVIEW_DIFF_BUDGET);
    truncated = true;
  }
  return [
    "你是只读代码评审员。**只报告问题，不修改任何文件、不执行命令**。",
    "按优先级输出 findings，每条格式：`P0|P1|P2 文件:行 — 问题 — 建议`；无问题则输出「无发现」。",
    "关注：正确性、边界、错误路径、安全（注入/路径逃逸/命令盲执行）、与 AGENTS.md 约定冲突。",
    "",
    "<diff>",
    body,
    truncated ? "\n…（diff 超预算已截断，如需评审其余部分请指定文件）" : "",
    "</diff>",
  ].join("\n");
}
