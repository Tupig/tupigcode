/**
 * Git 集成模块
 *
 * 灵感来自 Aider 的 Git 集成：
 * - 每次编辑自动提交，方便回滚
 * - 提供 diff 视图查看变更
 * - 支持 undo 回退到上一个状态
 *
 * 以及 Cline 的 Git checkpoint 机制。
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  hasChanges: boolean;
  stagedFiles: string[];
  modifiedFiles: string[];
  untrackedFiles: string[];
}

export interface GitCommit {
  hash: string;
  message: string;
  timestamp: string;
}

/**
 * 检查是否在 Git 仓库中
 */
export async function isGitRepo(workDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workDir,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 Git 状态
 */
export async function getGitStatus(workDir: string): Promise<GitStatus> {
  const defaultStatus: GitStatus = {
    isRepo: false,
    hasChanges: false,
    stagedFiles: [],
    modifiedFiles: [],
    untrackedFiles: [],
  };

  if (!(await isGitRepo(workDir))) return defaultStatus;

  try {
    const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: workDir,
      timeout: 5000,
    });

    const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workDir,
      timeout: 5000,
    });

    // 不可整体 trim：porcelain 首行「工作区修改」前导空格是语义（index 干净）（fix #128）
    const lines = statusOutput.split("\n").filter(Boolean);
    const stagedFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of lines) {
      const indexStatus = line[0];
      const worktreeStatus = line[1];
      const filename = line.slice(3);

      if (indexStatus !== " " && indexStatus !== "?") {
        stagedFiles.push(filename);
      }
      if (worktreeStatus === "M" || worktreeStatus === "D") {
        modifiedFiles.push(filename);
      }
      if (line.startsWith("??")) {
        untrackedFiles.push(filename);
      }
    }

    return {
      isRepo: true,
      branch: branch.trim(),
      hasChanges: lines.length > 0,
      stagedFiles,
      modifiedFiles,
      untrackedFiles,
    };
  } catch {
    return defaultStatus;
  }
}

/**
 * 自动暂存并提交变更
 * @param workDir 工作目录
 * @param message 提交信息
 * @param files 要提交的文件列表（为空则提交所有变更）
 */
export async function autoCommit(
  workDir: string,
  message: string,
  files?: string[],
): Promise<GitCommit | null> {
  if (!(await isGitRepo(workDir))) return null;

  try {
    if (files && files.length > 0) {
      await execFileAsync("git", ["add", ...files], { cwd: workDir, timeout: 10000 });
    } else {
      await execFileAsync("git", ["add", "-A"], { cwd: workDir, timeout: 10000 });
    }

    const { stdout: diffCached } = await execFileAsync(
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: workDir, timeout: 5000 },
    );

    if (!diffCached.trim()) return null;

    await execFileAsync(
      "git",
      ["commit", "-m", message, "--allow-empty"],
      { cwd: workDir, timeout: 10000 },
    );

    const { stdout: hash } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workDir, timeout: 5000 },
    );

    return {
      hash: hash.trim(),
      message,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 获取当前 HEAD 的 diff
 */
export async function getDiff(
  workDir: string,
  target?: string,
): Promise<string> {
  if (!(await isGitRepo(workDir))) return "";

  try {
    const args = target
      ? ["diff", target, "--stat"]
      : ["diff", "HEAD", "--stat"];
    const { stdout } = await execFileAsync("git", args, {
      cwd: workDir,
      timeout: 10000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * 获取未暂存的 diff（工作区变更）
 */
export async function getWorkingDiff(workDir: string): Promise<string> {
  if (!(await isGitRepo(workDir))) return "";

  try {
    const { stdout } = await execFileAsync("git", ["diff"], {
      cwd: workDir,
      timeout: 10000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * 撤销上次提交（保留文件变更）
 */
export async function undoLastCommit(workDir: string): Promise<boolean> {
  if (!(await isGitRepo(workDir))) return false;

  try {
    await execFileAsync("git", ["reset", "--soft", "HEAD~1"], {
      cwd: workDir,
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 格式化 Git 状态为可读文本
 */
export function formatGitStatus(status: GitStatus): string {
  if (!status.isRepo) return "不在 Git 仓库中";

  const lines: string[] = [];
  lines.push(`分支：${status.branch || "detached"}`);

  if (!status.hasChanges) {
    lines.push("工作区干净");
  } else {
    if (status.stagedFiles.length > 0) {
      lines.push(`已暂存：${status.stagedFiles.join(", ")}`);
    }
    if (status.modifiedFiles.length > 0) {
      lines.push(`已修改：${status.modifiedFiles.join(", ")}`);
    }
    if (status.untrackedFiles.length > 0) {
      lines.push(`未跟踪：${status.untrackedFiles.join(", ")}`);
    }
  }

  return lines.join("\n");
}
