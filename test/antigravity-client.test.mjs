import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AntigravityClient } from "../src/antigravity-client.mjs";

const fixture = fileURLToPath(new URL("../test-support/fake-antigravity.mjs", import.meta.url));

test("Antigravity lists sessions by cursor and reconstructs replayed messages", { timeout: 5000 }, async (context) => {
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
});

test("Antigravity streams results, validates permissions, and cancels while waiting on approval", { timeout: 5000 }, async (context) => {
  const client = await startClient(context);
  const { thread } = await client.request("thread/start", { cwd: process.cwd() });
  const params = { threadId: thread.id, input: [{ type: "text", text: "Read the README" }] };
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  const approval = once(client, "serverRequest");
  await client.request("turn/start", params);
  const [request] = await approval;
  assert.equal(request.params.toolCall.rawInput.path, "README.md");
  assert.deepEqual(request.params.options.map(({ optionId }) => optionId), ["once", "no"]);
  assert.throws(() => client.respond(request.id, { optionId: "always" }), /无效/);
  await assert.rejects(client.request("turn/start", params), /上一条消息/);
  const completed = nextCompletion(client);
  client.respond(request.id, { optionId: "once" });
  assert.equal((await completed).status, "completed");
  assert.ok(notifications.some(({ method, params }) => method === "item/agentMessage/delta" && params.delta === "完成"));

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
