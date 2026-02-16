import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type AgentState = "starting" | "idle" | "working" | "stopped" | "error";

type AgentRecord = {
  name: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  sessionId: string;
  state: AgentState;
  lastError: string | null;
  lastText: string;
  currentText: string;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
};

class BridgeClient implements acp.Client {
  constructor(private readonly getRecord: () => AgentRecord | undefined) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const record = this.getRecord();
    if (record) {
      record.updatedAt = new Date().toISOString();
      record.state = "working";
    }
    // TODO(phase2): Replace auto-approve with explicit approve/deny workflow via HTTP API.
    return {
      outcome: {
        outcome: "selected",
        optionId: params.options[0]?.optionId ?? "deny",
      } as any,
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const record = this.getRecord();
    if (!record) {
      return;
    }
    const update = params.update as any;
    record.updatedAt = new Date().toISOString();

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.type === "text" ? update.content.text : "";
      if (text) {
        record.currentText += text;
        record.lastText = record.currentText;
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      record.state = "working";
      return;
    }
  }
}

const agents = new Map<string, AgentRecord>();

function nowIso(): string {
  return new Date().toISOString();
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function pathParts(req: IncomingMessage): string[] {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  return pathname.split("/").filter(Boolean);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function toStatus(record: AgentRecord) {
  return {
    name: record.name,
    cwd: record.cwd,
    state: record.state,
    sessionId: record.sessionId,
    lastError: record.lastError,
    lastText: record.lastText,
    stopReason: record.stopReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function startAgent(input: {
  type?: string;
  name: string;
  cwd?: string;
  args?: string[];
}): Promise<AgentRecord> {
  const type = input.type?.trim() || "opencode";
  const name = input.name?.trim();
  if (!name) {
    throw new Error("Agent name is required");
  }
  if (agents.has(name)) {
    throw new Error(`Agent already exists: ${name}`);
  }

  const cwd = input.cwd || process.cwd();
  let command = type;
  let defaultArgs: string[] = [];
  if (type === "opencode") {
    command = "opencode";
    defaultArgs = ["acp"];
  } else if (type === "codex") {
    command = "codex";
  } else if (type === "claude") {
    command = "claude";
  } else if (type === "gemini") {
    command = "gemini";
  }
  const args = input.args && input.args.length > 0 ? input.args : defaultArgs;
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.stderr.on("data", (data) => {
    const record = agents.get(name);
    if (record) {
      record.updatedAt = nowIso();
      record.lastError = data.toString("utf8").trim();
    }
  });

  let record: AgentRecord | undefined;
  const client = new BridgeClient(() => record);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  } as any);
  const created = nowIso();
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  } as any);

  record = {
    name,
    cwd,
    child,
    connection,
    sessionId: (session as any).sessionId,
    state: "idle",
    lastError: null,
    lastText: "",
    currentText: "",
    stopReason: null,
    createdAt: created,
    updatedAt: created,
  };
  agents.set(name, record);

  child.on("exit", (code, signal) => {
    const target = agents.get(name);
    if (!target) {
      return;
    }
    target.updatedAt = nowIso();
    target.state = target.state === "error" ? "error" : "stopped";
    target.lastError = target.lastError ?? `exit code=${code} signal=${signal}`;
  });

  if ((init as any).protocolVersion !== acp.PROTOCOL_VERSION) {
    record.lastError = `protocol mismatch: ${(init as any).protocolVersion}`;
  }
  return record;
}

async function stopAgent(name: string): Promise<boolean> {
  const record = agents.get(name);
  if (!record) {
    return false;
  }
  try {
    record.state = "stopped";
    record.updatedAt = nowIso();
    record.child.kill("SIGTERM");
  } finally {
    agents.delete(name);
  }
  return true;
}

async function askAgent(name: string, prompt: string) {
  const record = agents.get(name);
  if (!record) {
    throw new Error(`Agent not found: ${name}`);
  }
  if (record.state === "working") {
    throw new Error(`Agent is busy: ${name}`);
  }
  record.state = "working";
  record.updatedAt = nowIso();
  record.currentText = "";
  record.stopReason = null;
  // TODO(phase2): Make ask asynchronous (task id + polling) or support timeout controls.
  try {
    const response = await record.connection.prompt({
      sessionId: record.sessionId,
      prompt: [{ type: "text", text: prompt }],
    } as any);
    record.state = "idle";
    record.stopReason = (response as any).stopReason ?? null;
    record.lastText = record.currentText;
    record.updatedAt = nowIso();
    return {
      name: record.name,
      state: record.state,
      stopReason: record.stopReason,
      response: record.lastText,
    };
  } catch (error) {
    record.state = "error";
    record.lastError = error instanceof Error ? error.message : String(error);
    record.updatedAt = nowIso();
    throw error;
  }
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = (req.method || "GET").toUpperCase();
    const parts = pathParts(req);

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      writeJson(res, 200, { ok: true, agents: agents.size });
      return;
    }

    if (method === "POST" && parts.length === 1 && parts[0] === "agents") {
      const body = await readJson(req);
      const record = await startAgent(body);
      writeJson(res, 201, toStatus(record));
      return;
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "agents") {
      writeJson(
        res,
        200,
        Array.from(agents.values()).map((item) => toStatus(item)),
      );
      return;
    }

    if (parts.length === 2 && parts[0] === "agents" && method === "GET") {
      const record = agents.get(parts[1]);
      if (!record) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, toStatus(record));
      return;
    }

    if (parts.length === 3 && parts[0] === "agents" && method === "POST" && parts[2] === "ask") {
      const name = parts[1];
      const body = await readJson(req);
      if (!body.prompt || typeof body.prompt !== "string") {
        writeJson(res, 400, { error: "prompt is required" });
        return;
      }
      const result = await askAgent(name, body.prompt);
      writeJson(res, 200, result);
      return;
    }

    if (parts.length === 2 && parts[0] === "agents" && method === "DELETE") {
      const ok = await stopAgent(parts[1]);
      if (!ok) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 500, { error: message });
  }
}

function main(): void {
  const port = Number(process.env.ACP_BRIDGE_PORT || "7890");
  const host = process.env.ACP_BRIDGE_HOST || "127.0.0.1";
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(port, host, () => {
    process.stdout.write(
      JSON.stringify({ ok: true, event: "listening", host, port }) + "\n",
    );
  });

  const shutdown = async () => {
    for (const name of Array.from(agents.keys())) {
      await stopAgent(name);
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main();
