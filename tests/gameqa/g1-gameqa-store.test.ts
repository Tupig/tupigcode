/**
 * G1 gameqa 存储：数据格式兼容 + 任务生命周期语义（store.go 移植回归）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, BUILTIN_TYPES, type Job } from "../../src/gameqa/store";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedLegacy(): void {
  // Go/Python 版格式样例（2 空格缩进、字段 null 而非省略）
  fs.writeFileSync(
    path.join(dir, "jobs.json"),
    JSON.stringify(
      [
        {
          job_id: 7,
          platform: "mac",
          status: "pending",
          required_skills: ["PlayMode"],
          extra: { test_filter: "Foo" },
          created_at: 1700000000.5,
          started_at: null,
          result: null,
        },
      ],
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify(
      { "agent-mac-1": { agent_id: "agent-mac-1", platform: "mac", skills: ["PlayMode"], status: "idle", current_job_id: null, last_seen: 1700000001.0 } },
      null,
      2,
    ),
  );
}

describe("数据格式兼容（可直接读旧 data/）", () => {
  it("加载 jobs.json / agents.json，job_id.txt 缺失时取最大 ID 并落盘", () => {
    seedLegacy();
    const s = new Store(dir);
    const { total, items } = s.listJobs();
    expect(total).toBe(1);
    expect(items[0]["status"]).toBe("pending");
    expect(s.hasAgent("agent-mac-1")).toBe(true);
    expect(fs.readFileSync(path.join(dir, "job_id.txt"), "utf-8")).toBe("7");
    expect(s.nextJobId()).toBe(8);
  });

  it("已损坏的 JSON 按空数据处理", () => {
    fs.writeFileSync(path.join(dir, "jobs.json"), "{oops");
    const s = new Store(dir);
    expect(s.listJobs().total).toBe(0);
  });
});

describe("任务生命周期", () => {
  it("append 落快照 + find 内存未命中时读快照兜底", () => {
    const s = new Store(dir);
    const id = s.nextJobId();
    s.appendJob({ job_id: id, platform: "android", status: "pending", required_skills: null, extra: {}, created_at: 1 });
    expect(s.findJob(id)?.["platform"]).toBe("android");
    expect(fs.existsSync(path.join(dir, "runs", `job_${id}.json`))).toBe(true);
    expect(s.deleteJob(id)).toBe(true);
    expect(s.findJob(id)).toBeNull(); // 快照随删除移除
    // 兜底：列表外的快照（如 runs/ 残留）仍可查询
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runs", "job_42.json"), JSON.stringify({ job_id: 42, platform: "mac", status: "passed" }));
    expect(s.findJob(42)?.["platform"]).toBe("mac");
    expect(s.findJob(9999)).toBeNull();
  });

  it("poll：平台 + 技能子集匹配，命中置 running 且 started_at 非空", () => {
    const s = new Store(dir);
    s.appendJob({ job_id: s.nextJobId(), platform: "mac", status: "pending", required_skills: ["PlayMode"], extra: {}, created_at: 1 });
    const got = s.pollJob("mac", new Set(["PlayMode", "EditMode"]));
    expect(got?.["status"]).toBe("running");
    expect(typeof got?.["started_at"]).toBe("number");
    expect(s.pollJob("mac", new Set())).toBeNull(); // 已非 pending

    // agent 未声明技能可拉任意任务；声明不足则拉不到
    s.appendJob({ job_id: s.nextJobId(), platform: "ios", status: "pending", required_skills: ["XCUITest"], extra: {}, created_at: 1 });
    expect(s.pollJob("ios", new Set())).not.toBeNull();
    s.appendJob({ job_id: s.nextJobId(), platform: "android", status: "pending", required_skills: ["ADB", "Airtest"], extra: {}, created_at: 1 });
    expect(s.pollJob("android", new Set(["ADB"]))).toBeNull();
    expect(s.pollJob("android", new Set(["ADB", "Airtest"]))).not.toBeNull();
  });

  it("result：成功 passed / 失败 failed；cancelled 终态不被覆盖；不存在返回 false", () => {
    const s = new Store(dir);
    const id = s.nextJobId();
    s.appendJob({ job_id: id, platform: "mac", status: "running", required_skills: null, extra: {}, created_at: 1 });
    expect(s.setJobResult(id, "agent-1", true, "/tmp/a.log", { message: "ok" })).toBe(true);
    expect(s.findJob(id)?.["status"]).toBe("passed");
    expect((s.findJob(id)?.["result"] as Record<string, unknown>)["agent_id"]).toBe("agent-1");

    const cid = s.nextJobId();
    s.appendJob({ job_id: cid, platform: "mac", status: "cancelled", required_skills: null, extra: {}, created_at: 1 });
    expect(s.setJobResult(cid, "agent-1", true, null, {})).toBe(true); // 静默接受
    expect(s.findJob(cid)?.["status"]).toBe("cancelled"); // 不覆盖
    expect(s.setJobResult(424242, "agent-1", true, null, {})).toBe(false);
  });

  it("cancel：pending→cancelled 幂等；passed 不可取消；delete 移除快照", () => {
    const s = new Store(dir);
    const id = s.nextJobId();
    s.appendJob({ job_id: id, platform: "mac", status: "pending", required_skills: null, extra: {}, created_at: 1 });
    expect(s.cancelJob(id)).toEqual([true, true]);
    expect(s.cancelJob(id)).toEqual([true, true]);
    expect(s.findJob(id)?.["status"]).toBe("cancelled");

    const pid = s.nextJobId();
    s.appendJob({ job_id: pid, platform: "mac", status: "passed", required_skills: null, extra: {}, created_at: 1 });
    expect(s.cancelJob(pid)).toEqual([true, false]);
    expect(s.cancelJob(123)).toEqual([false, false]);

    expect(s.deleteJob(id)).toBe(true);
    expect(fs.existsSync(path.join(dir, "runs", `job_${id}.json`))).toBe(false);
    expect(s.deleteJob(id)).toBe(false);
  });

  it("reapStale：running 超时标记 failed，started_at 缺失回退 created_at", () => {
    const s = new Store(dir);
    const now = Date.now() / 1000;
    const staleId = s.nextJobId();
    s.appendJob({ job_id: staleId, platform: "mac", status: "running", required_skills: null, extra: {}, created_at: 1, started_at: now - 7200 });
    const fallbackId = s.nextJobId();
    s.appendJob({ job_id: fallbackId, platform: "ios", status: "running", required_skills: null, extra: {}, created_at: now - 7200 });
    const freshId = s.nextJobId();
    s.appendJob({ job_id: freshId, platform: "android", status: "running", required_skills: null, extra: {}, created_at: 1, started_at: now - 10 });

    expect(s.reapStale(3600)).toEqual([staleId, fallbackId]);
    expect(s.findJob(staleId)?.["status"]).toBe("failed");
    expect(((s.findJob(staleId)?.["result"] as Record<string, unknown>)["summary"] as Record<string, unknown>)["message"]).toMatch(/执行超时/);
    expect(s.findJob(freshId)?.["status"]).toBe("running");
  });

  it("cleanup 只删终态；claimBuiltin 只认 web+内置类型", () => {
    const s = new Store(dir);
    const t1 = s.nextJobId();
    s.appendJob({ job_id: t1, platform: "mac", status: "passed", required_skills: null, extra: {}, created_at: 1 });
    const t2 = s.nextJobId();
    s.appendJob({ job_id: t2, platform: "mac", status: "pending", required_skills: null, extra: {}, created_at: 1 });
    expect(s.cleanupJobs()).toBe(1);
    expect(s.listJobs().total).toBe(1);

    s.appendJob({ job_id: s.nextJobId(), platform: "web", status: "pending", required_skills: null, extra: { job_type: "web_check" }, created_at: 1 });
    const claimed = s.claimBuiltin();
    expect(claimed?.["status"]).toBe("running");
    expect(s.claimBuiltin()).toBeNull();
    expect(BUILTIN_TYPES.has("web_check")).toBe(true);
  });
});

describe("Agent 与产物", () => {
  it("注册/心跳：未注册返回 false；current_job_id 支持 null", () => {
    const s = new Store(dir);
    expect(s.heartbeat("nope", "idle", null, 1)).toBe(false);
    s.setAgent("a1", { agent_id: "a1", platform: "mac", skills: [], status: "idle", current_job_id: null, last_seen: 1 });
    expect(s.heartbeat("a1", "running", 5, 2)).toBe(true);
    expect(s.listAgents()).toEqual({ items: [{ agent_id: "a1", platform: "mac", skills: [], status: "running", current_job_id: 5, last_seen: 2 }], total: 1 });
  });

  it("产物：保存/列举/读取；非法名防路径穿越", () => {
    const s = new Store(dir);
    const id = s.nextJobId();
    s.appendJob({ job_id: id, platform: "mac", status: "running", required_skills: null, extra: {}, created_at: 1 });
    s.saveArtifact(id, "steps.json", Buffer.from(`{"a":1}`));
    expect(s.listArtifacts(id)).toEqual([{ name: "steps.json", size: 7 }]);
    expect(s.readArtifact(id, "steps.json").toString()).toBe(`{"a":1}`);
    expect(() => s.saveArtifact(id, "../../evil", Buffer.from("x"))).toThrow(/非法/);
    expect(() => s.readArtifact(id, "..%2Fevil")).toThrow(/非法/);
    expect(s.listArtifacts(999)).toEqual([]);
  });

  it("listJobs 返回数组拷贝，调用方增删不影响内部列表（fix #121）", () => {
    const s = new Store(dir);
    s.appendJob({ job_id: s.nextJobId(), platform: "mac", status: "pending", required_skills: null, extra: {}, created_at: 1 });
    const { items } = s.listJobs();
    items.push({ job_id: 999, platform: "hack" } as Job);
    items.splice(0, 1);
    expect(s.listJobs().total).toBe(1);
    expect(s.listJobs().items[0]["job_id"]).toBe(1);
  });

  it("deleteJob 移除后 listJobs/hasJob 同步（fix #121 回滚语义正常路径回归）", () => {
    const s = new Store(dir);
    const id = s.nextJobId();
    s.appendJob({ job_id: id, platform: "mac", status: "pending", required_skills: null, extra: {}, created_at: 1 });
    expect(s.deleteJob(id)).toBe(true);
    expect(s.hasJob(id)).toBe(false);
    expect(s.listJobs().total).toBe(0);
  });
});
