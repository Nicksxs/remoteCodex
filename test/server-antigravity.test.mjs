import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverScript = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const fakeAgy = fileURLToPath(new URL("../test-support/fake-antigravity.mjs", import.meta.url));

test("HTTP bridge serves Antigravity status, enforces RPC allowlist, and relays approvals over poll", { timeout: 8000 }, async (context) => {
  const token = "test-secret-token";
  const child = spawn(
    process.execPath,
    [serverScript, "--agent", "antigravity", "--port", "0", "--no-qr", "--token", token],
    {
      env: {
        ...process.env,
        REMOTE_CODEX_AGY_BIN: process.execPath,
        REMOTE_CODEX_AGY_ARGS: JSON.stringify([fakeAgy]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const baseUrl = await waitForServerUrl(child);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const unauth = await fetch(`${baseUrl}/api/status`);
  assert.equal(unauth.status, 401);

  const statusRes = await fetch(`${baseUrl}/api/status`, { headers });
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.provider, "antigravity");
  assert.equal(status.codexReady, true);
  assert.equal(status.transportSecure, true);

  // Null JSON body returns 400 rather than 500
  const nullBodyRes = await fetch(`${baseUrl}/api/rpc`, { method: "POST", headers, body: "null" });
  assert.equal(nullBodyRes.status, 400);

  // Disallowed RPC methods return 403
  const forbiddenRes = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "turn/steer", params: {} }),
  });
  assert.equal(forbiddenRes.status, 403);

  // Start session, trigger approval, poll events, and respond
  const startRes = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "thread/start", params: { cwd: process.cwd() } }),
  });
  const { result: { thread } } = await startRes.json();

  const turnRes = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      method: "turn/start",
      params: { threadId: thread.id, input: [{ type: "text", text: "Read README" }] },
    }),
  });
  assert.equal(turnRes.status, 200);

  const pending = await waitForPending(baseUrl, headers);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].params.cwd, process.cwd());

  const pollRes = await fetch(`${baseUrl}/api/events/poll?after=${status.eventCursor}`, { headers });
  const polled = await pollRes.json();
  assert.equal(polled.truncated, false);
  assert.ok(polled.data.some((event) => event.kind === "serverRequest"));

  const respondRes = await fetch(`${baseUrl}/api/respond`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: pending[0].id, result: { optionId: "once" } }),
  });
  assert.equal(respondRes.status, 200);
});

function waitForServerUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${stderr}`));
    });
  });
}

async function waitForPending(baseUrl, headers) {
  for (let i = 0; i < 30; i += 1) {
    const res = await fetch(`${baseUrl}/api/pending`, { headers });
    const body = await res.json();
    if (body.data?.length) return body.data;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for pending approval");
}
