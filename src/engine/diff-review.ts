/**
 * engine/diffReview.ts — 三级 diff 审查 + 拒绝回滚（issue #18）
 *
 * 一轮内所有文件修改聚合为结构化 diff（自研 LCS 行差异），
 * REPL 支持 全局 a/r/s → 文件 y/n/h/q → 块 y/n 三级判定；
 * 拒绝的写操作按文件回滚（同文件多次修改回到首次之前的版本）。
 * 超大 diff（行数/块数/文件数超限）降级为仅文件级。
 */
import { writeFile, unlink, mkdir } from "fs/promises";
import { dirname } from "path";

export interface FileOp {
  path: string;
  before: string | null; // null = 新建
  after: string;
}

export interface DiffLine {
  sign: " " | "-" | "+";
  text: string;
}

export interface Hunk {
  header: string;
  oldStart: number; // 1-based；a 为空时为 1，oldCount=0
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileReview {
  path: string;
  op: "create" | "modify";
  hunks: Hunk[];
  degraded: boolean;
  stat: string;
}

export interface ReviewPlan {
  files: FileReview[];
}

export const REVIEW_LIMITS = {
  maxFileLines: 1500,
  maxHunksPerFile: 12,
  maxFiles: 8,
  context: 3,
  maxCells: 4_000_000,
};

/** 本轮写操作收集（模块级，index.ts 在 query 轮次结束后 drain） */
let turnOps: FileOp[] = [];
export function pushTurnOp(op: FileOp): void {
  turnOps.push(op);
}
export function drainTurnOps(): FileOp[] {
  const ops = turnOps;
  turnOps = [];
  return ops;
}
export function resetTurnOps(): void {
  turnOps = [];
}

/** LCS 行差异 → 操作序列；规模超限返回 null（触发降级） */
function diffOps(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n > 0 && m > 0 && n * m > REVIEW_LIMITS.maxCells) return null;
  const dp = new Int32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) {
      ops.push({ sign: "-", text: a[i] });
      i++;
    } else {
      ops.push({ sign: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ sign: "-", text: a[i++] });
  while (j < m) ops.push({ sign: "+", text: b[j++] });
  return ops;
}

/** 操作序列 → hunks（上下文 3 行，相邻变化簇 ≤6 间隔合并） */
function toHunks(ops: DiffLine[], aEmpty: boolean): Hunk[] {
  const changeIdx: number[] = [];
  ops.forEach((o, k) => {
    if (o.sign !== " ") changeIdx.push(k);
  });
  if (changeIdx.length === 0) return [];

  // 簇：相邻变化索引差 ≤ 2*context 才并入
  const clusters: [number, number][] = [];
  let start = changeIdx[0];
  let end = changeIdx[0];
  for (const k of changeIdx.slice(1)) {
    if (k - end < REVIEW_LIMITS.context * 2) {
      end = k;
    } else {
      clusters.push([start, end]);
      start = k;
      end = k;
    }
  }
  clusters.push([start, end]);

  // 每个 op 的起始行号（' ' 与 '-' 消耗 a，' ' 与 '+' 消耗 b）
  const aAt: number[] = new Array(ops.length).fill(0);
  const bAt: number[] = new Array(ops.length).fill(0);
  let ai = 1;
  let bi = 1;
  for (let k = 0; k < ops.length; k++) {
    aAt[k] = ai;
    bAt[k] = bi;
    if (ops[k].sign !== "+") ai++;
    if (ops[k].sign !== "-") bi++;
  }

  const hunks: Hunk[] = [];
  let prevHi = -1;
  for (const [c0, c1] of clusters) {
    // 裁剪：相邻 hunk 上下文互不重叠，避免 selectHunks 重复消费行
    const lo = Math.max(prevHi + 1, c0 - REVIEW_LIMITS.context, 0);
    prevHi = Math.min(ops.length - 1, c1 + REVIEW_LIMITS.context);
    const lines = ops.slice(lo, prevHi + 1);
    const oldCount = lines.filter((l) => l.sign !== "+").length;
    const newCount = lines.filter((l) => l.sign !== "-").length;
    const oldStart = aEmpty ? 1 : aAt[lo];
    const newStart = bAt[lo];
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines,
    });
  }
  return hunks;
}

/** 聚合本轮写操作为审查计划；同文件多次修改合并为一条（首 before → 末 after） */
export function buildReview(ops: FileOp[]): ReviewPlan {
  const byPath = new Map<string, { before: string | null; after: string }>();
  const order: string[] = [];
  for (const op of ops) {
    const cur = byPath.get(op.path);
    if (!cur) {
      byPath.set(op.path, { before: op.before, after: op.after });
      order.push(op.path);
    } else {
      byPath.set(op.path, { before: cur.before, after: op.after });
    }
  }

  const degradeAll = order.length > REVIEW_LIMITS.maxFiles;
  const files: FileReview[] = order.map((p) => {
    const { before, after } = byPath.get(p)!;
    const aLines = (before ?? "").split("\n");
    const bLines = after.split("\n");
    let degraded = degradeAll;
    if (
      aLines.length > REVIEW_LIMITS.maxFileLines ||
      bLines.length > REVIEW_LIMITS.maxFileLines
    ) degraded = true;

    let hunks: Hunk[] = [];
    if (!degraded) {
      const opsSeq = diffOps(before === null ? [] : aLines, bLines);
      if (opsSeq === null) {
        degraded = true;
      } else {
        hunks = toHunks(opsSeq, before === null);
        if (hunks.length > REVIEW_LIMITS.maxHunksPerFile) {
          degraded = true;
          hunks = [];
        }
      }
    }

    let stat: string;
    if (degraded) {
      stat = `±${Math.abs(bLines.length - aLines.length)} 行（降级）`;
    } else {
      let add = 0;
      let del = 0;
      for (const h of hunks) {
        for (const l of h.lines) {
          if (l.sign === "+") add++;
          else if (l.sign === "-") del++;
        }
      }
      stat = `+${add} -${del}`;
    }
    return { path: p, op: before === null ? "create" : "modify", hunks, degraded, stat };
  });

  return { files };
}

export function decideGlobal(input: string): "accept" | "reject" | "step" | null {
  const s = input.trim().toLowerCase();
  if (s === "a") return "accept";
  if (s === "r") return "reject";
  if (s === "s") return "step";
  return null;
}

export function decideFile(input: string): "y" | "n" | "h" | "q" | null {
  const s = input.trim().toLowerCase();
  if (s === "y") return "y";
  if (s === "n") return "n";
  if (s === "h") return "h";
  if (s === "q") return "q";
  return null;
}

export function decideHunk(input: string): "y" | "n" | null {
  const s = input.trim().toLowerCase();
  if (s === "y") return "y";
  if (s === "n") return "n";
  return null;
}

/** 按块级选择重建文件内容：keep[i]=true 保留第 i 个 hunk 的改动，false 还原该块 */
export function selectHunks(before: string | null, hunks: Hunk[], keep: boolean[]): string {
  const a = before === null ? [] : before.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based a 行游标
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const start0 = Math.max(0, h.oldStart - 1);
    if (start0 > cursor) {
      out.push(...a.slice(cursor, start0));
      cursor = start0;
    }
    const selected = keep[i]
      ? h.lines.filter((l) => l.sign !== "-") // 接受：新内容（上下文 + '+'）
      : h.lines.filter((l) => l.sign !== "+"); // 拒绝：旧内容（上下文 - '+'）
    out.push(...selected.map((l) => l.text));
    cursor = Math.max(cursor, start0 + h.oldCount);
  }
  if (cursor < a.length) out.push(...a.slice(cursor));
  return out.join("\n");
}

/** 文件级拒绝回滚：同文件多次修改回到首次之前的版本；新建文件删除 */
export async function rollbackOps(ops: FileOp[]): Promise<void> {
  const first = new Map<string, string | null>();
  for (const op of ops) {
    if (!first.has(op.path)) first.set(op.path, op.before);
  }
  for (const [p, before] of first) {
    if (before === null) {
      await unlink(p).catch(() => {});
    } else {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, before, "utf-8");
    }
  }
}

/** 单文件 diff 渲染（供 REPL 展示）；降级文件只显示文件级摘要 */
export function renderFileDiff(f: FileReview): string {
  const rel = f.path;
  if (f.degraded) {
    return `--- ${rel}\n+++ ${rel}\n（超大改动：降级为文件级，仅支持整文件接受/拒绝）`;
  }
  const out: string[] = [`--- ${rel}`, `+++ ${rel}（${f.op === "create" ? "新建" : "修改"} ${f.stat}）`];
  for (const h of f.hunks) {
    out.push(h.header);
    for (const l of h.lines) out.push(l.sign + l.text);
  }
  return out.join("\n");
}

/** 审批 mini 预览（issue #54）：ops → 逐文件渲染；空/异常 null 由调用方回退 JSON */
export function renderOpsPreview(ops: FileOp[]): string | null {
  if (ops.length === 0) return null;
  try {
    const plan = buildReview(ops);
    if (plan.files.length === 0) return null;
    const rendered = plan.files.map(renderFileDiff).join("\n\n");
    return rendered || null;
  } catch {
    return null;
  }
}

/** 块级决定落地：按 keep 结果写回文件（全拒且新建 → 删除） */
export async function applyHunkDecision(op: { path: string; before: string | null }, hunks: Hunk[], keep: boolean[]): Promise<void> {
  const next = selectHunks(op.before, hunks, keep);
  if (op.before === null && !keep.some(Boolean)) {
    await unlink(op.path).catch(() => {});
    return;
  }
  await mkdir(dirname(op.path), { recursive: true });
  await writeFile(op.path, next, "utf-8");
}
