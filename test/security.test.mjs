import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, safeJson, tokenMatches } from "../src/security.mjs";

test("compares pairing tokens without accepting partial values", () => {
  assert.equal(tokenMatches("correct-token", "correct-token"), true);
  assert.equal(tokenMatches("correct-token", "correct"), false);
  assert.equal(tokenMatches("correct-token", "wrong--token"), false);
});

test("extracts bearer tokens", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc123" } }), "abc123");
  assert.equal(bearerToken({ headers: {} }), "");
});

test("escapes opening tags in JSON embedded in SSE", () => {
  assert.equal(safeJson({ value: "<script>" }), "{\"value\":\"\\u003cscript>\"}");
});
