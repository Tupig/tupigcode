/**
 * e84: trajectory 内存与落盘无界治理（issue #94）
 *
 * - 内存：events 环形上限（TRAJECTORY_MAX_EVENTS），超限丢最旧 + dropped 计数
 * - tool_result 入库前截断（TRAJECTORY_RESULT_MAX_CHARS）
 * - 磁盘：save 后同 sessionId 文件只留最近 TRAJECTORY_KEEP_FILES 份
 * 上限值统一进 engine/constants.ts（#84 唯一事实源先例）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrajectoryRecorder } from "../../src/session/trajectory";
import { TRAJECTORY_MAX_EVENTS, TRAJECTORY_RESULT_MAX_CHARS, TRAJECTORY_KEEP_FILES } from "../../src/engine/constants";

describe("trajectory 内存环形上限（issue #94）", () => {
  it("超上限丢最旧并计 dropped", () => {
    const rec = new TrajectoryRecorder("s1", "m", "/w");
    const total = TRAJECTORY_MAX_EVENTS + 5;
    for (let i = 0; i < total; i++) {
      rec.record("system", { subtype: "tick", i });
    }
    const t = rec.getTrajectory();
    expect(t.events.length).toBe(TRAJECTORY_MAX_EVENTS);
    expect(rec.getDropped()).toBe(5);
    expect((t.events[0].data as any).i).toBe(5); // 最旧 5 条已丢
    expect((t.events[t.events.length - 1].data as any).i).toBe(total - 1);
  });

  it("tool_result 入库前截断（保留头部）", () => {
    const rec = new TrajectoryRecorder("s1", "m", "/w");
    rec.recordToolResult("tu1", "X".repeat(10_000), false, 10);
    const t = rec.getTrajectory();
    const r = t.events[0].data.result as string;
    expect(r.length).toBe(TRAJECTORY_RESULT_MAX_CHARS);
    expect(r.startsWith("XXX")).toBe(true);
  });

  it("截断带省略标记", () => {
    const rec = new TrajectoryRecorder("s1", "m", "/w");
    rec.recordToolResult("tu1", "Y".repeat(5_000), false, 10);
    const r = rec.getTrajectory().events[0].data.result as string;
    expect(r.endsWith("…")).toBe(true);
  });
});

describe("trajectory 落盘滚动清理（issue #94）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tupig-e84-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("save 多份后只留最近 N 份", () => {
    const files: (string | null)[] = [];
    for (let i = 0; i < TRAJECTORY_KEEP_FILES + 4; i++) {
      const rec = new TrajectoryRecorder("sess-a", "m", "/w", { savePath: dir });
      rec.record("system", { subtype: "run", i });
      files.push(rec.save());
    }
    const left = readdirSync(dir).filter((f) => f.startsWith("trajectory-sess-a-"));
    expect(left.length).toBe(TRAJECTORY_KEEP_FILES);
    expect(left.length).toBeLessThanOrEqual(files.filter(Boolean).length);
  });

  it("不同 sessionId 互不清理", () => {
    const a = new TrajectoryRecorder("sess-a", "m", "/w", { savePath: dir });
    a.record("system", { subtype: "x" });
    a.save();
    const b = new TrajectoryRecorder("sess-b", "m", "/w", { savePath: dir });
    b.record("system", { subtype: "y" });
    b.save();
    const left = readdirSync(dir);
    expect(left.some((f) => f.startsWith("trajectory-sess-a-"))).toBe(true);
    expect(left.some((f) => f.startsWith("trajectory-sess-b-"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, left[0]), "utf-8")).sessionId).toBeTruthy();
  });
});
