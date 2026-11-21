import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { StdioRpcClient } from "./stdio-rpc.mjs";

export const antigravityMethods = new Set([
  "thread/list", "thread/start", "thread/resume", "turn/start", "turn/interrupt",
]);

export class AntigravityClient extends EventEmitter {
  constructor({ command = "agy", args = ["acp"], cwd } = {}) {
    super();
    this.cwd = cwd;
    this.sessions = new Map();
    this.approvals = new Map();
    this.ready = false;
    this.rpc = new StdioRpcClient({ command, args, cwd, name: "Antigravity ACP", jsonrpc: true });
    this.rpc.on("notification", ({ method, params }) => {
      if (method === "session/update") this.update(params);
    });
    this.rpc.on("serverRequest", (message) => this.handleRequest(message));
    for (const kind of ["protocolError", "log"]) this.rpc.on(kind, (value) => this.emit(kind, value));
    this.rpc.on("exit", (event) => {
      this.ready = false;
      for (const { id } of this.approvals.values()) this.emit("requestResolved", { id });
      this.approvals.clear();
      this.emit("exit", event);
    });
  }

  async start() {
    this.rpc.start();
    const init = await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "remote-codex", version: "0.1.0" },
    }, 15_000);
    if (init.protocolVersion !== 1) throw new Error("此版本需要 Antigravity ACP v1");
    this.capabilities = init.agentCapabilities || {};
    this.ready = true;
    this.emit("ready");
  }

  stop() {
    this.ready = false;
    return this.rpc.stop();
  }

  async call(method, params, timeout) {
    try {
      return await this.rpc.request(method, params, timeout);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("找不到 agy。请安装 Antigravity CLI 或用 --agy 指定路径");
      if (error.code === -32000) throw httpError(400, "Antigravity 尚未登录，请先在电脑上运行 agy acp --login");
      throw error;
    }
  }

  async request(method, params) {
    switch (method) {
      case "thread/list": return this.list(params.cursor);
      case "thread/start": return this.create(params.cwd ?? this.cwd);
      case "thread/resume": return this.resume(this.getSession(params.threadId));
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

  remember({ sessionId, cwd }) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId, cwd, name: null, updatedAt: 0, preview: "", items: [], loaded: false, active: null,
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
      data = page.sessions.map((entry) => {
        const session = this.remember(entry);
        const updatedAt = Date.parse(entry.updatedAt) / 1000 || 0;
        if (updatedAt >= session.updatedAt) {
          session.name = entry.title ?? session.name;
          session.updatedAt = updatedAt;
        }
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
    Object.assign(session, { loaded: true, created: true, updatedAt: Date.now() / 1000 });
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
    session.items = [];
    try {
      await this.call("session/load", { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
      session.loaded = true;
    } finally {
      session.loading = null;
    }
  }

  prompt(session, input) {
    if (!session.loaded) throw httpError(409, "请先打开这条 Antigravity 会话");
    if (session.active) throw httpError(409, "Antigravity 正在处理上一条消息");
    if (!Array.isArray(input) || !input.length || input.some((item) => item?.type !== "text" || typeof item.text !== "string")) {
      throw httpError(400, "Antigravity 目前支持发送文字消息");
    }
    const prompt = input.map(({ type, text }) => ({ type, text }));
    const turn = { id: randomUUID(), status: "inProgress" };
    session.active = turn;
    session.cancelRequested = false;
    const item = { id: randomUUID(), type: "userMessage", content: prompt };
    session.items.push(item);
    session.preview ||= prompt[0].text.slice(0, 120);
    this.notify("turn/started", { threadId: session.id, turn });
    this.notify("item/started", { threadId: session.id, item });
    // ACP only responds to session/prompt once it is done. HTTP returns now so the phone can cancel or approve.
    this.call("session/prompt", { sessionId: session.id, prompt }, null).then(
      ({ stopReason } = {}) => {
        const status = { end_turn: "completed", cancelled: "interrupted", refusal: "declined" }[stopReason] || "failed";
        this.finish(session, status, status === "failed" ? `Antigravity 已停止（${stopReason}）` : undefined);
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
    const turn = { ...session.active, status, ...(message ? { error: { message } } : {}) };
    session.active = null;
    session.updatedAt = Date.now() / 1000;
    this.clearApprovals(session.id);
    this.notify("turn/completed", { threadId: session.id, turn });
  }

  update({ sessionId, update }) {
    const session = this.sessions.get(sessionId);
    if (!session || !update) return;
    const live = Boolean(session.active);
    const kind = update.sessionUpdate;
    if (kind === "session_info_update") {
      if (Object.hasOwn(update, "title")) session.name = update.title;
      if (Object.hasOwn(update, "updatedAt")) session.updatedAt = Date.parse(update.updatedAt) / 1000 || 0;
      if (session.loaded && update.title) this.notify("thread/name/updated", { threadId: sessionId, name: session.name });
      return;
    }
    if (!live && !session.loading) return;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = `tool:${update.toolCallId}`;
      const index = session.items.findIndex((item) => item.id === id);
      const previous = session.items[index];
      const details = { ...previous?.details, ...toolDetails(update) };
      const item = { id, type: "antigravityTool", details, status: update.status ?? previous?.status };
      if (index < 0) session.items.push(item);
      else session.items[index] = item;
      if (live) this.notify("item/started", { threadId: sessionId, item });
      return;
    }
    const type = { agent_message_chunk: "agentMessage", user_message_chunk: "userMessage" }[kind];
    const content = update.content;
    // The bridge already renders the prompt it sends during a live turn.
    if (!type || (live && type === "userMessage") || content?.type !== "text" || !content.text) return;
    let item = session.items.at(-1);
    if (item?.type !== type) {
      item = type === "userMessage" ? { id: randomUUID(), type, content: [] } : { id: randomUUID(), type, text: "" };
      session.items.push(item);
    }
    if (type === "userMessage") {
      if (!item.content.length) item.content.push({ type: "text", text: "" });
      item.content[0].text += content.text;
    } else {
      item.text += content.text;
      if (live) this.notify("item/agentMessage/delta", { threadId: sessionId, itemId: item.id, delta: content.text });
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
      id, method, params: { toolCall: { ...lastDetails, ...toolDetails(toolCall) }, options },
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

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
