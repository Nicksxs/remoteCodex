import assert from "node:assert/strict";
import { test } from "node:test";
import { extractQuickTunnelUrl } from "../src/remote-tunnel.mjs";

test("extracts the generated HTTPS hostname from cloudflared output", () => {
  const output = "INF Your quick Tunnel has been created! Visit it at https://quiet-river-123.trycloudflare.com";
  assert.equal(extractQuickTunnelUrl(output), "https://quiet-river-123.trycloudflare.com");
});

test("ignores unrelated and insecure URLs", () => {
  assert.equal(extractQuickTunnelUrl("http://localhost:4173"), null);
  assert.equal(extractQuickTunnelUrl("https://example.com"), null);
});
