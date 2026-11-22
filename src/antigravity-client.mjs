import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { StdioRpcClient } from "./stdio-rpc.mjs";

export const antigravityMethods = new Set([
  "thread/list", "thread/start", "thread/resume", "turn/start", "turn/interrupt",
]);

const STOP_OUTCOMES = {
  end_turn: ["completed"],
  cancelled: ["interrupted"],
  refusal: ["declined", "Antigravity 拒绝了该请求"],
  max_tokens: ["failed", "输出已达单次长度上限（max_tokens），可继续追问"],
  max_turn_requests: ["failed", "已达单轮请求上限（max_turn_requests），可继续追问"],
};

export class AntigravityClient extends EventEmitter {
  constructor({ command = "agy", args = ["acp"], cwd } = {}) {
    super();
    this.cwd = cwd;
    this.sessions = new Map();
    this.approvals = new Map();
    this.ready = false;
    this.starting = null;
    this.stopping = false;
    this.capabilities = {};
    this.rpc = new StdioRpcClient({ command, args, cwd, name: "Antigravity ACP", jsonrpc: true });
    this.rpc.on("notification", ({ method, params }) => {
      if (method === "session/update") this.update(params);
    });
    this.rpc.on("serverRequest", (message) => this.handleRequest(message));
    for (const kind of ["protocolError", "log"]) this.rpc.on(kind, (value) => this.emit(kind, value));
    this.rpc.on("exit", (event) => {
      this.ready = false;
      for (const session of this.sessions.values()) {
        session.loaded = false;
        session.loading = null;
        if (session.created && !session.prompted) this.sessions.delete(session.id);
      }
      for (const { id } of this.approvals.values()) this.emit("requestResolved", { id });
      this.approvals.clear();
      this.emit("exit", event);
    });
  }

  async start() {
    if (this.ready && this.rpc.process?.stdin?.writable) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = (async () => {
      try {
        this.rpc.start();
        const init = await this.call("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "remote-codex", version: "0.2.0" },
        }, 15_000);
        if (init.protocolVersion !== 1) throw new Error("此版本需要 Antigravity ACP v1");
        this.capabilities = init.agentCapabilities || {};
        this.ready = true;
        this.emit("ready");
      } catch (error) {
        this.ready = false;
        await this.rpc.stop();
        throw error;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  ensureReady() {
    if (this.stopping) throw new Error("Antigravity ACP 正在停止");
    return this.start();
  }

  stop() {
    this.stopping = true;
    this.ready = false;
    return this.rpc.stop();
  }

  async call(method, params, timeout) {
    try {
      return await this.rpc.request(method, params, timeout);
    } catch (error) {
      if (error.code === "ENOENT") throw httpError(503, "找不到 agy。请安装 Antigravity CLI 或用 --agy 指定路径");
      if (error.code === -32000) throw httpError(400, "Antigravity 尚未登录，请先在电脑上运行 agy acp --login");
      if (error.code === -32600 || error.code === -32602) throw httpError(400, error.message || "Antigravity 请求参数无效");
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.ensureReady();
    switch (method) {
      case "thread/list": return this.list(params.cursor);
      case "thread/start": return this.create(params.cwd ?? this.cwd);
      case "thread/resume": return this.resume(this.resolveSession(params.threadId, params.cwd));
      case "turn/start": return this.prompt(this.getSession(params.threadId), params.input);
      case "turn/interrupt": return this.cancel(this.getSession(params.threadId), params.turnId);
      default: throw httpError(403, "此操作不适用于 Antigravity");
    }
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw httpError(404, "Antigravity 会话不可用，请刷新会话列表");
    return session;
  }

  resolveSession(id, cwd) {
    if (typeof id === "string" && id) {
      const existing = this.sessions.get(id);
      if (existing) return existing;
      if (typeof cwd === "string" && isAbsolute(cwd)) return this.remember({ sessionId: id, cwd });
    }
    throw httpError(404, "Antigravity 会话不可用，请刷新会话列表");
  }

  remember({ sessionId, cwd }) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        cwd,
        name: null,
        updatedAt: 0,
        preview: "",
        items: [],
        loaded: false,
        everLoaded: false,
        created: false,
        prompted: false,
        active: null,
      });
    }
    return this.sessions.get(sessionId);
  }

  async list(cursor) {
    let nextCursor;
    let data = [];
    if (this.capabilities.sessionCapabilities?.list) {
      if (cursor != null && typeof cursor !== "string") throw httpError(400, "会话游标无效");
      const page = await this.call("session/list", cursor ? { cursor } : {});
      nextCursor = page.nextCursor;
      data = (page.sessions || []).map((entry) => {
        const session = this.remember(entry);
        session.created = false;
        session.prompted = true;
        const updatedAt = Date.parse(entry.updatedAt) / 1000 || 0;
        if (entry.title != null && (updatedAt >= Math.floor(session.updatedAt) || !session.name)) {
          session.name = entry.title;
        }
        if (updatedAt > session.updatedAt) session.updatedAt = updatedAt;
        return snapshot(session);
      });
    }
    if (!cursor) {
      // ACP may omit a newly created session until it has received its first prompt.
      const listed = new Set(data.map(({ id }) => id));
      const local = [...this.sessions.values()].filter((session) => session.created && !listed.has(session.id));
      data = [...local.reverse().map((session) => snapshot(session)), ...data];
    }
    return { data, nextCursor };
  }

  async create(cwd) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw httpError(400, "请输入电脑上的绝对工作目录");
    const { sessionId } = await this.call("session/new", { cwd, mcpServers: [] });
    const session = this.remember({ sessionId, cwd });
    Object.assign(session, { loaded: true, everLoaded: true, created: true, updatedAt: Date.now() / 1000 });
    return { thread: snapshot(session, true) };
  }

  async resume(session) {
    if (!session.loaded) {
      if (!this.capabilities.loadSession) throw httpError(400, "此版本的 Antigravity CLI 未开放历史会话，请更新 agy");
      session.loading ||= this.load(session);
      await session.loading;
    }
    return { thread: snapshot(session, true) };
  }

  async load(session) {
    const replayed = [];
    session.replaying = replayed;
    try {
      await this.call("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
      session.items = replayed;
      session.loaded = true;
      session.everLoaded = true;
    } finally {
      session.replaying = null;
      session.loading = null;
    }
  }

  async prompt(session, input) {
    if (!session.loaded && session.everLoaded && this.capabilities.loadSession) {
      await this.resume(session);
    }
    if (!session.loaded) throw httpError(409, "请先打开这条 Antigravity 会话");
    if (session.active) throw httpError(409, "Antigravity 正在处理上一条消息");
    if (!Array.isArray(input) || !input.length || input.some((item) => item?.type !== "text" || typeof item.text !== "string")) {
      throw httpError(400, "Antigravity 目前支持发送文字消息");
    }
    const prompt = input.map(({ type, text }) => ({ type, text }));
    const turn = { id: randomUUID(), status: "inProgress" };
    session.active = turn;
    session.prompted = true;
    session.cancelRequested = false;
    const item = { id: randomUUID(), type: "userMessage", content: prompt };
    session.items.push(item);
    session.preview ||= prompt[0].text.slice(0, 120);
    this.notify("turn/started", { threadId: session.id, turn });
    this.notify("item/started", { threadId: session.id, item });
    // ACP only responds to session/prompt once it is done. HTTP returns now so the phone can cancel or approve.
    this.call("session/prompt", { sessionId: session.id, prompt }, null).then(
      ({ stopReason } = {}) => {
        const [status, reason] = STOP_OUTCOMES[stopReason] || ["failed", `Antigravity 已停止（${stopReason || "unknown"}）`];
        this.finish(session, status, reason);
      },
      (error) => this.finish(session, "failed", error.message),
    );
    return { turn };
  }

  cancel(session, turnId) {
    if (session.active?.id === turnId && session.active) {
      session.cancelRequested = true;
      this.rpc.notify("session/cancel", { sessionId: session.id });
      this.clearApprovals(session.id);
    }
    return {};
  }

  finish(session, status, message) {
    if (!session.active) return;
    const turn = { ...session.active, status, ...(message ? { error: { message } } : {}) };
    session.active = null;
    session.updatedAt = Date.now() / 1000;
    this.clearApprovals(session.id);
    this.notify("turn/completed", { threadId: session.id, turn });
  }

  update({ sessionId, update } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !update) return;
    const live = Boolean(session.active);
    const items = session.replaying ?? session.items;
    const kind = update.sessionUpdate;
    if (kind === "session_info_update") {
      if (Object.hasOwn(update, "title")) session.name = update.title;
      if (Object.hasOwn(update, "updatedAt")) {
        const updatedAt = Date.parse(update.updatedAt) / 1000 || 0;
        if (updatedAt) session.updatedAt = updatedAt;
      }
      if ((session.loaded || live) && update.title) {
        this.notify("thread/name/updated", { threadId: sessionId, name: session.name });
      }
      return;
    }
    if (!live && !session.replaying) return;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = `tool:${update.toolCallId}`;
      const index = items.findIndex((item) => item.id === id);
      const previous = items[index];
      const details = { ...previous?.details, ...toolDetails(update) };
      const item = { id, type: "antigravityTool", details, status: update.status ?? previous?.status };
      if (index < 0) items.push(item);
      else items[index] = item;
      if (live) this.notify("item/started", { threadId: sessionId, item });
      return;
    }
    if (kind === "plan") {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const text = entries.map((entry) => `${planMarker(entry?.status)} ${entry?.content || ""}`.trim()).filter(Boolean).join("\n");
      const previousBoundary = [...items].reverse().find((entry) => entry.type === "plan" || entry.type === "userMessage");
      const id = session.active ? `plan:${session.active.id}` : (previousBoundary?.type === "plan" ? previousBoundary.id : `plan:${items.length}`);
      const index = items.findIndex((item) => item.id === id);
      const item = { id, type: "plan", text };
      if (index < 0) items.push(item);
      else items[index] = item;
      if (live) this.notify("item/started", { threadId: sessionId, item });
      return;
    }
    if (kind === "agent_thought_chunk") {
      const part = contentPart(update.content);
      if (part?.type !== "text" || !part.text) return;
      let item = items.at(-1);
      if (item?.type !== "reasoning") {
        item = { id: randomUUID(), type: "reasoning", content: [""] };
        items.push(item);
      }
      item.content = [`${item.content?.[0] || ""}${part.text}`];
      if (live) this.notify("item/started", { threadId: sessionId, item });
      return;
    }
    const type = { agent_message_chunk: "agentMessage", user_message_chunk: "userMessage" }[kind];
    // The bridge already renders the prompt it sends during a live turn.
    if (!type || (live && type === "userMessage")) return;
    const part = contentPart(update.content);
    if (!part) return;
    let item = items.at(-1);
    if (item?.type !== type) {
      item = type === "userMessage" ? { id: randomUUID(), type, content: [] } : { id: randomUUID(), type, text: "" };
      items.push(item);
    }
    if (type === "userMessage") {
      if (part.type === "text") {
        const lastPart = item.content.at(-1);
        if (lastPart?.type === "text") lastPart.text += part.text;
        else item.content.push({ type: "text", text: part.text });
        session.preview ||= (item.content.find((entry) => entry.type === "text")?.text || "").slice(0, 120);
      } else {
        item.content.push(part);
        session.preview ||= "[图片]";
      }
    } else {
      const delta = part.type === "text" ? part.text : "[图片]";
      item.text += delta;
      if (live) this.notify("item/agentMessage/delta", { threadId: sessionId, itemId: item.id, delta });
    }
  }

  handleRequest({ id, method, params = {} }) {
    if (method !== "session/request_permission") {
      this.rpc.respondError(id, { code: -32601, message: "Remote Codex does not implement this ACP method" });
      return;
    }
    const session = this.sessions.get(params.sessionId);
    if (!session?.active || session.cancelRequested) return this.rpc.respond(id, { outcome: { outcome: "cancelled" } });
    const { toolCall = {}, sessionId } = params;
    const lastDetails = session.items.find((item) => item.id === `tool:${toolCall.toolCallId}`)?.details;
    const options = (params.options || []).filter(({ kind }) => kind === "allow_once" || kind === "reject_once");
    this.approvals.set(String(id), { id, sessionId, options });
    this.emit("serverRequest", {
      id,
      method,
      params: {
        sessionId,
        cwd: session.cwd,
        sessionName: session.name || session.preview || null,
        toolCall: { ...lastDetails, ...toolDetails(toolCall) },
        options,
      },
    });
  }

  respond(id, { optionId } = {}) {
    const approval = this.approvals.get(String(id));
    if (!approval) throw httpError(404, "审批请求已处理或不存在");
    if (optionId != null && !approval.options.some((option) => option.optionId === optionId)) {
      throw httpError(400, "无效的审批选项");
    }
    const outcome = optionId == null ? { outcome: "cancelled" } : { outcome: "selected", optionId };
    this.rpc.respond(approval.id, { outcome });
    this.approvals.delete(String(id));
  }

  respondError(id) {
    this.respond(id);
  }

  clearApprovals(sessionId) {
    for (const approval of this.approvals.values()) {
      if (approval.sessionId !== sessionId) continue;
      if (this.rpc.process?.stdin?.writable) this.respond(approval.id);
      else this.approvals.delete(String(approval.id));
      this.emit("requestResolved", { id: approval.id });
    }
  }

  notify(method, params) {
    this.emit("notification", { method, params });
  }
}

function snapshot(session, includeTurns = false) {
  const { id, cwd, name, updatedAt, preview, active, items } = session;
  return {
    id, cwd, name, updatedAt, preview, status: { type: active ? "active" : "idle" },
    ...(includeTurns ? { turns: [{ ...active, items }] } : {}),
  };
}

function toolDetails({ title, kind, rawInput, locations, content }) {
  return Object.fromEntries(Object.entries({ title, kind, rawInput, locations, content }).filter(([, value]) => value != null));
}

function contentPart(content) {
  if (!content || typeof content !== "object") return null;
  if (content.type === "text" && content.text) return { type: "text", text: content.text };
  if (content.type === "image") return { type: "image" };
  if (content.type === "resource_link") {
    const label = content.name || content.uri;
    return label ? { type: "text", text: `[${label}]` } : null;
  }
  if (content.type === "resource") {
    const resource = content.resource || {};
    const label = resource.text ? `[${resource.uri || "资源"}]\n${resource.text}` : (resource.uri ? `[${resource.uri}]` : "");
    return label ? { type: "text", text: label } : null;
  }
  return null;
}

function planMarker(status) {
  if (status === "completed") return "[✓]";
  if (status === "in_progress" || status === "inProgress") return "[…]";
  return "[ ]";
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
