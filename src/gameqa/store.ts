/**
 * gameqa/store.ts — Unity 游戏测试平台 · 编排存储（gameqa-server 移植）
 * 对应原 gpt-visual-platform（Go 版 server/store.go）：内存 + JSON 文件（agents.json / jobs.json / job_id.txt）。
 * 与 Python v1 / Go v2 数据格式完全兼容，可直接读写现有 data/ 目录。
 * 并发模型：Node 单线程 + 同步 fs —— 每个方法在一次调用栈内完成（无 await），
 * 等价 Go 版的"锁内完成、只输出序列化结果"，避免数据竞争。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Job = Record<string, Json>;
export type Agent = Record<string, Json>;

export interface ArtifactInfo {
  name: string;
  size: number;
}

/** 内置执行器任务类型（server/builtin.go builtinTypes） */
export const BUILTIN_TYPES = new Set([
  "web_check",
  "api_check",
  "api_load",
  "api_flow",
  "self_check",
  "port_check",
  "cert_check",
  "dns_check",
]);

const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

function nowFloat(): number {
  return Date.now() / 1000;
}

function jobIdOf(job: Job): number {
  const v = job["job_id"];
  return typeof v === "number" ? Math.trunc(v) : 0;
}

/** 原子写：临时文件 + rename；2 空格缩进（与 Python/Go 版一致）。tmp 名含 pid+随机（fix #121） */
function writeJSONFile(filePath: string, v: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp 不存在 */ }
    throw err;
  }
}

function toStringSet(v: Json | undefined): Set<string> {
  const set = new Set<string>();
  if (Array.isArray(v)) {
    for (const item of v) if (typeof item === "string") set.add(item);
  }
  return set;
}

function subset(required: Set<string>, agentSkills: Set<string>): boolean {
  for (const k of required) if (!agentSkills.has(k)) return false;
  return true;
}

export class Store {
  readonly dataDir: string;
  readonly runsDir: string;
  private agents: Map<string, Agent> = new Map();
  private jobs: Job[] = [];
  private jobID = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.runsDir = path.join(dataDir, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.load();
  }

  private agentsPath(): string {
    return path.join(this.dataDir, "agents.json");
  }
  private jobsPath(): string {
    return path.join(this.dataDir, "jobs.json");
  }
  private jobIDPath(): string {
    return path.join(this.dataDir, "job_id.txt");
  }

  private load(): void {
    this.agents = new Map();
    try {
      const raw = fs.readFileSync(this.agentsPath(), "utf-8");
      const obj = JSON.parse(raw) as Record<string, Agent>;
      for (const [k, v] of Object.entries(obj)) this.agents.set(k, v);
    } catch {
      /* 不存在或解析失败 → 空数据（与 Go 版一致） */
    }
    this.jobs = [];
    try {
      const raw = fs.readFileSync(this.jobsPath(), "utf-8");
      const arr = JSON.parse(raw) as Job[];
      if (Array.isArray(arr)) this.jobs = arr;
    } catch {
      /* 同上 */
    }
    this.jobID = 0;
    let parsed = false;
    try {
      const n = parseInt(fs.readFileSync(this.jobIDPath(), "utf-8").trim(), 10);
      if (!Number.isNaN(n)) {
        this.jobID = n;
        parsed = true;
      }
    } catch {
      /* 落到从任务列表计算 */
    }
    if (!parsed) {
      for (const j of this.jobs) {
        const id = jobIdOf(j);
        if (id > this.jobID) this.jobID = id;
      }
      this.writeJobID();
    }
  }

  private writeJobID(): void {
    fs.writeFileSync(this.jobIDPath(), String(this.jobID), "utf-8");
  }

  private saveData(): void {
    writeJSONFile(this.agentsPath(), Object.fromEntries(this.agents));
    writeJSONFile(this.jobsPath(), this.jobs);
  }

  private saveAgents(): void {
    writeJSONFile(this.agentsPath(), Object.fromEntries(this.agents));
  }

  private saveJob(job: Job): void {
    writeJSONFile(path.join(this.runsDir, `job_${jobIdOf(job)}.json`), job);
  }

  /** 自增任务 ID 并立即落盘 */
  nextJobId(): number {
    this.jobID++;
    try {
      this.writeJobID();
    } catch (e) {
      console.warn("[存储] 写入 job_id.txt 失败:", e);
    }
    return this.jobID;
  }

  /** 注册/覆盖 Agent */
  setAgent(id: string, agent: Agent): void {
    this.agents.set(id, agent);
    try {
      this.saveAgents();
    } catch (e) {
      console.warn("[存储] 保存 agents 失败:", e);
    }
  }

  /** 更新心跳字段；Agent 未注册返回 false */
  heartbeat(id: string, status: string, currentJobId: number | null, lastSeen: number): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent["last_seen"] = lastSeen;
    agent["status"] = status;
    agent["current_job_id"] = currentJobId;
    try {
      this.saveAgents();
    } catch (e) {
      console.warn("[存储] 保存 agents 失败:", e);
    }
    return true;
  }

  /**
   * 取消任务：pending/running 置 cancelled（终态）。
   * 返回 [是否存在, 是否已取消]；已通过/失败的任务不可取消；已取消幂等返回 [true,true]。
   */
  cancelJob(id: number): [boolean, boolean] {
    for (const j of this.jobs) {
      if (jobIdOf(j) !== id) continue;
      const st = typeof j["status"] === "string" ? (j["status"] as string) : "";
      if (st === "cancelled") return [true, true];
      if (st !== "pending" && st !== "running") return [true, false];
      j["status"] = "cancelled";
      try {
        this.saveJob(j);
        this.saveData();
      } catch (e) {
        console.warn("[存储] 保存任务失败:", e);
      }
      return [true, true];
    }
    return [false, false];
  }

  /** 删除任务：从列表移除并删除快照文件 */
  deleteJob(id: number): boolean {
    const idx = this.jobs.findIndex((j) => jobIdOf(j) === id);
    if (idx < 0) return false;
    const removed = this.jobs.splice(idx, 1)[0];
    try {
      fs.rmSync(path.join(this.runsDir, `job_${id}.json`), { force: true });
      this.saveData();
      return true;
    } catch (e) {
      this.jobs.splice(idx, 0, removed); // 落盘失败回滚内存，避免内存/磁盘不一致（fix #121）
      console.warn("[存储] 保存 jobs 失败:", e);
      return false;
    }
  }

  hasJob(id: number): boolean {
    return this.jobs.some((j) => jobIdOf(j) === id);
  }

  private artifactsDir(jobId: number): string {
    return path.join(this.runsDir, `job_${jobId}`, "artifacts");
  }

  /** 保存 Agent 上传的执行记录（产物名白名单防路径穿越） */
  saveArtifact(jobId: number, name: string, content: Buffer): void {
    if (!ARTIFACT_NAME_RE.test(name)) throw new Error(`产物名非法: ${JSON.stringify(name)}`);
    const dir = this.artifactsDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  listArtifacts(jobId: number): ArtifactInfo[] {
    const out: ArtifactInfo[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.artifactsDir(jobId), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      try {
        out.push({ name: e.name, size: fs.statSync(path.join(this.artifactsDir(jobId), e.name)).size });
      } catch {
        /* 跳过 */
      }
    }
    return out;
  }

  readArtifact(jobId: number, name: string): Buffer {
    if (!ARTIFACT_NAME_RE.test(name)) throw new Error(`产物名非法: ${JSON.stringify(name)}`);
    return fs.readFileSync(path.join(this.artifactsDir(jobId), name));
  }

  hasAgent(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * 任务归属校验（fix #118）：上报/传产物者须为该任务原结果 agent，或当前无其他 agent 持有。
   * 防已注册 Agent 之间互相伪造结果/窃取产物。
   */
  agentOwnsJob(agentId: string, jobId: number): boolean {
    const job = this.jobs.find((j) => jobIdOf(j) === jobId);
    if (!job) return false;
    const prev = (job["result"] as { agent_id?: string } | undefined)?.agent_id;
    if (prev !== undefined && prev !== "" && prev !== agentId) return false;
    for (const [id, agent] of this.agents) {
      if (id !== agentId && Number(agent["current_job_id"]) === jobId) return false;
    }
    return true;
  }

  listAgents(): { items: Agent[]; total: number } {
    return { items: [...this.agents.values()], total: this.agents.size };
  }

  /** 新任务入队并落盘 */
  appendJob(job: Job): void {
    this.jobs.push(job);
    try {
      this.saveJob(job);
      this.saveData();
    } catch (e) {
      console.warn("[存储] 保存任务失败:", e);
    }
  }

  listJobs(): { items: Job[]; total: number } {
    return { items: [...this.jobs], total: this.jobs.length }; // 拷贝，防调用方变异内部状态（fix #121）
  }

  /** 查找任务；内存未命中时读 runs/job_<id>.json 兜底（已删除任务的历史查询） */
  findJob(id: number): Job | null {
    const hit = this.jobs.find((j) => jobIdOf(j) === id);
    if (hit) return hit;
    try {
      const raw = fs.readFileSync(path.join(this.runsDir, `job_${id}.json`), "utf-8");
      const job = JSON.parse(raw) as Job;
      if (job && typeof job === "object") return job;
    } catch {
      /* 无快照 */
    }
    return null;
  }

  /**
   * 上报结果：任务不存在返回 false。
   * 已取消（cancelled）为终态：Agent 迟到的上报被静默接受但不覆盖状态。
   */
  setJobResult(id: number, agentId: string, success: boolean, logPath: string | null, summary: Record<string, Json>): boolean {
    const job = this.jobs.find((j) => jobIdOf(j) === id);
    if (!job) return false;
    if (job["status"] === "cancelled") return true;
    job["status"] = success ? "passed" : "failed";
    job["result"] = {
      agent_id: agentId,
      success,
      log_path: logPath,
      summary: summary ?? {},
    };
    try {
      this.saveJob(job);
      this.saveData();
    } catch (e) {
      console.warn("[存储] 保存任务结果失败:", e);
    }
    return true;
  }

  /**
   * 拉取该平台下一条 pending 任务；required_skills 仅为 agent 技能子集时才匹配
   * （agent 未声明技能时可拉取任意任务，与 Python 版一致）。命中置 running 并落盘。
   */
  pollJob(platform: string, agentSkills: Set<string>): Job | null {
    for (const j of this.jobs) {
      if (j["platform"] !== platform) continue;
      if (j["status"] !== "pending") continue;
      const required = toStringSet(j["required_skills"]);
      if (required.size > 0 && agentSkills.size > 0 && !subset(required, agentSkills)) continue;
      j["status"] = "running";
      j["started_at"] = nowFloat();
      try {
        this.saveJob(j);
        this.saveData();
      } catch (e) {
        console.warn("[存储] 保存任务失败:", e);
      }
      return j;
    }
    return null;
  }

  /** 数据目录可写性探测 */
  healthCheck(): void {
    const probe = path.join(this.dataDir, ".health_probe");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  }

  /**
   * 失联超时兜底：running 超过 stale 的任务标记 failed。
   * 超时基准 started_at（缺失回退 created_at）。返回被清理的任务 ID。
   */
  reapStale(staleSeconds: number): number[] {
    const reaped: number[] = [];
    const now = nowFloat();
    for (const j of this.jobs) {
      if (j["status"] !== "running") continue;
      const started = typeof j["started_at"] === "number" ? j["started_at"] : 0;
      const created = typeof j["created_at"] === "number" ? j["created_at"] : 0;
      const base = started || created;
      if (!base || now - base < staleSeconds) continue;
      const id = jobIdOf(j);
      j["status"] = "failed";
      j["result"] = {
        agent_id: "system",
        success: false,
        log_path: null,
        summary: { message: `执行超时（${Math.round((now - base) / 60)} 分钟无结果，Agent 可能已失联）` },
      };
      try {
        this.saveJob(j);
      } catch (e) {
        console.warn("[存储] 保存任务快照失败:", e);
      }
      reaped.push(id);
    }
    if (reaped.length > 0) {
      try {
        this.saveData();
      } catch (e) {
        console.warn("[存储] 保存 jobs 失败:", e);
      }
    }
    return reaped;
  }

  /**
   * 内置执行器专用：领取一条 pending 的内置任务（platform=web 且 job_type ∈ BUILTIN_TYPES）
   * 置 running；无匹配返回 null。
   */
  claimBuiltin(): Job | null {
    for (const j of this.jobs) {
      if (j["platform"] !== "web") continue;
      if (j["status"] !== "pending") continue;
      const extra = j["extra"];
      const jt = extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, Json>)["job_type"] : undefined;
      if (typeof jt !== "string" || !BUILTIN_TYPES.has(jt)) continue;
      j["status"] = "running";
      j["started_at"] = nowFloat();
      try {
        this.saveJob(j);
        this.saveData();
      } catch (e) {
        console.warn("[存储] 保存任务失败:", e);
      }
      return j;
    }
    return null;
  }

  /** 数据管理：删除终态任务（passed/failed/cancelled），返回删除条数 */
  cleanupJobs(): number {
    const kept: Job[] = [];
    let removed = 0;
    for (const j of this.jobs) {
      const st = j["status"];
      if (st === "passed" || st === "failed" || st === "cancelled") {
        try {
          fs.rmSync(path.join(this.runsDir, `job_${jobIdOf(j)}.json`), { force: true });
        } catch {
          /* 尽力删除 */
        }
        removed++;
        continue;
      }
      kept.push(j);
    }
    if (removed === 0) return 0;
    this.jobs = kept;
    try {
      this.saveData();
    } catch (e) {
      console.warn("[存储] 保存 jobs 失败:", e);
    }
    return removed;
  }
}
