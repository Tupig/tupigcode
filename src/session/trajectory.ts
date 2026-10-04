/**
 * 轨迹记录与回放系统
 *
 * 灵感来自 SWE-agent 的 trajectory recording：
 * - 记录完整的交互轨迹
 * - 支持回放和调试
 * - 可导出为多种格式
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { TRAJECTORY_MAX_EVENTS, TRAJECTORY_RESULT_MAX_CHARS, TRAJECTORY_KEEP_FILES } from "../engine/constants.js";

export type TrajectoryEventType =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "compaction"
  | "permission"
  | "error"
  | "system";

export interface TrajectoryEvent {
  /** 事件类型 */
  type: TrajectoryEventType;
  /** 时间戳 */
  timestamp: number;
  /** 事件数据 */
  data: Record<string, unknown>;
  /** 耗时（毫秒） */
  duration?: number;
}

export interface Trajectory {
  /** 会话 ID */
  sessionId: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 事件列表 */
  events: TrajectoryEvent[];
  /** 元数据 */
  metadata: {
    model: string;
    workDir: string;
    totalTokens?: { input: number; output: number };
  };
}

/** 同 ms save 的全局序号后缀，防文件名冲突互相覆盖（模块级：跨 recorder 实例也唯一） */
let globalSaveSeq = 0;

/**
 * 轨迹记录器
 */
export class TrajectoryRecorder {
  private trajectory: Trajectory;
  private enabled: boolean;
  private savePath?: string;
  /** 环形丢弃计数（issue #94）：超上限被挤出的最旧事件数 */
  private dropped = 0;

  constructor(
    sessionId: string,
    model: string,
    workDir: string,
    options?: { enabled?: boolean; savePath?: string },
  ) {
    this.enabled = options?.enabled ?? true;
    this.savePath = options?.savePath;
    this.trajectory = {
      sessionId,
      startTime: Date.now(),
      events: [],
      metadata: { model, workDir },
    };

    if (this.savePath && !existsSync(this.savePath)) {
      mkdirSync(this.savePath, { recursive: true });
    }
  }

  /** 记录事件（环形上限：超限丢最旧并计 dropped，issue #94） */
  record(type: TrajectoryEventType, data: Record<string, unknown>, duration?: number): void {
    if (!this.enabled) return;

    this.trajectory.events.push({
      type,
      timestamp: Date.now(),
      data,
      duration,
    });
    while (this.trajectory.events.length > TRAJECTORY_MAX_EVENTS) {
      this.trajectory.events.shift();
      this.dropped++;
    }
  }

  /** 环形期间被丢弃的事件数 */
  getDropped(): number {
    return this.dropped;
  }

  /** 记录用户消息 */
  recordUserMessage(message: string): void {
    this.record("user_message", { message });
  }

  /** 记录助手消息 */
  recordAssistantMessage(message: string, toolCalls?: unknown[]): void {
    this.record("assistant_message", { message, toolCalls });
  }

  /** 记录工具调用 */
  recordToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string): void {
    this.record("tool_use", { toolName, input, toolUseId });
  }

  /** 记录工具结果（入库前截断，issue #94） */
  recordToolResult(toolUseId: string, result: string, isError: boolean, duration: number): void {
    const clipped =
      result.length > TRAJECTORY_RESULT_MAX_CHARS
        ? result.slice(0, TRAJECTORY_RESULT_MAX_CHARS - 1) + "…"
        : result;
    this.record("tool_result", { toolUseId, result: clipped, isError }, duration);
  }

  /** 记录压缩 */
  recordCompaction(beforeCount: number, afterCount: number): void {
    this.record("compaction", { beforeCount, afterCount });
  }

  /** 记录错误 */
  recordError(error: string, context?: Record<string, unknown>): void {
    this.record("error", { error, ...context });
  }

  /** 记录系统事件 */
  recordSystem(subtype: string, data: Record<string, unknown>): void {
    this.record("system", { subtype, ...data });
  }

  /** 完成记录 */
  finish(): Trajectory {
    this.trajectory.endTime = Date.now();
    return this.trajectory;
  }

  /** 获取轨迹 */
  getTrajectory(): Trajectory {
    return { ...this.trajectory };
  }

  /** 保存轨迹到文件（同 sessionId 只留最近 N 份，issue #94） */
  save(): string | null {
    const saveDir = this.savePath;
    if (!saveDir) return null;

    const seq = globalSaveSeq++ === 0 ? "" : `-${globalSaveSeq}`;
    const filename = `trajectory-${this.trajectory.sessionId}-${Date.now()}${seq}.json`;
    const filepath = join(saveDir, filename);

    try {
      writeFileSync(filepath, JSON.stringify(this.trajectory, null, 2), "utf-8");
    } catch {
      return null;
    }

    // 滚动清理：只留最近 TRAJECTORY_KEEP_FILES 份（不动其他 sessionId）
    try {
      const prefix = `trajectory-${this.trajectory.sessionId}-`;
      const mine = readdirSync(saveDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .map((f) => ({ f, m: statSync(join(saveDir, f)).mtimeMs }))
        .sort((a, b) => a.m - b.m);
      for (const { f } of mine.slice(0, Math.max(0, mine.length - TRAJECTORY_KEEP_FILES))) {
        unlinkSync(join(saveDir, f));
      }
    } catch { /* 清理失败不影响已写入的轨迹 */ }
    return filepath;
  }
}

/**
 * 轨迹回放器
 */
export class TrajectoryReplayer {
  private trajectory: Trajectory;
  private currentIndex = 0;

  constructor(trajectory: Trajectory) {
    this.trajectory = trajectory;
  }

  /** 从文件加载轨迹 */
  static fromFile(filePath: string): TrajectoryReplayer | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const trajectory = JSON.parse(content) as Trajectory;
      return new TrajectoryReplayer(trajectory);
    } catch {
      return null;
    }
  }

  /** 获取下一个事件 */
  next(): TrajectoryEvent | null {
    if (this.currentIndex >= this.trajectory.events.length) {
      return null;
    }
    return this.trajectory.events[this.currentIndex++];
  }

  /** 获取所有事件 */
  getAll(): TrajectoryEvent[] {
    return [...this.trajectory.events];
  }

  /** 按类型过滤事件 */
  filterByType(type: TrajectoryEventType): TrajectoryEvent[] {
    return this.trajectory.events.filter((e) => e.type === type);
  }

  /** 获取统计信息 */
  getStats(): {
    totalEvents: number;
    toolCalls: number;
    errors: number;
    totalDuration: number;
    avgToolDuration: number;
  } {
    const events = this.trajectory.events;
    const toolResults = events.filter((e) => e.type === "tool_result");
    const errors = events.filter((e) => e.type === "error");

    const totalDuration =
      (this.trajectory.endTime ?? Date.now()) - this.trajectory.startTime;

    const totalToolDuration = toolResults.reduce(
      (sum, e) => sum + (e.duration ?? 0),
      0,
    );

    return {
      totalEvents: events.length,
      toolCalls: toolResults.length,
      errors: errors.length,
      totalDuration,
      avgToolDuration:
        toolResults.length > 0 ? totalToolDuration / toolResults.length : 0,
    };
  }

  /** 导出为 Markdown 格式 */
  exportMarkdown(): string {
    const lines: string[] = [
      `# 轨迹回放 - ${this.trajectory.sessionId}`,
      "",
      `模型：${this.trajectory.metadata.model}`,
      `工作目录：${this.trajectory.metadata.workDir}`,
      `开始时间：${new Date(this.trajectory.startTime).toISOString()}`,
      "",
      "## 事件",
      "",
    ];

    for (const event of this.trajectory.events) {
      const time = new Date(event.timestamp).toISOString().slice(11, 19);

      switch (event.type) {
        case "user_message":
          lines.push(`### [${time}] 用户`);
          lines.push(event.data.message as string);
          lines.push("");
          break;
        case "assistant_message":
          lines.push(`### [${time}] 助手`);
          lines.push(event.data.message as string);
          lines.push("");
          break;
        case "tool_use":
          lines.push(`### [${time}] 工具调用：${event.data.toolName}`);
          lines.push("```json");
          lines.push(JSON.stringify(event.data.input, null, 2));
          lines.push("```");
          lines.push("");
          break;
        case "tool_result":
          const errMark = event.data.isError ? "，失败" : "";
          lines.push(`### [${time}] 工具结果（${event.duration}ms${errMark}）`);
          lines.push("```");
          lines.push((event.data.result as string).slice(0, 500));
          lines.push("```");
          lines.push("");
          break;
        case "error":
          lines.push(`### [${time}] 错误`);
          lines.push(`\`\`\`\n${event.data.error}\n\`\`\``);
          lines.push("");
          break;
      }
    }

    // 统计信息
    const stats = this.getStats();
    lines.push("## 统计");
    lines.push(`- 总事件数：${stats.totalEvents}`);
    lines.push(`- 工具调用：${stats.toolCalls}`);
    lines.push(`- 错误数：${stats.errors}`);
    lines.push(`- 总耗时：${stats.totalDuration}ms`);
    lines.push(
      `- 平均工具耗时：${stats.avgToolDuration.toFixed(0)}ms`,
    );

    return lines.join("\n");
  }
}

/**
 * 创建轨迹记录器
 */
export function createTrajectoryRecorder(
  sessionId: string,
  model: string,
  workDir: string,
  options?: { enabled?: boolean; savePath?: string },
): TrajectoryRecorder {
  return new TrajectoryRecorder(sessionId, model, workDir, options);
}
