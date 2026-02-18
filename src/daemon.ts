import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
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
  type: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  sessionId: string;
  state: AgentState;
  lastError: string | null;
  stderrBuffer: string[];
  protocolVersion: string | number | null;
  lastText: string;
  currentText: string;
  stopReason: string | null;
  pendingPermissions: PendingPermission[];
  activeTask: { taskId: string; subtaskId: string } | null;
  createdAt: string;
  updatedAt: string;
};

type EndpointCheckResult = {
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;
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

type SubtaskState = "pending" | "running" | "done" | "error" | "cancelled";
type TaskState = "running" | "done" | "error" | "cancelled";

type TaskSubtaskRecord = {
  id: string;
  agent: string;
  prompt: string;
  dependsOn: string[];
  state: SubtaskState;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

type TaskRecord = {
  id: string;
  name: string;
  state: TaskState;
  subtasks: TaskSubtaskRecord[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  cancelController: AbortController;
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
const tasks = new Map<string, TaskRecord>();
const bridgeConfig = loadConfig();
const chunkSubscribers = new Map<string, Set<(chunk: string) => void>>();
let nextPermissionRequestId = 1;
const MAX_COMPLETED_TASKS = parsePositiveIntegerEnv("ACP_BRIDGE_MAX_TASKS", 100);
const TASK_TTL_MS = parsePositiveIntegerEnv("ACP_BRIDGE_TASK_TTL_MS", 3600000);
const MAX_STDERR_LINES = 50;
const ENDPOINT_TIMEOUT_MS = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
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

function pushStderrLine(buffer: string[], line: string): void {
  const normalized = line.trim();
  if (!normalized) {
    return;
  }
  buffer.push(normalized);
  if (buffer.length > MAX_STDERR_LINES) {
    buffer.splice(0, buffer.length - MAX_STDERR_LINES);
  }
}

function commandExists(command: string, env: Record<string, string | undefined>): boolean {
  const expanded = expandHomePath(command);
  if (expanded.includes("/")) {
    return existsSync(expanded);
  }
  try {
    execSync(`which ${expanded}`, {
      stdio: "ignore",
      env: env as NodeJS.ProcessEnv,
    });
    return true;
  } catch {
    return false;
  }
}

function getTypeBaseUrl(type: string, env: Record<string, string | undefined>): string | null {
  if (type === "codex") {
    return env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  }
  if (type === "claude") {
    return env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  }
  if (type === "gemini") {
    return env.GOOGLE_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  }
  return null;
}

function getApiKeyValue(type: string, env: Record<string, string | undefined>): string | null {
  if (type === "codex") {
    return env.OPENAI_API_KEY?.trim() || null;
  }
  if (type === "claude") {
    return env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || null;
  }
  if (type === "gemini") {
    return env.GEMINI_API_KEY?.trim() || null;
  }
  return null;
}

function getApiKeyRequirement(type: string): { required: boolean; message: string | null } {
  if (type === "codex") {
    return {
      required: true,
      message: "OPENAI_API_KEY is not set. Set it in environment or config.",
    };
  }
  if (type === "claude") {
    return {
      required: true,
      message: "ANTHROPIC_API_KEY is not set. Set it in environment or config.",
    };
  }
  if (type === "gemini") {
    return {
      required: true,
      message: "GEMINI_API_KEY is not set. Set it in environment or config.",
    };
  }
  return { required: false, message: null };
}

function apiKeyFormatStatus(type: string, env: Record<string, string | undefined>): string {
  const value = getApiKeyValue(type, env);
  if (!value) {
    const required = getApiKeyRequirement(type).required;
    return required ? "missing" : "not_required";
  }
  if (type === "codex") {
    return value.startsWith("sk-") ? "valid" : "invalid";
  }
  if (type === "claude") {
    return value.startsWith("cr_") || value.startsWith("sk-ant-") ? "valid" : "invalid";
  }
  if (type === "gemini") {
    return value.startsWith("AIza") ? "valid" : "invalid";
  }
  return "unknown";
}

function classifyAskError(error: unknown): string {
  const message = error instanceof Error ? error.message : JSON.stringify(error) ?? String(error);
  const statusMatch = message.match(/\b(401|403|429|503)\b/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 401 || code === 403) {
      return "API key invalid or expired. Check your key.";
    }
    if (code === 429) {
      return "Rate limited. Check proxy quota.";
    }
    if (code === 503) {
      return "Service unavailable. Check proxy status.";
    }
  }
  if (message.includes("ECONNREFUSED")) {
    return "Connection refused. Check base URL.";
  }
  if (message.includes("ENOTFOUND")) {
    return "DNS resolution failed. Check network.";
  }
  return message;
}

function endpointCheck(urlString: string): Promise<EndpointCheckResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      resolve({
        reachable: false,
        statusCode: null,
        latencyMs: null,
        errorCode: "EINVAL",
      });
      return;
    }

    const start = Date.now();
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      {
        method: "HEAD",
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
      },
      (res) => {
        res.resume();
        res.once("end", () => {
          const latencyMs = Date.now() - start;
          const statusCode = res.statusCode ?? null;
          resolve({
            reachable: statusCode !== null,
            statusCode,
            latencyMs,
            errorCode: null,
          });
        });
      },
    );

    req.setTimeout(ENDPOINT_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    req.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        reachable: false,
        statusCode: null,
        latencyMs: null,
        errorCode: error.code || "UNKNOWN",
      });
    });
    req.end();
  });
}

async function preflightCheck(type: string, env: Record<string, string | undefined>): Promise<void> {
  const configuredCommand = env.ACP_BRIDGE_AGENT_COMMAND?.trim();
  if (configuredCommand) {
    if (!commandExists(configuredCommand, env)) {
      throw new HttpError(400, `${configuredCommand} binary not found on PATH.`);
    }
  } else if (type === "codex") {
    if (!commandExists("codex-acp", env) && !commandExists("codex", env)) {
      throw new HttpError(400, "codex-acp binary not found on PATH. Install with: cargo install codex-acp");
    }
  } else if (type === "claude") {
    if (!commandExists("claude-agent-acp", env)) {
      throw new HttpError(400, "claude-agent-acp binary not found on PATH. Install it globally first.");
    }
  } else if (type === "gemini") {
    if (!commandExists("gemini", env)) {
      throw new HttpError(400, "gemini binary not found on PATH. Install @google/gemini-cli.");
    }
  } else if (type === "opencode") {
    if (!commandExists("opencode", env)) {
      throw new HttpError(400, "opencode binary not found on PATH. Install OpenCode first.");
    }
  } else if (!commandExists(type, env)) {
    throw new HttpError(400, `${type} binary not found on PATH.`);
  }

  const keyRequirement = getApiKeyRequirement(type);
  if (keyRequirement.required && !getApiKeyValue(type, env)) {
    throw new HttpError(400, keyRequirement.message || "required API key is missing");
  }

  const baseUrl = getTypeBaseUrl(type, env);
  if (baseUrl) {
    const endpoint = await endpointCheck(baseUrl);
    if (!endpoint.reachable) {
      const code = endpoint.errorCode || "UNKNOWN";
      throw new HttpError(400, `Proxy ${baseUrl} is unreachable (${code}). Check the URL.`);
    }
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
    type: record.type,
    cwd: record.cwd,
    state: record.state,
    sessionId: record.sessionId,
    protocolVersion: record.protocolVersion,
    lastError: record.lastError,
    recentStderr: [...record.stderrBuffer],
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

function isSubtaskTerminal(state: SubtaskState): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

function findTaskSubtask(task: TaskRecord, subtaskId: string): TaskSubtaskRecord | undefined {
  return task.subtasks.find((item) => item.id === subtaskId);
}

function toTaskStatus(task: TaskRecord) {
  return {
    id: task.id,
    name: task.name,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    subtasks: task.subtasks.map((subtask) => ({
      id: subtask.id,
      agent: subtask.agent,
      prompt: subtask.prompt,
      dependsOn: subtask.dependsOn,
      state: subtask.state,
      result: subtask.result,
      error: subtask.error,
      createdAt: subtask.createdAt,
      updatedAt: subtask.updatedAt,
      startedAt: subtask.startedAt,
      completedAt: subtask.completedAt,
    })),
  };
}

function refreshTaskState(task: TaskRecord): void {
  if (task.state === "cancelled") {
    task.updatedAt = nowIso();
    return;
  }
  if (task.subtasks.some((item) => item.state === "pending" || item.state === "running")) {
    task.state = "running";
    task.updatedAt = nowIso();
    return;
  }

  if (task.subtasks.length > 0 && task.subtasks.every((item) => item.state === "done")) {
    task.state = "done";
  } else if (
    task.subtasks.some((item) => item.state === "error") &&
    task.subtasks.every((item) => item.state === "done" || item.state === "error" || item.state === "cancelled")
  ) {
    task.state = "error";
  } else if (task.subtasks.length > 0 && task.subtasks.every((item) => item.state === "cancelled")) {
    task.state = "cancelled";
  } else {
    task.state = "running";
  }
  task.updatedAt = nowIso();
}

function isTaskTerminal(state: TaskState): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}

function taskUpdatedAtMs(task: TaskRecord): number {
  const parsed = Date.parse(task.updatedAt);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function cleanupCompletedTasks(): void {
  const now = Date.now();
  const terminal = Array.from(tasks.values()).filter((task) => isTaskTerminal(task.state));
  const expiryThreshold = now - TASK_TTL_MS;

  for (const task of terminal) {
    if (taskUpdatedAtMs(task) <= expiryThreshold) {
      tasks.delete(task.id);
    }
  }

  const remainingTerminal = Array.from(tasks.values())
    .filter((task) => isTaskTerminal(task.state))
    .sort((a, b) => taskUpdatedAtMs(a) - taskUpdatedAtMs(b));

  const overflow = remainingTerminal.length - MAX_COMPLETED_TASKS;
  if (overflow <= 0) {
    return;
  }
  for (let i = 0; i < overflow; i += 1) {
    tasks.delete(remainingTerminal[i].id);
  }
}

function renderSubtaskPrompt(task: TaskRecord, subtask: TaskSubtaskRecord): string {
  return subtask.prompt.replace(/\{\{\s*([A-Za-z0-9_-]+)\.result\s*\}\}/g, (_, dependencyId: string) => {
    const dependency = findTaskSubtask(task, dependencyId);
    return dependency?.result ?? "";
  });
}

async function runSubtask(task: TaskRecord, subtask: TaskSubtaskRecord): Promise<void> {
  const abortPromise = task.cancelController.signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        task.cancelController.signal.addEventListener("abort", () => resolve(), { once: true });
      });

  while (subtask.state === "pending") {
    if (task.cancelRequested || task.state === "cancelled") {
      const now = nowIso();
      subtask.state = "cancelled";
      subtask.updatedAt = now;
      subtask.completedAt = now;
      subtask.resolveTerminal();
      refreshTaskState(task);
      return;
    }
    const dependencies = subtask.dependsOn.map((depId) => findTaskSubtask(task, depId)).filter(Boolean) as TaskSubtaskRecord[];
    const unresolved = dependencies.filter((dep) => !isSubtaskTerminal(dep.state));
    if (unresolved.length === 0) {
      break;
    }
    await Promise.race([
      abortPromise,
      ...unresolved.map((dep) => dep.terminalPromise),
    ]);
  }

  if (subtask.state !== "pending") {
    return;
  }

  const prompt = renderSubtaskPrompt(task, subtask);
  const startTime = nowIso();
  subtask.state = "running";
  subtask.startedAt = startTime;
  subtask.updatedAt = startTime;
  task.updatedAt = startTime;

  try {
    const result = await askAgent(subtask.agent, prompt, undefined, {
      taskId: task.id,
      subtaskId: subtask.id,
    });
    if (subtask.state !== "running") {
      return;
    }
    const doneAt = nowIso();
    subtask.state = "done";
    subtask.result = result.response;
    subtask.error = null;
    subtask.updatedAt = doneAt;
    subtask.completedAt = doneAt;
    subtask.resolveTerminal();
    refreshTaskState(task);
    if (isTaskTerminal(task.state)) {
      cleanupCompletedTasks();
    }
  } catch (error) {
    if (subtask.state !== "running") {
      return;
    }
    const errorAt = nowIso();
    subtask.state = "error";
    subtask.error = error instanceof Error ? error.message : JSON.stringify(error) ?? String(error);
    subtask.updatedAt = errorAt;
    subtask.completedAt = errorAt;
    subtask.resolveTerminal();
    refreshTaskState(task);
    if (isTaskTerminal(task.state)) {
      cleanupCompletedTasks();
    }
  }
}

async function runTask(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }
  await Promise.allSettled(task.subtasks.map((subtask) => runSubtask(task, subtask)));
  if (task.state === "cancelled") {
    task.updatedAt = nowIso();
    cleanupCompletedTasks();
    return;
  }
  refreshTaskState(task);
  if (isTaskTerminal(task.state)) {
    cleanupCompletedTasks();
  }
}

function validateSubtaskGraph(subtasks: TaskSubtaskRecord[]): void {
  const ids = new Set(subtasks.map((subtask) => subtask.id));
  for (const subtask of subtasks) {
    for (const depId of subtask.dependsOn) {
      if (!ids.has(depId)) {
        throw new HttpError(400, `subtask dependency not found: ${depId}`);
      }
      if (depId === subtask.id) {
        throw new HttpError(400, `subtask cannot depend on itself: ${subtask.id}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new HttpError(400, "subtask dependency cycle detected");
    }
    visiting.add(id);
    const subtask = byId.get(id);
    if (subtask) {
      for (const depId of subtask.dependsOn) {
        visit(depId);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const subtask of subtasks) {
    visit(subtask.id);
  }
}

function createTask(body: any): TaskRecord {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new HttpError(400, "task name is required");
  }
  if (!Array.isArray(body?.subtasks) || body.subtasks.length === 0) {
    throw new HttpError(400, "task subtasks are required");
  }

  const usedIds = new Set<string>();
  const createdAt = nowIso();
  const subtasks: TaskSubtaskRecord[] = body.subtasks.map((raw: any, index: number) => {
    if (!raw || typeof raw !== "object") {
      throw new HttpError(400, `invalid subtask at index ${index}`);
    }
    const agent = typeof raw.agent === "string" ? raw.agent.trim() : "";
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    if (!agent) {
      throw new HttpError(400, `subtask agent is required at index ${index}`);
    }
    if (!prompt) {
      throw new HttpError(400, `subtask prompt is required at index ${index}`);
    }
    const requestedId = typeof raw.id === "string" ? raw.id.trim() : "";
    const id = requestedId || `subtask-${index + 1}`;
    if (usedIds.has(id)) {
      throw new HttpError(400, `duplicate subtask id: ${id}`);
    }
    usedIds.add(id);

    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn
          .filter((item: unknown): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];

    let resolveTerminal: () => void = () => {};
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    return {
      id,
      agent,
      prompt,
      dependsOn,
      state: "pending",
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      terminalPromise,
      resolveTerminal,
    };
  });

  validateSubtaskGraph(subtasks);

  const task: TaskRecord = {
    id: randomUUID(),
    name,
    state: "running",
    subtasks,
    createdAt,
    updatedAt: createdAt,
    cancelRequested: false,
    cancelController: new AbortController(),
  };
  tasks.set(task.id, task);
  void runTask(task.id);
  return task;
}

async function cancelTask(task: TaskRecord): Promise<{ cancelledSubtasks: number }> {
  task.cancelRequested = true;
  task.cancelController.abort();
  task.state = "cancelled";
  task.updatedAt = nowIso();

  let cancelledSubtasks = 0;
  const cancelAgents = new Set<string>();
  for (const subtask of task.subtasks) {
    const wasRunning = subtask.state === "running";
    if (subtask.state === "pending" || wasRunning) {
      const cancelledAt = nowIso();
      subtask.state = "cancelled";
      subtask.updatedAt = cancelledAt;
      subtask.completedAt = cancelledAt;
      subtask.resolveTerminal();
      cancelledSubtasks += 1;
      if (wasRunning) {
        cancelAgents.add(subtask.agent);
      }
    }
  }

  for (const agentName of cancelAgents) {
    const record = agents.get(agentName);
    if (!record) {
      continue;
    }
    if (!record.activeTask || record.activeTask.taskId !== task.id) {
      continue;
    }
    try {
      await record.connection.cancel({ sessionId: record.sessionId } as any);
      const cancelledPermissions = cancelAllPendingPermissions(record);
      if (cancelledPermissions > 0 || record.state === "working") {
        record.state = "idle";
        record.updatedAt = nowIso();
      }
    } catch {
      // best effort cancel
    }
  }

  cleanupCompletedTasks();

  return { cancelledSubtasks };
}

async function spawnAgentConnection(input: {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  getClient: () => acp.Client;
  onStderrLine?: (line: string) => void;
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
    const lines = data
      .toString("utf8")
      .split(/\r?\n/g)
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);
    for (const line of lines) {
      input.onStderrLine?.(line);
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
  const stderrBuffer: string[] = [];
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

  await preflightCheck(type, {
    ...finalEnv,
    ACP_BRIDGE_AGENT_COMMAND: input.command || configuredAgent?.command,
  });

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
        onStderrLine: (line: string) => {
          pushStderrLine(stderrBuffer, line);
          if (record) {
            record.updatedAt = nowIso();
            record.lastError = line;
          }
        },
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
    type,
    cwd,
    child,
    connection,
    sessionId: (session as any).sessionId,
    state: "idle",
    lastError: null,
    stderrBuffer,
    protocolVersion:
      typeof (init as any).protocolVersion === "number" || typeof (init as any).protocolVersion === "string"
        ? (init as any).protocolVersion
        : null,
    lastText: "",
    currentText: "",
    stopReason: null,
    pendingPermissions: [],
    activeTask: null,
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

type DoctorResult = {
  type: string;
  status: "ok" | "warning" | "error";
  binary: boolean;
  apiKey: boolean | null;
  endpoint: boolean | null;
  message?: string;
};

async function askAgent(
  name: string,
  prompt: string,
  onChunk?: (chunk: string) => void,
  activeTask?: { taskId: string; subtaskId: string },
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
  record.activeTask = activeTask ? { taskId: activeTask.taskId, subtaskId: activeTask.subtaskId } : null;
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
    record.lastError = classifyAskError(error);
    record.updatedAt = nowIso();
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (unsubscribe) {
      unsubscribe();
    }
    if (
      !activeTask ||
      (record.activeTask &&
        record.activeTask.taskId === activeTask.taskId &&
        record.activeTask.subtaskId === activeTask.subtaskId)
    ) {
      record.activeTask = null;
    }
  }
}

async function runDoctorForType(type: string, env: Record<string, string | undefined>): Promise<DoctorResult> {
  let binary = false;
  let apiKey: boolean | null = null;
  let endpoint: boolean | null = null;
  let message: string | undefined;

  const commandHint =
    type === "codex"
      ? "codex-acp"
      : type === "claude"
        ? "claude-agent-acp"
        : type === "gemini"
          ? "gemini"
          : "opencode";
  binary = commandExists(commandHint, env);
  if (!binary) {
    message = `${commandHint} binary not found on PATH`;
  }

  const keyRequirement = getApiKeyRequirement(type);
  if (keyRequirement.required) {
    apiKey = Boolean(getApiKeyValue(type, env));
    if (!apiKey && !message) {
      message = (keyRequirement.message || "required API key is missing").replace(". Set it in environment or config.", "");
    }
  }

  if (binary && (apiKey === null || apiKey)) {
    const baseUrl = getTypeBaseUrl(type, env);
    if (baseUrl) {
      const endpointResult = await endpointCheck(baseUrl);
      if (endpointResult.reachable) {
        endpoint = endpointResult.statusCode !== null && endpointResult.statusCode < 500;
        if (!endpoint && !message && endpointResult.statusCode !== null) {
          message =
            endpointResult.statusCode === 503
              ? "Endpoint returned 503 (service unavailable)"
              : `Endpoint returned ${endpointResult.statusCode}`;
        }
      } else {
        endpoint = false;
        if (!message) {
          message = `Proxy ${baseUrl} is unreachable (${endpointResult.errorCode || "UNKNOWN"})`;
        }
      }
    }
  }

  let status: "ok" | "warning" | "error" = "ok";
  if (!binary || apiKey === false) {
    status = "error";
  } else if (endpoint === false) {
    status = "warning";
  }

  const result: DoctorResult = {
    type,
    status,
    binary,
    apiKey,
    endpoint,
  };
  if (message) {
    result.message = message;
  }
  return result;
}

async function buildAgentDiagnose(record: AgentRecord): Promise<unknown> {
  const configured = bridgeConfig.agents?.[record.type];
  const env = {
    ...process.env,
    ...(configured?.env || {}),
  };
  const type = record.type;
  const keyRequirement = getApiKeyRequirement(type);
  const apiKeySet = keyRequirement.required ? Boolean(getApiKeyValue(type, env)) : true;
  const apiKeyFormat = apiKeyFormatStatus(type, env);
  const baseUrl = getTypeBaseUrl(type, env);
  const endpointResult = baseUrl ? await endpointCheck(baseUrl) : null;
  const endpointReachable = endpointResult
    ? endpointResult.reachable && endpointResult.statusCode !== null && endpointResult.statusCode < 500
    : true;

  return {
    agent: record.name,
    processAlive: !record.child.killed && record.child.exitCode === null,
    state: record.state,
    recentStderr: [...record.stderrBuffer],
    lastError: record.lastError,
    checks: {
      apiKeySet,
      apiKeyFormat,
      endpointReachable,
      endpointLatencyMs: endpointResult?.latencyMs ?? null,
      protocolVersion: record.protocolVersion ?? 1,
    },
  };
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

    if (method === "GET" && parts.length === 1 && parts[0] === "doctor") {
      const types = ["codex", "claude", "gemini", "opencode"];
      const results = await Promise.all(types.map((type) => runDoctorForType(type, process.env)));
      writeJson(res, 200, { results });
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

    if (parts.length === 3 && parts[0] === "agents" && method === "GET" && parts[2] === "diagnose") {
      const record = agents.get(parts[1]);
      if (!record) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const diagnose = await buildAgentDiagnose(record);
      writeJson(res, 200, diagnose);
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

    if (method === "POST" && parts.length === 1 && parts[0] === "tasks") {
      const body = await readJson(req);
      const task = createTask(body);
      writeJson(res, 201, toTaskStatus(task));
      return;
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "tasks") {
      writeJson(
        res,
        200,
        Array.from(tasks.values()).map((task) => toTaskStatus(task)),
      );
      return;
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "tasks") {
      const task = tasks.get(parts[1]);
      if (!task) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, toTaskStatus(task));
      return;
    }

    if (method === "GET" && parts.length === 4 && parts[0] === "tasks" && parts[2] === "subtasks") {
      const task = tasks.get(parts[1]);
      if (!task) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const subtask = findTaskSubtask(task, parts[3]);
      if (!subtask) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, {
        taskId: task.id,
        taskName: task.name,
        taskState: task.state,
        subtask: {
          id: subtask.id,
          agent: subtask.agent,
          prompt: subtask.prompt,
          dependsOn: subtask.dependsOn,
          state: subtask.state,
          result: subtask.result,
          error: subtask.error,
          createdAt: subtask.createdAt,
          updatedAt: subtask.updatedAt,
          startedAt: subtask.startedAt,
          completedAt: subtask.completedAt,
        },
      });
      return;
    }

    if (method === "DELETE" && parts.length === 2 && parts[0] === "tasks") {
      const task = tasks.get(parts[1]);
      if (!task) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const cancelled = await cancelTask(task);
      writeJson(res, 200, {
        ok: true,
        id: task.id,
        state: task.state,
        cancelledSubtasks: cancelled.cancelledSubtasks,
      });
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
  const cleanupInterval = setInterval(() => {
    cleanupCompletedTasks();
  }, 60000);

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
    clearInterval(cleanupInterval);
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
