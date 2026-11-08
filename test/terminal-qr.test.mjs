import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodeQr, terminalQr } from "../src/terminal-qr.mjs";

const pairingUrl = "http://192.168.1.10:4173/#token=test-token-123";

test("generates a standards-compatible QR matrix for a pairing URL", () => {
  const matrix = encodeQr(pairingUrl, { mask: 3 });
  const serialized = matrix.map((row) => row.map(Number).join("")).join("\n");
  const digest = createHash("sha256").update(serialized).digest("hex");

  assert.equal(matrix.length, 29);
  assert.ok(matrix.every((row) => row.length === matrix.length));
  assert.equal(digest, "163a630062b1116cb0e321fd39520cef88577dc31928d10d265a426c3424990d");
});

test("renders the QR matrix with an ANSI quiet zone", () => {
  const output = terminalQr(pairingUrl);
  assert.match(output, /\u001b\[30;47m/);
  assert.match(output, /[█▀▄]/);
  assert.ok(output.split("\n").length >= 18);
});

test("rejects payloads beyond the embedded encoder capacity", () => {
  assert.throws(() => encodeQr("x".repeat(107)), /过长/);
});
