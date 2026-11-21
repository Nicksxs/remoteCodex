import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

const lockedThread = {
  id: "locked-thread",
  name: "Desktop Locked Thread",
  cwd: process.cwd(),
  updatedAt: 1700000100,
  status: { type: "idle" },
  turns: [{ id: "turn-1", status: "completed", items: [{ id: "msg-1", type: "agentMessage", text: "桌面端历史消息" }] }],
};

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-app-server" } });
  } else if (message.method === "initialized") {
    send({ method: "bridge/test", params: { ready: true } });
  } else if (message.method === "echo") {
    send({ id: message.id, result: message.params });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }] } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [lockedThread] } });
  } else if (message.method === "thread/resume") {
    if (message.params?.threadId === "locked-thread") {
      send({ id: message.id, error: { code: -32600, message: "thread locked-thread already has an active writer" } });
    } else {
      send({ id: message.id, result: { thread: { ...lockedThread, id: message.params?.threadId || "unlocked" } } });
    }
  } else if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: lockedThread } });
  } else if (message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { ...lockedThread, id: "forked-thread", name: "Desktop Locked Thread" } } });
  } else if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: { status: "unsubscribed" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "codex-new", cwd: message.params?.cwd || process.cwd(), turns: [] } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "codex-turn-1", status: "inProgress" } } });
    send({ id: "1", method: "item/commandExecution/requestApproval", params: { command: "npm test", cwd: process.cwd() } });
  } else if (message.method === "triggerApproval") {
    send({ id: message.id, result: { triggered: true } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
  } else if ((message.id === "approval-1" || message.id === "1") && message.result) {
    send({ method: "approval/result", params: message.result });
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
