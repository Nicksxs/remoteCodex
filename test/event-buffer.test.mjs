import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBuffer } from "../src/event-buffer.mjs";

test("retains ordered events after a cursor", () => {
  const events = new EventBuffer({ limit: 2 });
  events.publish("first", { value: 1 });
  const second = events.publish("second", { value: 2 });
  const third = events.publish("third", { value: 3 });

  assert.deepEqual(events.after(0).map((event) => event.kind), ["second", "third"]);
  assert.deepEqual(events.after(second.seq), [third]);
});

test("long poll resolves when a newer event arrives", async () => {
  const events = new EventBuffer();
  const waiting = events.wait(0, { timeoutMs: 1000 });
  const published = events.publish("notification", { ready: true });

  assert.deepEqual(await waiting, [published]);
});

test("long poll times out without fabricating events", async () => {
  const events = new EventBuffer();
  assert.deepEqual(await events.wait(0, { timeoutMs: 5 }), []);
});
