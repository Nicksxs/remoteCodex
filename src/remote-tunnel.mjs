import { spawn } from "node:child_process";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export function extractQuickTunnelUrl(value) {
  return String(value).match(QUICK_TUNNEL_URL)?.[0] || null;
}

export function startQuickTunnel({
  origin,
  allowedMail = [],
  command = process.env.REMOTE_CODEX_TUNNEL_BIN || "cloudflared",
  timeoutMs = 30_000,
  onLog = () => {},
  onExit = () => {},
} = {}) {
  if (!origin) throw new Error("远程隧道缺少本地服务地址");

  const commandArgs = ["tunnel", "--no-autoupdate", "--url", origin];
  for (const address of allowedMail) {
    const trimmed = typeof address === "string" ? address.trim() : "";
    if (!trimmed || trimmed.startsWith("-")) throw new Error(`无效的 --allowed-mail 参数：${address ?? ""}`);
    commandArgs.push("--allowed-mail", trimmed);
  }
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopping = false;
    let output = "";
    const timer = setTimeout(() => fail(new Error("创建远程隧道超时，请检查网络后重试")), timeoutMs);

    const stop = async () => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      await new Promise((resolveExit) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(forceTimer);
          clearTimeout(giveUpTimer);
          resolveExit();
        };
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 3000);
        const giveUpTimer = setTimeout(finish, 5000);
        child.once("exit", finish);
        if (!child.kill("SIGTERM")) finish();
      });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      reject(error);
    };

    const consume = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-16_384);
      onLog(text);
      const url = extractQuickTunnelUrl(output);
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, stop, process: child });
    };

    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      const message = error.code === "ENOENT"
        ? "未找到 cloudflared。macOS 可先运行 brew install cloudflared"
        : `无法启动 cloudflared：${error.message}`;
      fail(new Error(message));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        return fail(new Error(`远程隧道启动失败（${signal || `退出码 ${code}`}）`));
      }
      if (!stopping) onExit(new Error(`远程隧道已断开（${signal || `退出码 ${code}`}）`));
    });
  });
}
