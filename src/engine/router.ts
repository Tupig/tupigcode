/**
 * router.ts — 双轨路由器：纯难度分流（默认）
 * 规则：显式 model 最高 > mock > 难度（hard+云→云，其余本地；本地上下文/并发策略选 14b/8b）
 * 决策写 routelog 供 I4 复盘。
 */
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { resolveProvider } from "../services/api.js";

export type RouteDecision = {
  model: string;
  provider: "local" | "cloud" | "mock";
  reason: string;
  contextTokens?: number;
};

/** 任务画像（A23）：kind 对齐 Continue 的模型角色制 */
export type TaskKind = "chat" | "edit" | "search" | "review" | "plan" | "summarize";
export type TaskProfile = { kind: TaskKind; difficulty: "easy" | "hard"; tokens: number };
export type ModelRole = "chat" | "apply" | "summarize";

const KIND_RULES: Array<[TaskKind, RegExp]> = [
  ["summarize", /总结|摘要|归纳|压缩上下文|summarize/i],
  ["review", /评审|代码审查|review|找茬|检查(这次|以下)?(改动|diff)/i],
  ["plan", /计划|方案|规划|设计(一个|下)|怎么(做|实现|办)|how (do|should) i/i],
  ["edit", /修复|修改|改成|删除|新增|实现|重构|写(一个|个|入)|迁移|fix|add|implement|refactor|rename/i],
  ["search", /^(找出|查找|搜索|搜|找|列|查)|grep|rg |在哪|哪里|哪些文件|list |find /i],
  ["chat", /解释|说明|什么是|explain/i],
];

export function profileTask(prompt: string, opts: { contextTokens?: number } = {}): TaskProfile {
  const p = prompt.trim();
  const kind = KIND_RULES.find(([, re]) => re.test(p))?.[0] ?? "chat";
  return { kind, difficulty: estimateDifficulty(p), tokens: opts.contextTokens ?? 0 };
}

/** 模型角色制：TUPIG_MODEL_<ROLE> > TUPIG_ROLE_MODELS(JSON) > 未配置 */
export function resolveRoleModel(role: ModelRole, env: NodeJS.ProcessEnv): string | undefined {
  const direct = env[`TUPIG_MODEL_${role.toUpperCase()}`];
  if (direct) return direct;
  const raw = env.TUPIG_ROLE_MODELS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const v = parsed?.[role];
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

function roleForKind(kind: TaskKind): ModelRole {
  if (kind === "edit") return "apply";
  if (kind === "summarize") return "summarize";
  return "chat";
}

const HARD_PATTERNS = [
  /重构/, /迁移/, /架构/, /重写/, /跨\s*\d*\s*个?文件/, /所有(调用|引用|文件)/,
  /实现.{0,12}(系统|服务|模块|框架)/, /设计并/, /整合/, /统一(错误|处理|重构)/,
  /refactor/i, /migrate/i, /redesign/i, /across\s+\w+\s+files/i,
];
const EASY_PATTERNS = [
  /^(读|看|列|查|搜|找|grep|cat|read|list|show|explain|解释|总结|说明)/i,
  /TODO|FIXME/, /什么(是|叫)/, /在哪|哪里|位置/,
];

export function estimateDifficulty(prompt: string): "easy" | "hard" {
  const p = prompt.trim();
  if (!p) return "easy";
  if (HARD_PATTERNS.some((r) => r.test(p))) return "hard";
  if (EASY_PATTERNS.some((r) => r.test(p))) return "easy";
  return p.length > 400 ? "hard" : "easy";
}

function isLocalBase(base: string | undefined): boolean {
  if (!base) return false;
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(base);
}

function providerFor(env: NodeJS.ProcessEnv): RouteDecision["provider"] {
  const kind = resolveProvider(env);
  if (kind === "mock") return "mock";
  if (kind === "openai" && isLocalBase(env.OPENAI_BASE_URL)) return "local";
  return "cloud";
}

export function routeTask(params: {
  prompt: string;
  model?: string;
  contextTokens?: number;
  env?: NodeJS.ProcessEnv;
  workDir?: string;
}): RouteDecision {
  const env = params.env ?? process.env;
  const ctx = params.contextTokens ?? 0;

  if (params.model) {
    return { model: params.model, provider: providerFor(env), reason: "显式指定 model", contextTokens: ctx };
  }
  if (env.TUPIG_MOCK === "1") {
    return { model: "mock", provider: "mock", reason: "TUPIG_MOCK", contextTokens: ctx };
  }

  const profile = profileTask(params.prompt, { contextTokens: ctx });
  const role = roleForKind(profile.kind);
  const roleModel = resolveRoleModel(role, env);
  if (roleModel) {
    return { model: roleModel, provider: providerFor(env), reason: `role:${role} env 覆盖`, contextTokens: ctx };
  }

  const provider = resolveProvider(env);
  const hasCloud = !!env.ANTHROPIC_API_KEY;
  const cloudModel = env.TUPIG_CLOUD_MODEL || "claude-sonnet-4-20250514";
  const diff = profile.difficulty;

  if (diff === "hard" && hasCloud) {
    return { model: cloudModel, provider: "cloud", reason: "hard+云端凭据", contextTokens: ctx };
  }
  if (diff === "hard" && !hasCloud) {
    return { model: "14b", provider: "local", reason: "hard-无云端凭据，回落本地", contextTokens: ctx };
  }

  if (provider === "openai" && isLocalBase(env.OPENAI_BASE_URL)) {
    const suggested = suggestModel(profile, params.workDir);
    if (suggested) {
      return { model: suggested, provider: "local", reason: `profile:${profile.kind}→${suggested}`, contextTokens: ctx };
    }
    if (ctx >= 14_000) return { model: "8b", provider: "local", reason: "easy-ctx>=14k→8b", contextTokens: ctx };
    return { model: "14b", provider: "local", reason: "easy-本地14b", contextTokens: ctx };
  }
  if (provider === "openai") {
    return { model: params.model || env.OPENAI_MODEL || "default_model", provider: "cloud", reason: "easy-云端 OpenAI 兼容网关", contextTokens: ctx };
  }
  return { model: cloudModel, provider: "cloud", reason: "easy-仅有云端 Anthropic", contextTokens: ctx };
}

export function formatRouteLog(
  d: RouteDecision & { prompt: string; ts?: number; kind?: TaskKind },
): string {
  const prompt = d.prompt.length > 100 ? d.prompt.slice(0, 100) + "…" : d.prompt;
  return JSON.stringify({
    ts: d.ts ?? Date.now(),
    type: "route",
    kind: d.kind,
    model: d.model, provider: d.provider, reason: d.reason,
    ctx: d.contextTokens ?? 0, prompt,
  });
}

/** routelog.jsonl 闭环（A23）：执行结果回填，供画像选型 */
export function appendRouteFeedback(
  workDir: string,
  f: { model: string; kind: TaskKind; success: boolean; oneShot: boolean; ts?: number },
): void {
  try {
    const dir = join(workDir, ".tupigcode");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "route.log"), JSON.stringify({ ts: f.ts ?? Date.now(), type: "feedback", ...f }) + "\n");
  } catch {
    /* routelog 失败不影响主流程 */
  }
}

export type KindStats = {
  feedback: number;
  oneShot: number;
  rate: number;
  byModel: Record<string, { feedback: number; oneShot: number }>;
};

export type RouteProfile = {
  totalRoutes: number;
  byKind: Partial<Record<TaskKind, KindStats>>;
};

export function readRouteProfile(workDir: string): RouteProfile {
  const out: RouteProfile = { totalRoutes: 0, byKind: {} };
  let raw = "";
  try {
    raw = readFileSync(join(workDir, ".tupigcode", "route.log"), "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "route" || (!row.type && row.model)) {
      out.totalRoutes++;
      continue;
    }
    if (row.type !== "feedback") continue;
    const kind = row.kind as TaskKind;
    const model = String(row.model ?? "");
    if (!kind || !model) continue;
    const stats = (out.byKind[kind] ??= { feedback: 0, oneShot: 0, rate: 0, byModel: {} });
    stats.feedback++;
    if (row.oneShot) stats.oneShot++;
    const m = (stats.byModel[model] ??= { feedback: 0, oneShot: 0 });
    m.feedback++;
    if (row.oneShot) m.oneShot++;
    stats.rate = stats.feedback ? stats.oneShot / stats.feedback : 0;
  }
  return out;
}

export const PROFILE_MIN_SAMPLES = 3;
export const PROFILE_RATE_THRESHOLD = 0.8;

/** 规则选型：该画像下样本≥3 且一次通过率≥0.8 → 返回样本最多的模型 */
export function suggestModel(profile: TaskProfile, workDir?: string): string | null {
  if (!workDir) return null;
  const stats = readRouteProfile(workDir).byKind[profile.kind];
  if (!stats || stats.feedback < PROFILE_MIN_SAMPLES || stats.rate < PROFILE_RATE_THRESHOLD) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [model, m] of Object.entries(stats.byModel)) {
    if (m.feedback > bestN) {
      bestN = m.feedback;
      best = model;
    }
  }
  return best;
}
