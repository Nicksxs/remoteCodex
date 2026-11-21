import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AntigravityClient } from "../src/antigravity-client.mjs";

const fixture = fileURLToPath(new URL("../test-support/fake-antigravity.mjs", import.meta.url));

test("Antigravity lists sessions by cursor and reconstructs replayed messages, thoughts, plans, and previews", { timeout: 5000 }, async (context) => {
  const client = await startClient(context);
  const first = await client.request("thread/list", {});
  assert.equal(first.data[0].id, "previous");
  const second = await client.request("thread/list", { cursor: first.nextCursor });
  assert.equal(second.data[0].id, "older");
  const { thread } = await client.request("thread/resume", { threadId: "previous" });
  const items = thread.turns[0].items;
  assert.equal(items[0].content[0].text, "旧问题");
  assert.equal(items[1].text, "旧回答");
  assert.equal((await client.request("thread/resume", { threadId: "previous" })).thread.turns[0].items.length, 2);

  // Resume an unlisted session directly via cwd fallback and verify preview + thought + plan replay
  const freshClient = await startClient(context);
  const resumedUntitled = await freshClient.request("thread/resume", { threadId: "untitled", cwd: process.cwd() });
  assert.equal(resumedUntitled.thread.preview, "无标题会话的首条问题");
  const untitledItems = resumedUntitled.thread.turns[0].items;
  assert.equal(untitledItems[0].type, "userMessage");
  assert.equal(untitledItems[1].type, "reasoning");
  assert.equal(untitledItems[1].content[0], "先分析问题");
  assert.equal(untitledItems[2].type, "plan");
  assert.match(untitledItems[2].text, /\[✓\] 读取配置/);
  assert.match(untitledItems[2].text, /\[…\] 修改实现/);
  assert.equal(untitledItems[3].text, "已处理");
});

test("Antigravity streams results, validates permissions with context, and cancels while waiting on approval", { timeout: 5000 }, async (context) => {
  const client = await startClient(context);
  const { thread } = await client.request("thread/start", { cwd: process.cwd() });
  const params = { threadId: thread.id, input: [{ type: "text", text: "Read the README" }] };
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  const approval = once(client, "serverRequest");
  await client.request("turn/start", params);
  const [request] = await approval;
  assert.equal(request.params.sessionId, thread.id);
  assert.equal(request.params.cwd, process.cwd());
  assert.equal(request.params.toolCall.rawInput.path, "README.md");
  assert.deepEqual(request.params.options.map(({ optionId }) => optionId), ["once", "no"]);
  assert.throws(() => client.respond(request.id, { optionId: "always" }), /无效/);
  await assert.rejects(client.request("turn/start", params), /上一条消息/);
  const completed = nextCompletion(client);
  client.respond(request.id, { optionId: "once" });
  assert.equal((await completed).status, "completed");
  assert.ok(notifications.some(({ method, params: eventParams }) => method === "item/agentMessage/delta" && eventParams.delta === "完成"));

  const pending = once(client, "serverRequest");
  const { turn } = await client.request("turn/start", params);
  const [pendingRequest] = await pending;
  const resolved = once(client, "requestResolved");
  const stopped = nextCompletion(client);
  await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  assert.equal((await resolved)[0].id, pendingRequest.id);
  assert.equal((await stopped).status, "interrupted");
  assert.throws(() => client.respond(pendingRequest.id, { optionId: "once" }), /已处理/);
});

test("Antigravity syncs second-precision titles, clears local created flag, and recovers after ACP process exit", { timeout: 5000 }, async (context) => {
  const client = await startClient(context);
  const { thread } = await client.request("thread/start", { cwd: process.cwd() });

  // Refusal sets error message and updates session/list with second-precision updatedAt + title
  const refusalDone = nextCompletion(client);
  await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "REFUSE" }] });
  const refusedTurn = await refusalDone;
  assert.equal(refusedTurn.status, "declined");
  assert.match(refusedTurn.error.message, /拒绝/);

  const listed = await client.request("thread/list", {});
  const synced = listed.data.find((item) => item.id === thread.id);
  assert.equal(synced.name, "自动生成的标题");
  assert.equal(client.sessions.get(thread.id).created, false);

  // Simulate ACP child crash during prompt, then verify automatic restart + reload on next prompt
  const exited = once(client, "exit");
  const crashDone = nextCompletion(client);
  await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "CRASH" }] });
  await exited;
  assert.equal((await crashDone).status, "failed");
  assert.equal(client.ready, false);

  const recoveredDone = nextCompletion(client);
  await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "THINK_AND_PLAN" }] });
  assert.equal(client.ready, true);
  assert.equal((await recoveredDone).status, "completed");
});

async function startClient(context) {
  const client = new AntigravityClient({ command: process.execPath, args: [fixture], cwd: process.cwd() });
  context.after(() => client.stop());
  await client.start();
  return client;
}

function nextCompletion(client) {
  return new Promise((resolve) => {
    const listener = ({ method, params }) => {
      if (method !== "turn/completed") return;
      client.off("notification", listener);
      resolve(params.turn);
    };
    client.on("notification", listener);
  });
}
