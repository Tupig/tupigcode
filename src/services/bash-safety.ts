/**
 * services/bashSafety.ts — Bash 命令危险度分级（A7：auto 权限分级）
 * safe → 默认放行；mutate → 需审批；destructive → 需审批且标危险
 */

export type BashSafety = "safe" | "mutate" | "destructive";

const SAFE_PREFIXES = [
  "ls", "cat", "head", "tail", "wc", "pwd", "whoami", "which", "echo", "date",
  "git status", "git log", "git diff", "git show", "git branch", "git remote -v",
  "grep", "rg", "find", "fd", "du", "df", "ps", "env", "printenv", "uname",
  "node --version", "npm ls", "npm list", "npm outdated", "python --version",
  "pip list", "pip show", "cargo --version", "rustc --version", "go version",
  "make -n", "npx tsc --noEmit", "tsc --noEmit", "bash -n", "shellcheck",
  "pytest --collect-only", "vitest list", "xxd", "file", "stat", "realpath",
  "readlink", "basename", "dirname", "sort", "uniq", "cut", "awk", "sed -n",
  "diff", "md5", "shasum", "true", "false", "test", "[", "jq", "man", "help",
  "--help", "-h", "v", "-v", "--version",
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\bsudo\b/,
  /\bdd\b.*\bof=/,
  /chmod\s+(-R\s+)?777/,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\b/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill(all)?\b/,
  /:\s*\(\)\s*\{/, // fork bomb
  /curl[^|]*\|\s*(sh|bash)/,
  /wget[^|]*\|\s*(sh|bash)/,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\b/,
  /\bformat\b\s+[a-z]:/i,
  /\/dev\/(sd|disk|nvme)/,
  /<<\s*['"]?EOF/, // heredoc overwrite risk handled by mutate fallback
];

const MUTATE_PATTERNS: RegExp[] = [
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\brmdir\b/,
  /\bsed\b(?!\s+-n)/,
  /\btee\b/,
  /\btruncate\b/,
  /\binstall\b/,
  /\b(npm|pnpm|yarn|bun)\s+(add|install|remove|uninstall|update|upgrade|run|publish|link|ci)\b/,
  /\bpip3?\s+(install|uninstall)\b/,
  /\b(uv|poetry|cargo)\s+(add|remove|install|publish)\b/,
  /\bgit\s+(add|commit|merge|rebase|cherry-pick|checkout|switch|restore|stash|tag|push|pull|fetch|reset|clean|mv|rm)\b/,
  /\bgo\s+(get|mod)\b/,
  /\bmkdir\b/,
  />>?/, // 重定向写入
  /\bwrite\b/i,
];

function stripQuoted(s: string): string {
  return s
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "``");
}

export function classifyBash(command: string): BashSafety {
  if (DESTRUCTIVE_PATTERNS.some((re) => re.test(command))) return "destructive";

  const parts = command
    .split(/&&|\|\||;|\|/)
    .map((p) => stripQuoted(p).trim())
    .filter(Boolean);
  if (parts.length === 0) return "safe";

  let worst: BashSafety = "safe";
  const bump = (s: BashSafety) => {
    if (s === "destructive") worst = "destructive";
    else if (s === "mutate" && worst !== "destructive") worst = "mutate";
  };

  for (const part of parts) {
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(part))) {
      bump("destructive");
      continue;
    }
    if (MUTATE_PATTERNS.some((re) => re.test(part))) {
      bump("mutate");
      continue;
    }
    const matchedSafe = SAFE_PREFIXES.some(
      (p) => part === p || part.startsWith(p + " "),
    );
    if (matchedSafe) continue;
    bump("mutate");
  }
  return worst;
}
