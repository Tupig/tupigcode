/**
 * Plan/Act 模式分离
 *
 * 灵感来自 Cline 的 Plan/Act 模式：
 * - Plan 模式：只读工具，用于探索和规划
 * - Act 模式：所有工具，用于执行修改
 *
 * 以及 Aider 的 Architect/Editor 双模型架构。
 */
import type { Tool, PermissionMode } from "../engine/Tool.js";

export type AgentMode = "plan" | "act";

export interface ModeConfig {
  /** 模式名称 */
  name: AgentMode;
  /** 允许的工具名称（为空则允许所有） */
  allowedTools: string[];
  /** 禁止的工具名称 */
  disabledTools: string[];
  /** 权限模式 */
  permissionMode: PermissionMode;
  /** 模式描述 */
  description: string;
}

/**
 * Plan 模式配置：只读探索
 */
export const PLAN_MODE: ModeConfig = {
  name: "plan",
  allowedTools: [],
  disabledTools: ["Write", "Edit", "Bash", "GitCommit", "GitUndo", "Agent", "Task"],
  permissionMode: "plan",
  description: "只读模式：只能读取文件和搜索代码，不能修改",
};

/**
 * Act 模式配置：完整执行
 */
export const ACT_MODE: ModeConfig = {
  name: "act",
  allowedTools: [],
  disabledTools: [],
  permissionMode: "bypassPermissions",
  description: "执行模式：可以使用所有工具进行修改",
};

/**
 * 获取模式配置
 */
export function getModeConfig(mode: AgentMode): ModeConfig {
  return mode === "plan" ? PLAN_MODE : ACT_MODE;
}

/**
 * 检查工具是否在当前模式下可用
 */
export function isToolAvailable(
  tool: Tool,
  mode: AgentMode,
  customAllowed?: string[],
  customDisabled?: string[],
): boolean {
  const config = getModeConfig(mode);

  const allowed = customAllowed?.length ? customAllowed : config.allowedTools;
  const disabled = customDisabled?.length ? customDisabled : config.disabledTools;

  if (allowed.length > 0) {
    return allowed.includes(tool.name);
  }

  if (disabled.includes(tool.name)) {
    return false;
  }

  return true;
}

/**
 * 过滤工具列表（根据模式）
 */
export function filterToolsByMode(
  tools: Tool[],
  mode: AgentMode,
  customAllowed?: string[],
  customDisabled?: string[],
): Tool[] {
  return tools.filter((tool) =>
    isToolAvailable(tool, mode, customAllowed, customDisabled),
  );
}

/**
 * 模式切换信息
 */
export interface ModeSwitch {
  from: AgentMode;
  to: AgentMode;
  timestamp: number;
  reason?: string;
}

/**
 * 模式管理器
 */
export class ModeManager {
  private currentMode: AgentMode = "act";
  private history: ModeSwitch[] = [];

  constructor(initialMode: AgentMode = "act") {
    this.currentMode = initialMode;
  }

  /** 获取当前模式 */
  get mode(): AgentMode {
    return this.currentMode;
  }

  /** 获取模式配置 */
  get config(): ModeConfig {
    return getModeConfig(this.currentMode);
  }

  /** 切换模式 */
  switchTo(mode: AgentMode, reason?: string): ModeSwitch {
    const from = this.currentMode;
    const switchInfo: ModeSwitch = {
      from,
      to: mode,
      timestamp: Date.now(),
      reason,
    };

    this.currentMode = mode;
    this.history.push(switchInfo);

    return switchInfo;
  }

  /** 切换到 Plan 模式 */
  enterPlan(reason?: string): ModeSwitch {
    return this.switchTo("plan", reason);
  }

  /** 切换到 Act 模式 */
  enterAct(reason?: string): ModeSwitch {
    return this.switchTo("act", reason);
  }

  /** 获取切换历史 */
  getHistory(): ModeSwitch[] {
    return [...this.history];
  }

  /** 检查工具是否可用 */
  isToolAvailable(tool: Tool): boolean {
    return isToolAvailable(tool, this.currentMode);
  }

  /** 过滤可用工具 */
  filterTools(tools: Tool[]): Tool[] {
    return filterToolsByMode(tools, this.currentMode);
  }
}
