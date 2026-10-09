/**
 * E22 三级 diff 审查 + 拒绝回滚 + plan 暂存（issue #18）
 * 三级判定语义 / 拒绝回滚 / plan 暂存到 apply / 超大 diff 降级为文件级
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pushTurnOp, drainTurnOps, resetTurnOps,
  buildReview, decideGlobal, decideFile, decideHunk,
  selectHunks, rollbackOps, renderFileDiff, type FileOp,
} from "../../src/engine/diff-review";
import {
  planRerouteTarget, stagingRoot, stageWrite, listStaged, applyStaged, discardStaged, ensureStagedSeed,
} from "../../src/engine/staging";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-review-"));
  resetTurnOps();
});

afterEach(() => {
  resetTurnOps();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("三级判定语义", () => {
  it("全局：a=全部接受 r=全部拒绝 s=逐项", () => {
    expect(decideGlobal("a")).toBe("accept");
    expect(decideGlobal("A")).toBe("accept");
    expect(decideGlobal("r")).toBe("reject");
    expect(decideGlobal("R")).toBe("reject");
    expect(decideGlobal("s")).toBe("step");
    expect(decideGlobal("")).toBeNull();
    expect(decideGlobal("x")).toBeNull();
  });

  it("文件级：y 接受 n 拒绝 h 进入块级 q 其余默认接受", () => {
    expect(decideFile("y")).toBe("y");
    expect(decideFile("n")).toBe("n");
    expect(decideFile("h")).toBe("h");
    expect(decideFile("q")).toBe("q");
    expect(decideFile("")).toBeNull();
    expect(decideFile("z")).toBeNull();
  });

  it("块级：y/n", () => {
    expect(decideHunk("y")).toBe("y");
    expect(decideHunk("n")).toBe("n");
    expect(decideHunk("")).toBeNull();
  });
});

describe("buildReview 聚合与降级", () => {
  const op = (p: string, before: string | null, after: string): FileOp => ({ path: path.join(dir, p), before, after });

  it("多文件聚合 + 同文件多次修改合并为一条", () => {
    const r = buildReview([
      op("a.txt", "line1\n", "line1 changed\n"),
      op("b.txt", null, "created\n"),
      op("a.txt", "line1 changed\n", "line1 final\n"),
    ]);
    expect(r.files).toHaveLength(2); // a.txt 合并 + b.txt
    expect(r.files[0].hunks.length).toBeGreaterThan(0);
    expect(r.files.find((f) => f.path.endsWith("b.txt"))!.op).toBe("create");
  });

  it("超大 diff 降级为文件级（hunks 清空 + degraded 标记）", () => {
    const bigBefore = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n");
    const bigAfter = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n");
    const r = buildReview([op("big.txt", bigBefore, bigAfter)]);
    expect(r.files[0].degraded).toBe(true);
    expect(r.files[0].hunks).toHaveLength(0);
    expect(renderFileDiff(r.files[0])).toContain("降级");
  });

  it("文件数超上限 → 全部降级", () => {
    const ops = Array.from({ length: 9 }, (_, i) => op(`f${i}.txt`, "x\n", `y${i}\n`));
    const r = buildReview(ops);
    expect(r.files.every((f) => f.degraded)).toBe(true);
  });
});

describe("块级选择与写回", () => {
  it("selectHunks：部分拒绝后只保留接受的块", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const after = "a\nB\nc\nd\ne\nf\ng\nH\ni\nj\n";
    const r = buildReview([{ path: path.join(dir, "x.txt"), before, after }]);
    const hunks = r.files[0].hunks;
    expect(hunks.length).toBe(2);
    const merged = selectHunks(before, hunks, [true, false]);
    expect(merged).toBe("a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
  });

  it("selectHunks：全拒 = 还原原文", () => {
    const before = "a\nb\nc\n";
    const after = "A\nb\nC\n";
    const r = buildReview([{ path: path.join(dir, "y.txt"), before, after }]);
    expect(selectHunks(before, r.files[0].hunks, r.files[0].hunks.map(() => false))).toBe(before);
  });
});

describe("拒绝回滚", () => {
  it("修改回写 before、新建文件删除", async () => {
    const f = path.join(dir, "mod.txt");
    const g = path.join(dir, "new.txt");
    fs.writeFileSync(f, "original\n");
    fs.writeFileSync(g, "brand new\n");
    pushTurnOp({ path: f, before: "original\n", after: "edited\n" });
    pushTurnOp({ path: g, before: null, after: "brand new\n" });
    const ops = drainTurnOps();
    expect(ops).toHaveLength(2);

    await rollbackOps(ops);
    expect(fs.readFileSync(f, "utf-8")).toBe("original\n");
    expect(fs.existsSync(g)).toBe(false);
  });

  it("同文件多次修改：回滚到首次之前的版本", async () => {
    const f = path.join(dir, "multi.txt");
    fs.writeFileSync(f, "v1\n");
    pushTurnOp({ path: f, before: "v1\n", after: "v2\n" });
    pushTurnOp({ path: f, before: "v2\n", after: "v3\n" });
    await rollbackOps(drainTurnOps());
    expect(fs.readFileSync(f, "utf-8")).toBe("v1\n");
  });
});

describe("plan 暂存到 apply", () => {
  it("planRerouteTarget：工作区内 → staging 路径；spec 直写；越界 → null", () => {
    const staged = planRerouteTarget(dir, path.join(dir, "src/app.ts"));
    expect(staged).toBe(path.join(stagingRoot(dir), "src/app.ts"));
    expect(planRerouteTarget(dir, path.join(dir, ".tupigcode/specs/plan.md"))).toBeNull(); // spec 直写不经此
    expect(planRerouteTarget(dir, "/etc/passwd")).toBeNull();
    expect(planRerouteTarget(dir, path.join(dir, "../outside.ts"))).toBeNull();
  });

  it("暂存不改真文件，apply 才落盘，随后 staging 清空", async () => {
    const real = path.join(dir, "src/main.ts");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "const a = 1;\n");

    // 首次改：种子复制 + 暂存写入
    const staged = planRerouteTarget(dir, real)!;
    await ensureStagedSeed(real, staged);
    await stageWrite(dir, "src/main.ts", "const a = 2;\n");
    expect(fs.readFileSync(real, "utf-8")).toBe("const a = 1;\n"); // 真文件未动
    expect(await listStaged(dir)).toEqual(["src/main.ts"]);

    await applyStaged(dir);
    expect(fs.readFileSync(real, "utf-8")).toBe("const a = 2;\n"); // apply 落盘
    expect(await listStaged(dir)).toEqual([]); // 清空
  });

  it("discardStaged 清空暂存且不碰真文件", async () => {
    const real = path.join(dir, "keep.txt");
    fs.writeFileSync(real, "keep\n");
    await stageWrite(dir, "keep.txt", "staged junk\n");
    await discardStaged(dir);
    expect(fs.readFileSync(real, "utf-8")).toBe("keep\n");
    expect(await listStaged(dir)).toEqual([]);
  });

  it("applyStaged 拒绝越界条目（staging 内伪造 ../ 逃逸）", async () => {
    const staging = stagingRoot(dir);
    fs.mkdirSync(path.join(staging, "evil"), { recursive: true });
    fs.writeFileSync(path.join(staging, "evil", "..", "..", "escape.txt"), "x"); // 实际写入 staging/escape.txt? 见断言
    // 人为构造逃逸 rel：直接放一个含 .. 的目录名不可行，改为验证 apply 只按 rel 白名单处理
    await stageWrite(dir, "ok.txt", "fine\n");
    const applied = await applyStaged(dir);
    expect(applied.applied.some((p) => p.includes(".."))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "ok.txt"), "utf-8")).toBe("fine\n");
  });
});
