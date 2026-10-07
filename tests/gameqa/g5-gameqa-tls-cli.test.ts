/**
 * G5 gameqa TLS 证书 + CLI（serve/agent 入口）。
 * serve 用 tsx 起真实进程（--tls off 与 auto 两条路径），断言健康检查与优雅停机。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import { ensureTLSCertificate, fingerprintFromPem } from "../../src/gameqa/tls";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gameqa-tls-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureTLSCertificate", () => {
  it("生成自签名证书：ECDSA/SAN/5年/指纹格式/密钥权限，且跨调用复用", () => {
    const first = ensureTLSCertificate(dir, "", "");
    expect(first.selfSigned).toBe(true);
    expect(fs.existsSync(first.certFile)).toBe(true);
    expect(fs.existsSync(first.keyFile)).toBe(true);
    // Go 版格式：大写 hex 冒号分隔，32 字节
    expect(first.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // 密钥 0600
    expect(fs.statSync(first.keyFile).mode & 0o777).toBe(0o600);

    // 第二次调用复用同一证书
    const second = ensureTLSCertificate(dir, "", "");
    expect(second.certFile).toBe(first.certFile);
    expect(second.fingerprint).toBe(first.fingerprint);

    // SAN 覆盖 localhost / 127.0.0.1；有效期约 5 年
    const cert = new X509Certificate(fs.readFileSync(first.certFile));
    expect(cert.subjectAltName).toContain("localhost");
    expect(cert.subjectAltName).toContain("127.0.0.1");
    const years = (new Date(cert.validTo).getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(4.5);
    expect(years).toBeLessThan(5.5);
    expect(fingerprintFromPem(fs.readFileSync(first.certFile))).toBe(first.fingerprint);
  });

  it("用户证书优先（TLS_CERT/TLS_KEY）", () => {
    const gen = ensureTLSCertificate(path.join(dir, "gen"), "", "");
    const user = ensureTLSCertificate(dir, gen.certFile, gen.keyFile);
    expect(user.selfSigned).toBe(false);
    expect(user.certFile).toBe(gen.certFile);
    expect(user.fingerprint).toBe(gen.fingerprint);
  });

  it("损坏证书自动重新生成", () => {
    const first = ensureTLSCertificate(dir, "", "");
    fs.writeFileSync(first.certFile, "broken");
    const regen = ensureTLSCertificate(dir, "", "");
    expect(regen.fingerprint).not.toBe(first.fingerprint);
    expect(regen.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

function freePort(): number {
  return 19000 + Math.floor(Math.random() * 3000);
}

function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = async (): Promise<void> => {
      if (proc.exitCode !== null) {
        reject(new Error(`serve 进程提前退出 code=${String(proc.exitCode)}`));
        return;
      }
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
          resolve(await resp.text());
          return;
        }
      } catch {
        /* 未就绪 */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("等待 serve 就绪超时"));
        return;
      }
      setTimeout(() => void attempt(), 300);
    };
    void attempt();
  });
}

async function spawnCli(args: string[]): Promise<{ proc: ChildProcess; logs: () => string; exited: Promise<number | null> }> {
  // node --import tsx 单进程直跑：npx/npm wrapper 与 tsx 子进程都会吞 SIGTERM（exit code 为 null）
  const proc = spawn(process.execPath, ["--import", "tsx", "src/cli/gameqa.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, logs: () => out, exited };
}

describe("gameqa CLI serve", () => {
  it("--tls off：健康检查 + 静态看板 + SIGTERM 优雅退出", async () => {
    const port = freePort();
    const dataDir = path.join(dir, "data");
    const { proc, logs, exited } = await spawnCli([
      "serve", "--tls", "off", "-p", String(port), "-d", dataDir, "-s", path.join(ROOT, "src", "gameqa", "static"),
    ]);
    try {
      const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, proc);
      expect(JSON.parse(health).ok).toBe(true);
      const idx = await fetch(`http://127.0.0.1:${port}/`);
      expect(idx.status).toBe(200);
      expect(await idx.text()).toContain("</html>");
      expect(logs()).toContain("TLS 已关闭");
    } finally {
      proc.kill("SIGTERM");
    }
    const code = await exited;
    expect(code).toBe(0);
    expect(logs()).toContain("排水");
  }, 40_000);

  it("--tls auto：自签证书 HTTPS 服务 + 指纹日志", async () => {
    const port = freePort();
    const dataDir = path.join(dir, "data-tls");
    const { proc, logs, exited } = await spawnCli([
      "serve", "-p", String(port), "-d", dataDir, "-s", path.join(ROOT, "src", "gameqa", "static"),
    ]);
    try {
      // 等证书生成
      const certPath = path.join(dataDir, "tls", "cert.pem");
      const certStart = Date.now();
      while (!fs.existsSync(certPath)) {
        if (proc.exitCode !== null) throw new Error(`serve 进程提前退出: ${logs()}`);
        if (Date.now() - certStart > 20_000) throw new Error("证书生成超时");
        await new Promise((r) => setTimeout(r, 200));
      }
      const certPem = fs.readFileSync(certPath);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const attempt = (): void => {
          if (proc.exitCode !== null) {
            reject(new Error(`serve 进程提前退出: ${logs()}`));
            return;
          }
          const req = https.request(
            { host: "127.0.0.1", port, path: "/api/health", method: "GET", ca: certPem, servername: "localhost", timeout: 2000 },
            (resp) => {
              let body = "";
              resp.on("data", (c: Buffer) => (body += c));
              resp.on("end", () => {
                if (resp.statusCode === 200) resolve();
                else reject(new Error(`HTTP ${String(resp.statusCode)}`));
              });
            },
          );
          req.on("error", () => {
            if (Date.now() - start > 20_000) reject(new Error("HTTPS 就绪超时"));
            else setTimeout(attempt, 300);
          });
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.end();
        };
        attempt();
      });
      expect(logs()).toContain("TLS 指纹(SHA-256): ");
      expect(logs()).toMatch(/TLS 指纹\(SHA-256\): ([0-9A-F]{2}:){31}[0-9A-F]{2}/);
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  }, 40_000);

  it("--version 打印后退出", async () => {
    const { proc, logs, exited } = await spawnCli(["--version"]);
    expect(await exited).toBe(0);
    expect(logs()).toMatch(/\b\d+\.\d+\.\d+\b/);
  }, 30_000);
});
