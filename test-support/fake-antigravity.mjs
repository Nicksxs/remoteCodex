#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const previous = { sessionId: "previous", title: "上一条会话", cwd: process.cwd(), updatedAt: "2026-11-20T00:00:00Z" };
const older = { ...previous, sessionId: "older", title: "更早的会话" };
const untitled = { sessionId: "untitled", title: null, cwd: process.cwd(), updatedAt: "2026-11-19T00:00:00Z" };
let listedSessions = [previous];
let active;
let approvalId = 100;

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function update(sessionId, event) {
  send({ method: "session/update", params: { sessionId, update: event } });
}

lines.on("line", (line) => {
  const { jsonrpc, id, method, params, result } = JSON.parse(line);
  if (jsonrpc !== "2.0") throw new Error("Invalid ACP frame");
  const reply = (value) => send({ id, result: value });
  switch (method) {
    case "initialize":
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } });
      break;
    case "session/list":
      reply(params.cursor ? { sessions: [older, untitled] } : { sessions: listedSessions, nextCursor: "next-page" });
      break;
    case "session/new":
      if (params.mcpServers.length) throw new Error("Remote MCP configuration is not supported");
      reply({ sessionId: "new" });
      break;
    case "session/load":
      if (params.sessionId === "untitled") {
        update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "无标题会话的首条问题" } });
        update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先分析问题" } });
        update(params.sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "读取配置", status: "completed" },
            { content: "修改实现", status: "in_progress" },
          ],
        });
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已处理" } });
        reply({});
        break;
      }
      update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "旧问题" } });
      for (const text of ["旧", "回答"]) {
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      }
      reply({});
      break;
    case "session/prompt": {
      const promptText = params.prompt?.[0]?.text || "";
      if (promptText === "CRASH") {
        process.exit(2);
      }
      if (promptText === "REFUSE") {
        const nowSeconds = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
        listedSessions = [{ sessionId: params.sessionId, title: "自动生成的标题", cwd: process.cwd(), updatedAt: nowSeconds }, previous];
        reply({ stopReason: "refusal" });
        break;
      }
      if (promptText === "THINK_AND_PLAN") {
        update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考第一段，" } });
        update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考第二段" } });
        update(params.sessionId, { sessionUpdate: "plan", entries: [{ content: "检查测试", status: "completed" }] });
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "规划完毕" } });
        reply({ stopReason: "end_turn" });
        break;
      }
      active = { id, sessionId: params.sessionId, permission: ++approvalId, cancelled: false };
      update(active.sessionId, { sessionUpdate: "tool_call", toolCallId: `tool-${id}`, title: "Read README", kind: "read", rawInput: { path: "README.md" } });
      send({ id: active.permission, method: "session/request_permission", params: {
        sessionId: active.sessionId,
        toolCall: { toolCallId: `tool-${id}` },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
        ],
      } });
      break;
    }
    case "session/cancel":
      if (active?.sessionId === params.sessionId) active.cancelled = true;
      break;
    case undefined:
      if (id !== active?.permission) return;
      if (result.outcome.optionId === "once") {
        update(active.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } });
      }
      send({ id: active.id, result: { stopReason: active.cancelled ? "cancelled" : "end_turn" } });
      active = null;
      break;
    default:
      send({ id, error: { code: -32601, message: "Method not found" } });
  }
});
