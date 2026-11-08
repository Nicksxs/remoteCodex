import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-app-server" } });
  } else if (message.method === "initialized") {
    send({ method: "bridge/test", params: { ready: true } });
  } else if (message.method === "echo") {
    send({ id: message.id, result: message.params });
  } else if (message.method === "triggerApproval") {
    send({ id: message.id, result: { triggered: true } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
  } else if (message.id === "approval-1" && message.result) {
    send({ method: "approval/result", params: message.result });
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
