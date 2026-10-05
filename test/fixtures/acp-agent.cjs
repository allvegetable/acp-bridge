const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const capturePath = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

async function handle({ id, method, params }) {
  if (method === "initialize") {
    send({ id, result: {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { promptCapabilities: { image: true, audio: true, embeddedContext: true } },
      authMethods: [],
    } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "fixture-session" } });
  } else if (method === "session/prompt") {
    // Capture the wire request before any SDK parsing or content transformations.
    appendFileSync(capturePath, JSON.stringify(params) + "\n");
    if (params.prompt.some((block) => block.type === "text" && block.text === "fixture:timeout")) {
      return;
    }
    if (params.prompt.some((block) => block.type === "text" && block.text === "fixture:error")) {
      send({ id, error: { code: -32000, message: "fixture prompt failure" } });
      return;
    }
    const text = JSON.stringify(params.prompt);
    const split = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, split), text.slice(split)]) {
      send({ method: "session/update", params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      } });
      await new Promise((resolve) => setImmediate(resolve));
    }
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
  }
}

lines.on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(error.stack + "\n");
    process.exit(1);
  });
});
