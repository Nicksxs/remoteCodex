export class EventBuffer {
  constructor({ limit = 1000 } = {}) {
    this.limit = limit;
    this.sequence = 0;
    this.items = [];
    this.waiters = new Set();
    this.closed = false;
  }

  publish(kind, message) {
    const event = { seq: ++this.sequence, at: Date.now(), kind, message };
    this.items.push(event);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    for (const waiter of [...this.waiters]) {
      if (event.seq > waiter.after) waiter.finish(this.after(waiter.after));
    }
    return event;
  }

  after(cursor) {
    return this.items.filter((event) => event.seq > cursor);
  }

  wait(cursor, { signal, timeoutMs = 20_000 } = {}) {
    const ready = this.after(cursor);
    if (ready.length || this.closed) return Promise.resolve(ready);

    return new Promise((resolve, reject) => {
      const waiter = {
        after: cursor,
        finish: (events) => {
          cleanup();
          resolve(events);
        },
      };
      const onAbort = () => {
        cleanup();
        const error = new Error("Event poll aborted");
        error.name = "AbortError";
        reject(error);
      };
      const timer = setTimeout(() => waiter.finish([]), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  close() {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.finish([]);
  }
}
