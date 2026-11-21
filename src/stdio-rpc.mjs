import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

export class StdioRpcClient extends EventEmitter {
  constructor({ command, args, cwd = process.cwd(), env = process.env, name, jsonrpc = false,
    rpcError = (error) => Object.assign(new Error(error.message || `${name} request failed`), error),
  }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.name = name;
    this.jsonrpc = jsonrpc;
    this.rpcError = rpcError;
    this.process = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.stopping = false;
  }

  start() {
    if (this.process) return;
    this.stopping = false;
    this.buffer = "";
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.#consume(chunk));
    this.process.stderr.on("data", (chunk) => this.emit("log", chunk.trimEnd()));
    this.process.on("error", (error) => this.#failAll(error));
    this.process.stdin.on("error", (error) => this.#failAll(error));
    this.process.on("close", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const error = new Error(`${this.name} exited with ${suffix}`);
      this.ready = false;
      this.process = null;
      this.#failAll(error);
      if (!this.stopping) this.emit("exit", { code, signal, error });
    });

  }

  request(method, params = {}, timeoutMs = 60_000) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error(`${this.name} is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs == null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} request timed out: ${method}`));
      }, timeoutMs);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, error) {
    this.#write({ id, error });
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    if (!this.process) return;
    const child = this.process;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 1_500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message) {
    if (!this.process?.stdin?.writable) throw new Error(`${this.name} is not running`);
    const frame = this.jsonrpc ? { jsonrpc: "2.0", ...message } : message;
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocolError", new Error(`Invalid JSON from ${this.name}`));
        continue;
      }
      this.#handle(message);
    }
  }

  #handle(message) {
    if (Object.hasOwn(message, "id") && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(this.rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
    else this.emit("protocolError", new Error(`Unexpected message from ${this.name}`));
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
