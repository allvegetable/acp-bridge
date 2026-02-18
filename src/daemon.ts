import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type AgentState = "starting" | "idle" | "working" | "stopped" | "error";

type PendingPermission = {
  requestId: number;
  params: acp.RequestPermissionRequest;
  requestedAt: string;
  resolve: (response: acp.RequestPermissionResponse) => void;
};

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
  pendingPermissions: PendingPermission[];
  createdAt: string;
  updatedAt: string;
};

type AgentConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

type BridgeConfig = {
  port?: number;
  host?: string;
  agents?: Record<string, AgentConfig>;
};

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class BridgeClient implements acp.Client {
  constructor(private readonly getRecord: () => AgentRecord | undefined) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const record = this.getRecord();
    if (!record) {
      return { outcome: { outcome: "cancelled" } };
    }
    record.updatedAt = nowIso();
    record.state = "working";
    return new Promise((resolve) => {
      record.pendingPermissions.push({
        requestId: nextPermissionRequestId++,
        params,
        requestedAt: nowIso(),
        resolve,
      });
    });
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
        publishChunk(record.name, text);
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
const bridgeConfig = loadConfig();
const chunkSubscribers = new Map<string, Set<(chunk: string) => void>>();
let nextPermissionRequestId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function expandHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function loadConfig(): BridgeConfig {
  const configPath = join(homedir(), ".config", "acp-bridge", "config.json");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as BridgeConfig;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        event: "config_error",
        path: configPath,
        error: error instanceof Error ? error.message : String(error),
      }) + "\n",
    );
    return {};
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

function pathParts(req: IncomingMessage): string[] {
  const pathname = requestUrl(req).pathname;
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
    pendingPermissions: record.pendingPermissions.map((item) => ({
      requestId: item.requestId,
      requestedAt: item.requestedAt,
      sessionId: item.params.sessionId,
      options: item.params.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        name: option.name,
      })),
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function findPermissionOptionId(
  params: acp.RequestPermissionRequest,
  mode: "approve" | "deny",
  explicitOptionId?: string,
): string | null {
  if (explicitOptionId && params.options.some((option) => option.optionId === explicitOptionId)) {
    return explicitOptionId;
  }

  if (mode === "approve") {
    const preferred = params.options.find((option) => option.kind.startsWith("allow"));
    if (preferred) {
      return preferred.optionId;
    }
  } else {
    const preferred = params.options.find((option) => option.kind.startsWith("reject"));
    if (preferred) {
      return preferred.optionId;
    }
  }

  return params.options[0]?.optionId ?? null;
}

function resolvePendingPermission(
  record: AgentRecord,
  decision: "approve" | "deny" | "cancel",
  explicitOptionId?: string,
): PendingPermission | null {
  const pending = record.pendingPermissions.shift();
  if (!pending) {
    return null;
  }

  if (decision === "cancel") {
    pending.resolve({ outcome: { outcome: "cancelled" } });
  } else {
    const optionId = findPermissionOptionId(pending.params, decision, explicitOptionId);
    if (optionId) {
      pending.resolve({
        outcome: {
          outcome: "selected",
          optionId,
        },
      });
    } else {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  record.updatedAt = nowIso();
  return pending;
}

function cancelAllPendingPermissions(record: AgentRecord): number {
  let count = 0;
  while (resolvePendingPermission(record, "cancel")) {
    count += 1;
  }
  return count;
}

async function spawnAgentConnection(input: {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  getClient: () => acp.Client;
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  init: unknown;
  session: any;
}> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `failed to spawn agent process: ${message}`);
  }

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      reject(new HttpError(400, `failed to spawn agent process: ${error.message}`));
    });
  });

  child.stderr.on("data", (data) => {
    const record = agents.get(input.name);
    if (record) {
      record.updatedAt = nowIso();
      record.lastError = data.toString("utf8").trim();
    }
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(input.getClient, stream);
  try {
    const init = await Promise.race([
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      } as any),
      spawnError,
    ]);
    const session = await Promise.race([
      connection.newSession({
        cwd: input.cwd,
        mcpServers: [],
      } as any),
      spawnError,
    ]);
    return { child, connection, init, session };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

function subscribeChunks(name: string, callback: (chunk: string) => void): () => void {
  const set = chunkSubscribers.get(name) || new Set<(chunk: string) => void>();
  set.add(callback);
  chunkSubscribers.set(name, set);
  return () => {
    const current = chunkSubscribers.get(name);
    if (!current) {
      return;
    }
    current.delete(callback);
    if (current.size === 0) {
      chunkSubscribers.delete(name);
    }
  };
}

function publishChunk(name: string, chunk: string): void {
  const subscribers = chunkSubscribers.get(name);
  if (!subscribers || subscribers.size === 0) {
    return;
  }
  for (const callback of subscribers) {
    callback(chunk);
  }
}

async function startAgent(input: {
  type?: string;
  name: string;
  cwd?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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
  const configuredAgent = bridgeConfig.agents?.[type];
  let defaultArgs: string[] = [];
  if (type === "opencode") {
    defaultArgs = ["acp"];
  }
  const configuredArgs = configuredAgent?.args && configuredAgent.args.length > 0 ? configuredAgent.args : undefined;
  const requestedArgs = input.args && input.args.length > 0 ? input.args : undefined;
  const opencodeBin = `${homedir()}/.opencode/bin`;
  const currentPath = process.env.PATH || "";
  const childPath = currentPath ? `${opencodeBin}${delimiter}${currentPath}` : opencodeBin;
  const finalEnv = {
    ...process.env,
    ...(configuredAgent?.env || {}),
    ...(input.env || {}),
    PATH: childPath,
  };

  let record: AgentRecord | undefined;
  const client = new BridgeClient(() => record);
  const defaultCommand = input.command || configuredAgent?.command || type;
  const defaultArgsList = requestedArgs || configuredArgs || defaultArgs;
  const useCodexFallback =
    type === "codex" &&
    !input.command &&
    !configuredAgent?.command &&
    !requestedArgs &&
    !configuredArgs;
  const useClaudeDefault =
    type === "claude" &&
    !input.command &&
    !configuredAgent?.command &&
    !requestedArgs &&
    !configuredArgs;
  const useGeminiDefault =
    type === "gemini" &&
    !input.command &&
    !configuredAgent?.command &&
    !requestedArgs &&
    !configuredArgs;
  const candidates = useCodexFallback
    ? [
        { command: "codex-acp", args: [] as string[] },
        { command: "codex", args: ["mcp-server"] as string[] },
      ]
    : useClaudeDefault
      ? [{ command: "claude-agent-acp", args: [] as string[] }]
      : useGeminiDefault
        ? [{ command: "gemini", args: ["--experimental-acp"] as string[] }]
        : [{ command: defaultCommand, args: defaultArgsList }];

  let child: ChildProcessWithoutNullStreams | undefined;
  let connection: acp.ClientSideConnection | undefined;
  let init: unknown;
  let session: any;
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const result = await spawnAgentConnection({
        name,
        cwd,
        command: expandHomePath(candidate.command),
        args: candidate.args,
        env: finalEnv,
        getClient: () => client,
      });
      child = result.child;
      connection = result.connection;
      init = result.init;
      session = result.session;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!child || !connection || !session) {
    throw lastError instanceof Error ? lastError : new HttpError(500, "failed to start agent");
  }

  const created = nowIso();

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
    pendingPermissions: [],
    createdAt: created,
    updatedAt: created,
  };
  agents.set(name, record);

  child.on("exit", (code, signal) => {
    const target = agents.get(name);
    if (!target) {
      return;
    }
    cancelAllPendingPermissions(target);
    target.updatedAt = nowIso();
    target.state = target.state === "error" ? "error" : "stopped";
    target.lastError = target.lastError ?? `exit code=${code} signal=${signal}`;
  });

  if ((init as any).protocolVersion !== acp.PROTOCOL_VERSION && (init as any).protocolVersion !== 1) {
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
    cancelAllPendingPermissions(record);
    record.state = "stopped";
    record.updatedAt = nowIso();
    record.child.kill("SIGTERM");
  } finally {
    agents.delete(name);
  }
  return true;
}

function parseAskTimeoutMs(): number {
  const raw = Number(process.env.ACP_BRIDGE_ASK_TIMEOUT_MS || "300000");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 300000;
  }
  return raw;
}

type AskResult = {
  name: string;
  state: AgentState;
  stopReason: string | null;
  response: string;
};

async function askAgent(
  name: string,
  prompt: string,
  onChunk?: (chunk: string) => void,
): Promise<AskResult> {
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
  const timeoutMs = parseAskTimeoutMs();
  const unsubscribe = onChunk ? subscribeChunks(name, onChunk) : null;
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const response = await Promise.race([
      record.connection.prompt({
        sessionId: record.sessionId,
        prompt: [{ type: "text", text: prompt }],
      } as any),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new HttpError(408, `ask timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
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
    if (error instanceof HttpError && error.statusCode === 408) {
      record.state = "idle";
      record.stopReason = "timeout";
      record.lastError = error.message;
      record.updatedAt = nowIso();
      throw error;
    }
    record.state = "error";
    record.lastError = error instanceof Error ? error.message : JSON.stringify(error) ?? String(error);
    record.updatedAt = nowIso();
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (unsubscribe) {
      unsubscribe();
    }
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

    if (
      parts.length === 3 &&
      parts[0] === "agents" &&
      method === "POST" &&
      (parts[2] === "approve" || parts[2] === "deny")
    ) {
      const record = agents.get(parts[1]);
      if (!record) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const body = await readJson(req);
      const optionId = typeof body.optionId === "string" ? body.optionId : undefined;
      const pending = resolvePendingPermission(record, parts[2], optionId);
      if (!pending) {
        writeJson(res, 409, { error: "no_pending_permissions" });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        name: record.name,
        action: parts[2],
        requestId: pending.requestId,
        pendingPermissions: record.pendingPermissions.length,
      });
      return;
    }

    if (parts.length === 3 && parts[0] === "agents" && method === "POST" && parts[2] === "cancel") {
      const record = agents.get(parts[1]);
      if (!record) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      await record.connection.cancel({ sessionId: record.sessionId } as any);
      const cancelledPermissions = cancelAllPendingPermissions(record);
      record.updatedAt = nowIso();
      if (record.state === "working") {
        record.state = "idle";
      }
      writeJson(res, 200, {
        ok: true,
        name: record.name,
        cancelledPermissions,
      });
      return;
    }

    if (parts.length === 3 && parts[0] === "agents" && method === "POST" && parts[2] === "ask") {
      const name = parts[1];
      const body = await readJson(req);
      if (!body.prompt || typeof body.prompt !== "string") {
        writeJson(res, 400, { error: "prompt is required" });
        return;
      }
      const stream = requestUrl(req).searchParams.get("stream") === "true";
      if (!stream) {
        const result = await askAgent(name, body.prompt);
        writeJson(res, 200, result);
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.flushHeaders();

      try {
        const result = await askAgent(name, body.prompt, (chunk) => {
          writeSse(res, "chunk", { chunk });
        });
        writeSse(res, "done", result);
      } catch (error) {
        if (error instanceof HttpError) {
          writeSse(res, "error", { error: error.message, statusCode: error.statusCode });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          writeSse(res, "error", { error: message, statusCode: 500 });
        }
      } finally {
        res.end();
      }
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
    if (error instanceof HttpError) {
      writeJson(res, error.statusCode, {
        error: error.message,
        details: error.details ?? null,
      });
      return;
    }
    const message = error instanceof Error ? error.message : JSON.stringify(error) ?? String(error);
    writeJson(res, 500, { error: message });
  }
}

function main(): void {
  const configuredPort =
    typeof bridgeConfig.port === "number" && Number.isFinite(bridgeConfig.port)
      ? bridgeConfig.port
      : 7800;
  const port = Number(process.env.ACP_BRIDGE_PORT || String(configuredPort));
  const host =
    process.env.ACP_BRIDGE_HOST || (typeof bridgeConfig.host === "string" ? bridgeConfig.host : "127.0.0.1");
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          error: `port ${port} is already in use`,
          hint: `set ACP_BRIDGE_PORT to another value (host: ${host})`,
        }) + "\n",
      );
      process.exit(1);
    }
    process.stderr.write(
      JSON.stringify({
        ok: false,
        error: error.message,
      }) + "\n",
    );
    process.exit(1);
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
