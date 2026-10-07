/**
 * N5 沙箱：允许写目录 + 敏感路径拦截（A8）
 */
import { describe, expect, it, afterEach } from "vitest";
import { resolveSandboxPolicy, checkPath, checkBashPaths } from "../../src/services/sandbox";

const ENV_KEYS = ["TUPIG_SANDBOX_WRITE", "TUPIG_SANDBOX_DENY"] as const;
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k as string];
});

describe("resolveSandboxPolicy", () => {
  it("默认：workDir 外不可写、敏感路径拦截", () => {
    const p = resolveSandboxPolicy("/work");
    expect(p.allowedWrite).toEqual(["/work"]);
    expect(p.blocked.some((b) => b.includes(".ssh"))).toBe(true);
  });
  it("env 追加允许写目录与额外拦截", () => {
    process.env.TUPIG_SANDBOX_WRITE = "/tmp/x:/data";
    process.env.TUPIG_SANDBOX_DENY = "/secret";
    const p = resolveSandboxPolicy("/work");
    expect(p.allowedWrite).toContain("/tmp/x");
    expect(p.allowedWrite).toContain("/data");
    expect(p.blocked).toContain("/secret");
  });
});

describe("checkPath", () => {
  const p = resolveSandboxPolicy("/work");
  it("workDir 内写 → allow", () => {
    expect(checkPath(p, "/work/src/a.ts", "write")).toBe("allow");
  });
  it("workDir 外写 → deny", () => {
    expect(checkPath(p, "/etc/cron.d/x", "write")).toBe("deny");
  });
  it("敏感路径读 → deny（.ssh 私钥）", () => {
    expect(checkPath(p, "/home/u/.ssh/id_rsa", "read")).toBe("deny");
    expect(checkPath(p, "/etc/shadow", "read")).toBe("deny");
  });
  it("普通读 → allow", () => {
    expect(checkPath(p, "/usr/share/doc/x", "read")).toBe("allow");
    expect(checkPath(p, "/work/README.md", "read")).toBe("allow");
  });
  it("白名单目录写 → allow", () => {
    const p2 = resolveSandboxPolicy("/work");
    process.env.TUPIG_SANDBOX_WRITE = "/tmp/x";
    const p3 = resolveSandboxPolicy("/work");
    expect(checkPath(p3, "/tmp/x/out.txt", "write")).toBe("allow");
    expect(checkPath(p2, "/tmp/x/out.txt", "write")).toBe("deny");
  });
});

describe("checkBashPaths 命令参数拦截", () => {
  const p = resolveSandboxPolicy("/work");
  it("写敏感路径的命令 → deny", () => {
    expect(checkBashPaths(p, "rm -rf /etc")).toBe("deny");
    expect(checkBashPaths(p, "echo x > /etc/hosts")).toBe("deny");
    expect(checkBashPaths(p, "cp a ~/.ssh/authorized_keys")).toBe("deny");
  });
  it("读敏感私钥 → deny", () => {
    expect(checkBashPaths(p, "cat ~/.ssh/id_rsa")).toBe("deny");
    expect(checkBashPaths(p, "cat /etc/shadow")).toBe("deny");
  });
  it("普通命令 → allow", () => {
    expect(checkBashPaths(p, "ls -la")).toBe("allow");
    expect(checkBashPaths(p, "cat /work/src/index.ts")).toBe("allow");
    expect(checkBashPaths(p, "npm test")).toBe("allow");
  });
});
