import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBuffer } from "../src/event-buffer.mjs";

test("retains ordered events after a cursor and detects evicted gaps", () => {
  const events = new EventBuffer({ limit: 2 });
  assert.equal(events.hasGap(0), false);
  events.publish("first", { value: 1 });
  const second = events.publish("second", { value: 2 });
  assert.equal(events.hasGap(0), false);
  const third = events.publish("third", { value: 3 });

  assert.equal(events.hasGap(0), true);
  assert.equal(events.hasGap(1), false);
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
