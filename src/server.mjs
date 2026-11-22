#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-client.mjs";
import { AntigravityClient, antigravityMethods } from "./antigravity-client.mjs";
import { EventBuffer } from "./event-buffer.mjs";
import { startQuickTunnel } from "./remote-tunnel.mjs";
import { bearerToken, safeJson, tokenMatches } from "./security.mjs";
import { terminalQr } from "./terminal-qr.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const host = args.remote ? "127.0.0.1" : (args.lan ? "0.0.0.0" : (args.host || "127.0.0.1"));
const localOnly = isLoopbackHost(host);
const port = Number(args.port ?? process.env.REMOTE_CODEX_PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`无效的端口号：${args.port ?? process.env.REMOTE_CODEX_PORT}\n`);
  process.exit(1);
}
const token = args.token || process.env.REMOTE_CODEX_TOKEN || randomBytes(24).toString("base64url");
const workspaceCwd = resolve(args.cwd || process.env.REMOTE_CODEX_CWD || process.cwd());
const codexCommand = resolveCodexCommand(args.codex || process.env.REMOTE_CODEX_BIN);
const codexArgs = process.env.REMOTE_CODEX_ARGS ? JSON.parse(process.env.REMOTE_CODEX_ARGS) : undefined;
const agyArgs = process.env.REMOTE_CODEX_AGY_ARGS ? JSON.parse(process.env.REMOTE_CODEX_AGY_ARGS) : undefined;
const rawAgent = args.agent || "all";
const agentMode = rawAgent === "both" ? "all" : rawAgent;
if (agentMode !== "all" && agentMode !== "codex" && agentMode !== "antigravity") {
  process.stderr.write("--agent 支持 all、codex 或 antigravity\n");
  process.exit(1);
}
const tls = await loadTls(args);

const codexMethods = new Set([
  "model/list",
  "thread/list",
  "thread/start",
  "thread/read",
  "thread/resume",
  "thread/fork",
  "thread/unsubscribe",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const PROVIDERS = {
  codex: {
    label: "Codex",
    enabled: agentMode === "all" || agentMode === "codex",
    allowedMethods: codexMethods,
    create: () => new CodexAppServer({ command: codexCommand, ...(codexArgs ? { args: codexArgs } : {}), cwd: workspaceCwd }),
  },
  antigravity: {
    label: "Antigravity",
    enabled: agentMode === "all" || agentMode === "antigravity",
    allowedMethods: antigravityMethods,
    create: () => new AntigravityClient({ command: args.agy || process.env.REMOTE_CODEX_AGY_BIN, ...(agyArgs ? { args: agyArgs } : {}), cwd: workspaceCwd }),
  },
};

const backends = new Map();
const providerErrors = new Map();
const eventClients = new Set();
const events = new EventBuffer();
const eventSession = randomBytes(8).toString("hex");
const pendingServerRequests = new Map();
let remoteTunnel = null;

for (const [name, config] of Object.entries(PROVIDERS)) {
  if (!config.enabled) continue;
  const client = config.create();
  backends.set(name, client);
  providerErrors.set(name, null);

  client.on("notification", (message) => publish("notification", { provider: name, ...message }));
  client.on("serverRequest", (message) => {
    const publicId = `${name}:${message.id}`;
    const wrapped = { ...message, id: publicId, provider: name };
    pendingServerRequests.set(publicId, { provider: name, rawId: message.id, message: wrapped });
    publish("serverRequest", wrapped);
  });
  client.on("requestResolved", ({ id }) => {
    const publicId = `${name}:${id}`;
    if (pendingServerRequests.delete(publicId)) publish("requestResolved", { id: publicId, provider: name });
  });
  client.on("ready", () => {
    providerErrors.set(name, null);
    publish("bridge", { provider: name, status: "ready", providers: getProvidersStatus() });
  });
  client.on("exit", ({ error }) => {
    providerErrors.set(name, error.message);
    for (const [publicId, entry] of [...pendingServerRequests.entries()]) {
      if (entry.provider !== name) continue;
      pendingServerRequests.delete(publicId);
      publish("requestResolved", { id: publicId, provider: name });
    }
    publish("bridge", { provider: name, status: "stopped", error: error.message, providers: getProvidersStatus() });
  });
  client.on("protocolError", (error) => {
    publish("bridge", { provider: name, status: "protocolError", error: error.message, providers: getProvidersStatus() });
  });
  client.on("log", (line) => {
    if (args.verbose && line) process.stderr.write(`[${name}] ${line}\n`);
  });
}

function getProvidersStatus() {
  const result = {};
  for (const [name, config] of Object.entries(PROVIDERS)) {
    const client = backends.get(name);
    result[name] = {
      enabled: config.enabled,
      label: config.label,
      ready: Boolean(client?.ready),
      error: providerErrors.get(name) || null,
    };
  }
  return result;
}

function anyBackendReady() {
  for (const client of backends.values()) if (client.ready) return true;
  return false;
}

function combinedError() {
  const errors = [];
  for (const [name, err] of providerErrors.entries()) {
    if (err) errors.push(`${PROVIDERS[name].label}: ${err}`);
  }
  return errors.length ? errors.join("；") : null;
}

function resolveTargetProvider(requested) {
  if (requested) {
    if (!backends.has(requested)) {
      const error = new Error(`未启用后端：${requested}`);
      error.statusCode = 400;
      throw error;
    }
    return requested;
  }
  if (backends.size === 1) return [...backends.keys()][0];
  if (backends.get("codex")?.ready) return "codex";
  if (backends.get("antigravity")?.ready) return "antigravity";
  return "codex";
}

function publish(kind, message) {
  const event = events.publish(kind, message);
  const payload = `id: ${event.seq}\ndata: ${safeJson(event)}\n\n`;
  for (const response of eventClients) response.write(payload);
}

const requestHandler = async (request, response) => {
  try {
    const url = new URL(request.url || "/", `${tls ? "https" : "http"}://${request.headers.host || "localhost"}`);
    setSecurityHeaders(response);

    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(token, bearerToken(request))) return sendJson(response, 401, { error: "配对令牌无效" });
      if (request.method === "GET" && url.pathname === "/api/status") {
        const providers = getProvidersStatus();
        return sendJson(response, 200, {
          ok: true,
          codexReady: anyBackendReady(),
          provider: agentMode,
          providers,
          error: anyBackendReady() ? null : combinedError(),
          cwd: workspaceCwd,
          transportSecure: Boolean(tls) || Boolean(args.remote) || localOnly,
          eventTransport: args.remote ? "poll" : "sse",
          eventCursor: events.sequence,
          eventSession,
          version: "0.2.0",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/events") return openEventStream(request, response);
      if (request.method === "GET" && url.pathname === "/api/events/poll") return pollEvents(url, response);
      if (request.method === "GET" && url.pathname === "/api/pending") {
        return sendJson(response, 200, { data: [...pendingServerRequests.values()].map((entry) => entry.message) });
      }
      if (request.method === "POST" && url.pathname === "/api/rpc") {
        const body = await readJson(request);
        if (!isPlainObject(body)) return sendJson(response, 400, { error: "请求格式无效" });
        const target = resolveTargetProvider(body.provider);
        const config = PROVIDERS[target];
        const client = backends.get(target);
        if (!config.allowedMethods.has(body.method)) {
          return sendJson(response, 403, { error: `不允许的 ${config.label} 方法：${body.method || "(empty)"}` });
        }
        if (!client.ready && client.ensureReady) {
          try {
            await client.ensureReady();
          } catch (error) {
            providerErrors.set(target, error.message);
            throw error;
          }
        }
        const params = isPlainObject(body.params) ? body.params : {};
        const result = await client.request(body.method, params, 120_000);
        return sendJson(response, 200, { result, provider: target });
      }
      if (request.method === "POST" && url.pathname === "/api/respond") {
        const body = await readJson(request);
        if (!isPlainObject(body)) return sendJson(response, 400, { error: "请求格式无效" });
        const key = String(body.id);
        const entry = pendingServerRequests.get(key);
        if (!entry) return sendJson(response, 404, { error: "审批请求已处理或不存在" });
        const client = backends.get(entry.provider);
        if (body.error) client.respondError(entry.rawId, body.error);
        else client.respond(entry.rawId, isPlainObject(body.result) ? body.result : {});
        pendingServerRequests.delete(key);
        publish("requestResolved", { id: key, provider: entry.provider });
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "API 不存在" });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
    return serveStatic(url.pathname, request, response);
  } catch (error) {
    const statusCode = error.statusCode || (error.code === -32600 || error.code === -32602 ? 400 : 500);
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
  await remoteTunnel?.stop();
  events.close();
  for (const response of eventClients) response.end();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  await Promise.allSettled([...backends.values()].map((client) => client.stop()));
}
process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

try {
  const startResults = await Promise.allSettled(
    [...backends.entries()].map(async ([name, client]) => {
      try {
        await client.start();
        providerErrors.set(name, null);
      } catch (error) {
        providerErrors.set(name, error.message);
        throw error;
      }
    }),
  );
  // In single-agent mode, require that backend to start; in 'all' mode, start if at least one backend is ready.
  if (agentMode !== "all" && startResults.some((item) => item.status === "rejected")) {
    const failed = startResults.find((item) => item.status === "rejected");
    throw failed.reason;
  }
  if (!anyBackendReady()) {
    throw new Error(combinedError() || "没有可用的本地 Agent 后端");
  }
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  if (args.remote) {
    const origin = `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;
    remoteTunnel = await startQuickTunnel({
      origin,
      allowedMail: args["allowed-mail"] || [],
      onLog: (line) => { if (args.verbose) process.stderr.write(`[cloudflared] ${line}`); },
      onExit: (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        shutdown("远程隧道断开").catch((shutdownError) => process.stderr.write(`${shutdownError.stack || shutdownError}\n`));
      },
    });
  }
  printStartup(remoteTunnel?.url);
} catch (error) {
  process.stderr.write(`Remote Codex 启动失败：${error.message}\n`);
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  await Promise.allSettled([...backends.values()].map((client) => client.stop()));
  process.exitCode = 1;
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`retry: 1500\ndata: ${safeJson({
    seq: events.sequence,
    at: Date.now(),
    kind: "connected",
    message: { codexReady: anyBackendReady(), providers: getProvidersStatus() },
  })}\n\n`);
  eventClients.add(response);
  request.on("close", () => eventClients.delete(response));
}

async function pollEvents(url, response) {
  const rawCursor = Number(url.searchParams.get("after") || 0);
  if (!Number.isSafeInteger(rawCursor) || rawCursor < 0) return sendJson(response, 400, { error: "事件游标无效" });
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  try {
    const truncated = events.hasGap(rawCursor);
    const data = await events.wait(rawCursor, { signal: abort.signal });
    if (!response.destroyed) {
      sendJson(response, 200, { data, cursor: events.sequence, truncated: truncated || events.hasGap(rawCursor) });
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  }
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
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--lan" || arg === "--remote" || arg === "--verbose" || arg === "--no-qr") parsed[arg.slice(2)] = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const next = inline ?? values[index + 1];
      if (inline === undefined) {
        if (next === undefined || next.startsWith("--")) throw new Error(`参数 --${key} 缺少取值`);
        index += 1;
      }
      if (key === "allowed-mail") (parsed[key] ||= []).push(next);
      else parsed[key] = next;
    }
  }
  return parsed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function resolveCodexCommand(explicit) {
  if (explicit) return explicit;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  if (process.platform !== "darwin" || !existsSync(bundled)) return "codex";
  const pathVersion = readCliVersion("codex");
  const bundledVersion = readCliVersion(bundled);
  if (bundledVersion && (!pathVersion || compareSemver(bundledVersion, pathVersion) > 0)) {
    return bundled;
  }
  return "codex";
}

function readCliVersion(command) {
  try {
    const out = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  } catch {
    return null;
  }
}

function compareSemver(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

async function loadTls(options) {
  if (!options["tls-cert"] && !options["tls-key"]) return null;
  if (!options["tls-cert"] || !options["tls-key"]) throw new Error("--tls-cert 和 --tls-key 必须一起提供");
  return {
    cert: await readFile(resolve(options["tls-cert"])),
    key: await readFile(resolve(options["tls-key"])),
  };
}

function printStartup(remoteUrl) {
  const protocol = tls ? "https" : "http";
  const addresses = remoteUrl ? [] : (args.lan ? lanAddresses() : ["127.0.0.1"]);
  const statusSummary = [...backends.keys()].map((name) => {
    const info = getProvidersStatus()[name];
    return info.ready ? `${info.label} (就绪)` : `${info.label} (未就绪: ${info.error || "不可用"})`;
  }).join(" | ");
  process.stdout.write("\nRemote Codex 已启动\n");
  process.stdout.write(`后端: ${statusSummary}\n工作目录: ${workspaceCwd}\n`);
  process.stdout.write("手机扫描二维码或打开地址完成配对（令牌仅保存在 URL # 后，不会发送到静态页面请求）：\n");
  const urls = remoteUrl
    ? [`${remoteUrl}/#token=${encodeURIComponent(token)}`]
    : addresses.map((address) => `${protocol}://${formatHost(address)}:${server.address().port}/#token=${encodeURIComponent(token)}`);
  if (!args["no-qr"]) {
    try {
      process.stdout.write(`\n${terminalQr(urls[0])}\n`);
    } catch (error) {
      process.stdout.write(`  （二维码生成失败：${error.message}，请使用下方地址）\n`);
    }
  }
  for (const url of urls) process.stdout.write(`  ${url}\n`);
  if (remoteUrl) {
    const restriction = args["allowed-mail"]?.length
      ? `，并要求 ${args["allowed-mail"].join(", ")} 完成邮箱验证`
      : "";
    process.stdout.write(`\n远程模式通过临时 HTTPS 隧道连接${restriction}；地址会在下次启动时变化。\n`);
  }
  if (!remoteUrl && !localOnly && !tls) process.stdout.write("\n注意：当前是局域网明文 HTTP。仅在可信网络使用；跨公网请配置 TLS、Tailscale Serve 或 SSH 隧道。\n");
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
