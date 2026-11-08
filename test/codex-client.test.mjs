import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/codex-client.mjs";

const fixture = fileURLToPath(new URL("../test-support/fake-app-server.mjs", import.meta.url));

test("initializes, sends RPC, streams notifications, and relays approvals", async (context) => {
  const client = new CodexAppServer({ command: process.execPath, args: [fixture] });
  context.after(() => client.stop());

  const readyNotification = once(client, "notification");
  await client.start();
  assert.equal(client.ready, true);
  assert.deepEqual((await readyNotification)[0], { method: "bridge/test", params: { ready: true } });

  assert.deepEqual(await client.request("echo", { value: 42 }), { value: 42 });

  const approvalPromise = once(client, "serverRequest");
  await client.request("triggerApproval");
  const approval = (await approvalPromise)[0];
  assert.equal(approval.id, "approval-1");
  assert.equal(approval.params.command, "npm test");

  const receivedPromise = once(client, "notification");
  client.respond(approval.id, { decision: "accept" });
  const received = (await receivedPromise)[0];
  assert.deepEqual(received.params, { decision: "accept" });
});
