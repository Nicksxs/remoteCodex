import { StdioRpcClient } from "./stdio-rpc.mjs";

export class CodexRpcError extends Error {
  constructor(error) {
    super(error?.message || "Codex app-server request failed");
    this.name = "CodexRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class CodexAppServer extends StdioRpcClient {
  constructor({ command = "codex", args = ["app-server"], cwd, env } = {}) {
    super({ command, args, cwd, env, name: "Codex app-server", rpcError: (error) => new CodexRpcError(error) });
  }

  async start() {
    if (this.process) return;
    super.start();
    await this.request("initialize", {
      clientInfo: {
        name: "remote_codex",
        title: "Remote Codex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requiredHumanApproval: true,
      },
    }, 15_000);
    this.notify("initialized", {});
    this.ready = true;
    this.emit("ready");
  }
}
