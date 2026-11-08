#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-client.mjs";
import { bearerToken, safeJson, tokenMatches } from "./security.mjs";
import { terminalQr } from "./terminal-qr.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const args = parseArgs(process.argv.slice(2));
const host = args.lan ? "0.0.0.0" : (args.host || "127.0.0.1");
const port = Number(args.port || process.env.REMOTE_CODEX_PORT || 4173);
const token = args.token || process.env.REMOTE_CODEX_TOKEN || randomBytes(24).toString("base64url");
const codexCwd = resolve(args.cwd || process.env.REMOTE_CODEX_CWD || process.cwd());
const codexCommand = args.codex || process.env.REMOTE_CODEX_BIN || "codex";
const tls = await loadTls(args);

const allowedMethods = new Set([
  "model/list",
  "thread/list",
  "thread/start",
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const codex = new CodexAppServer({ command: codexCommand, cwd: codexCwd });
const eventClients = new Set();
const pendingServerRequests = new Map();
let sequence = 0;
let lastError = null;

function publish(kind, message) {
  const event = { seq: ++sequence, at: Date.now(), kind, message };
  const payload = `id: ${event.seq}\ndata: ${safeJson(event)}\n\n`;
  for (const response of eventClients) response.write(payload);
}

codex.on("notification", (message) => publish("notification", message));
codex.on("serverRequest", (message) => {
  pendingServerRequests.set(String(message.id), message);
  publish("serverRequest", message);
});
codex.on("ready", () => {
  lastError = null;
  publish("bridge", { status: "ready" });
});
codex.on("exit", ({ error }) => {
  lastError = error.message;
  publish("bridge", { status: "stopped", error: error.message });
});
codex.on("protocolError", (error) => publish("bridge", { status: "protocolError", error: error.message }));
codex.on("log", (line) => {
  if (args.verbose && line) process.stderr.write(`[codex] ${line}\n`);
});

const requestHandler = async (request, response) => {
  try {
    const url = new URL(request.url || "/", `${tls ? "https" : "http"}://${request.headers.host || "localhost"}`);
    setSecurityHeaders(response);

    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(token, bearerToken(request))) return sendJson(response, 401, { error: "配对令牌无效" });
      if (request.method === "GET" && url.pathname === "/api/status") {
        return sendJson(response, 200, {
          ok: true,
          codexReady: codex.ready,
          error: lastError,
          cwd: codexCwd,
          transportSecure: Boolean(tls) || !args.lan,
          version: "0.1.0",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/events") return openEventStream(request, response);
      if (request.method === "GET" && url.pathname === "/api/pending") {
        return sendJson(response, 200, { data: [...pendingServerRequests.values()] });
      }
      if (request.method === "POST" && url.pathname === "/api/rpc") {
        const body = await readJson(request);
        if (!allowedMethods.has(body.method)) return sendJson(response, 403, { error: `不允许的 Codex 方法：${body.method || "(empty)"}` });
        const result = await codex.request(body.method, body.params || {}, 120_000);
        return sendJson(response, 200, { result });
      }
      if (request.method === "POST" && url.pathname === "/api/respond") {
        const body = await readJson(request);
        const key = String(body.id);
        if (!pendingServerRequests.has(key)) return sendJson(response, 404, { error: "审批请求已处理或不存在" });
        pendingServerRequests.delete(key);
        if (body.error) codex.respondError(body.id, body.error);
        else codex.respond(body.id, body.result || {});
        publish("requestResolved", { id: body.id });
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "API 不存在" });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
    return serveStatic(url.pathname, request, response);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) process.stderr.write(`${error.stack || error}\n`);
    if (!response.headersSent) sendJson(response, statusCode, { error: error.message || "Internal server error" });
    else response.end();
  }
};

const server = tls ? createHttpsServer(tls, requestHandler) : createHttpServer(requestHandler);
server.requestTimeout = 130_000;
server.headersTimeout = 135_000;

const heartbeat = setInterval(() => {
  for (const response of eventClients) response.write(`: keepalive ${Date.now()}\n\n`);
}, 20_000);
heartbeat.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n收到 ${signal}，正在停止 Remote Codex…\n`);
  clearInterval(heartbeat);
  for (const response of eventClients) response.end();
  await new Promise((resolveClose) => server.close(resolveClose));
  await codex.stop();
}
process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

try {
  await codex.start();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  printStartup();
} catch (error) {
  process.stderr.write(`Remote Codex 启动失败：${error.message}\n`);
  await codex.stop();
  process.exitCode = 1;
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`retry: 1500\ndata: ${safeJson({ seq: sequence, at: Date.now(), kind: "connected", message: { codexReady: codex.ready } })}\n\n`);
  eventClients.add(response);
  request.on("close", () => eventClients.delete(response));
}

async function serveStatic(pathname, request, response) {
  const relative = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = resolve(publicDir, `.${relative}`);
  if (file !== publicDir && !file.startsWith(`${publicDir}${sep}`)) return sendJson(response, 403, { error: "Forbidden" });
  let info;
  try {
    info = await stat(file);
  } catch {
    return sendJson(response, 404, { error: "Not found" });
  }
  if (!info.isFile()) return sendJson(response, 404, { error: "Not found" });
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": info.size,
    // The bridge is a local app, so always revalidate its tiny shell. This keeps
    // phones from holding an older UI after the desktop process is upgraded.
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    const error = new Error("JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, value) {
  const body = safeJson(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--lan" || arg === "--verbose" || arg === "--no-qr") parsed[arg.slice(2)] = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      parsed[key] = inline ?? values[++index];
    }
  }
  return parsed;
}

async function loadTls(options) {
  if (!options["tls-cert"] && !options["tls-key"]) return null;
  if (!options["tls-cert"] || !options["tls-key"]) throw new Error("--tls-cert 和 --tls-key 必须一起提供");
  return {
    cert: await readFile(resolve(options["tls-cert"])),
    key: await readFile(resolve(options["tls-key"])),
  };
}

function printStartup() {
  const protocol = tls ? "https" : "http";
  const addresses = args.lan ? lanAddresses() : ["127.0.0.1"];
  process.stdout.write("\nRemote Codex 已启动\n");
  process.stdout.write(`工作目录: ${codexCwd}\n`);
  process.stdout.write("手机扫描二维码或打开地址完成配对（令牌仅保存在 URL # 后，不会发送到静态页面请求）：\n");
  const urls = addresses.map((address) => `${protocol}://${formatHost(address)}:${port}/#token=${encodeURIComponent(token)}`);
  if (!args["no-qr"]) {
    try {
      process.stdout.write(`\n${terminalQr(urls[0])}\n`);
    } catch (error) {
      process.stdout.write(`  （二维码生成失败：${error.message}，请使用下方地址）\n`);
    }
  }
  for (const url of urls) process.stdout.write(`  ${url}\n`);
  if (args.lan && !tls) process.stdout.write("\n注意：当前是局域网明文 HTTP。仅在可信网络使用；跨公网请配置 TLS、Tailscale Serve 或 SSH 隧道。\n");
  process.stdout.write("按 Ctrl+C 停止。\n\n");
}

function lanAddresses() {
  const values = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) if (!entry.internal && entry.family === "IPv4") values.push(entry.address);
  }
  return values.length ? [...new Set(values)] : ["127.0.0.1"];
}

function formatHost(value) {
  return value.includes(":") ? `[${value}]` : value;
}

function contentType(file) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[extname(file)] || "application/octet-stream";
}
