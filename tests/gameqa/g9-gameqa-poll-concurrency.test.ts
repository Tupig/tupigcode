/**
 * G9 gameqa 派发一致性集成（refs #129 缺口4）：
 * - 并发 poll 只派一次（N 个并行请求恰 1 个拿到 job，其余 null）
 * - 心跳过期：reapStale 后任务终态 failed，不再被 poll 派发；worker 定时兜底接线
 * - heartbeat 端点更新 last_seen（未注册 404）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/gameqa/store";
import { createGameqaServer } from "../../src/gameqa/server";
import { startBuiltinWorker } from "../../src/gameqa/builtin";

let dir: string;
let store: Store;
let server: http.Server;
let base: string;
let tokenBackup: string | undefined;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-poll-"));
  store = new Store(dir);
  server = http.createServer(createGameqaServer(store, path.join(dir, "static")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenBackup = process.env["PLATFORM_TOKEN"];
  delete process.env["PLATFORM_TOKEN"];
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  if (tokenBackup === undefined) delete process.env["PLATFORM_TOKEN"];
  else process.env["PLATFORM_TOKEN"] = tokenBackup;
});

async function createJob(extra: Record<string, unknown> = {}): Promise<number> {
  const resp = await fetch(base + "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "mac",
      unity_project_path: "/tmp/proj",
      test_filter: "Suite.Ok",
      extra: { job_type: "unity_log_scan", ...extra },
    }),
  });
  const j = (await resp.json()) as { job_id: number };
  return j.job_id;
}

describe("并发 poll 只派一次", () => {
  it("5 个并行 poll 恰 1 个拿到 job，其余 null；终态 running", async () => {
    await createJob();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(base + "/api/jobs/poll/mac?skills=").then((r) => r.json() as Promise<{ job: unknown }>),
      ),
    );
    const got = results.filter((r) => r.job !== null);
    expect(got).toHaveLength(1);
    const detail = await fetch(base + "/api/jobs/1").then((r) => r.json() as Promise<{ status: string }>);
    expect(detail.status).toBe("running");
  });
});

describe("心跳过期不派发", () => {
  it("reapStale 后任务 failed（失联文案），poll 不再派发", async () => {
    const id = await createJob();
    // 模拟 running 且 started_at 已超时
    const jobs = (store as unknown as { jobs: Array<Record<string, unknown>> }).jobs;
    const j = jobs.find((x) => x["job_id"] === id)!;
    j["status"] = "running";
    j["started_at"] = 1.0; // 远古时间

    const reaped = store.reapStale(60);
    expect(reaped).toContain(id);
    const detail = await fetch(base + `/api/jobs/${id}`).then((r) => r.json() as Promise<Record<string, any>>);
    expect(detail["status"]).toBe("failed");
    expect(String(detail["result"]?.summary?.message)).toContain("失联");

    const poll = await fetch(base + "/api/jobs/poll/mac").then((r) => r.json() as Promise<{ job: unknown }>);
    expect(poll.job).toBeNull(); // 无 pending 可派
  });

  it("worker 定时接线：interval tick 自动 reap 过期任务", async () => {
    const id = await createJob();
    const jobs = (store as unknown as { jobs: Array<Record<string, unknown>> }).jobs;
    const j = jobs.find((x) => x["job_id"] === id)!;
    j["status"] = "running";
    j["started_at"] = 1.0;

    const stop = startBuiltinWorker(store, 30, 1_000); // stale 阈值 1s
    try {
      await new Promise((r) => setTimeout(r, 200));
      const detail = await fetch(base + `/api/jobs/${id}`).then((r) => r.json() as Promise<Record<string, any>>);
      expect(detail["status"]).toBe("failed");
    } finally {
      stop();
    }
  });
});

describe("heartbeat 端点", () => {
  it("更新 last_seen/status；未注册 404", async () => {
    await fetch(base + "/api/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "hb-1", platform: "mac", skills: [] }),
    });
    const beat = await fetch(base + "/api/agents/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "hb-1", status: "busy", current_job_id: 9 }),
    });
    expect(beat.status).toBe(200);
    const list = await fetch(base + "/api/agents").then((r) => r.json() as Promise<{ items: Array<Record<string, any>> }>);
    const a = list.items.find((x) => x["agent_id"] === "hb-1")!;
    expect(a["status"]).toBe("busy");
    expect(a["current_job_id"]).toBe(9);

    const ghost = await fetch(base + "/api/agents/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "nope", status: "idle" }),
    });
    expect(ghost.status).toBe(404);
  });
});
