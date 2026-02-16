#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Command = "start" | "ask" | "status" | "list" | "stop" | "daemon";
type DaemonAction = "start" | "stop" | "status";
type AskOptions = { name: string; prompt: string; stream: boolean };

const DEFAULT_BASE_URL = "http://localhost:7800";
const PID_FILE = "/tmp/acp-bridge.pid";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printError(message: string, details?: unknown): never {
  const body: Record<string, unknown> = { ok: false, error: message };
  if (details !== undefined) {
    body.details = details;
  }
  printJson(body);
  process.exit(1);
}

function parseArgs(argv: string[]): { baseUrl: string; command: Command; args: string[] } {
  let baseUrl = process.env.ACP_BRIDGE_URL || DEFAULT_BASE_URL;
  const args = [...argv];

  while (args[0] === "--url") {
    args.shift();
    const value = args.shift();
    if (!value) {
      printError("missing value for --url");
    }
    baseUrl = value;
  }

  const command = args.shift() as Command | undefined;
  if (!command) {
    printError("missing command", {
      usage: [
        "start <type> --name <name> [--cwd <path>]",
        "ask <name> [--stream] <prompt>",
        "status <name>",
        "list",
        "stop <name>",
        "daemon start|stop|status",
      ],
    });
  }
  if (!["start", "ask", "status", "list", "stop", "daemon"].includes(command)) {
    printError(`unknown command: ${command}`);
  }

  return { baseUrl, command, args };
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseDaemonAction(args: string[]): DaemonAction {
  const action = args.shift();
  if (!action) {
    printError("daemon requires start|stop|status");
  }
  if (!["start", "stop", "status"].includes(action)) {
    printError(`unknown daemon action: ${action}`);
  }
  return action as DaemonAction;
}

function daemonStart(): unknown {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    return { ok: true, daemon: "running", pid: existingPid };
  }
  if (existingPid && !isProcessRunning(existingPid)) {
    rmSync(PID_FILE, { force: true });
  }

  const daemonEntrypoint = join(__dirname, "daemon.js");
  const child = spawn(process.execPath, [daemonEntrypoint], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`, "utf8");
  return { ok: true, daemon: "started", pid: child.pid };
}

function daemonStop(): unknown {
  const pid = readPid();
  if (!pid) {
    return { ok: true, daemon: "stopped", pid: null };
  }
  if (!isProcessRunning(pid)) {
    rmSync(PID_FILE, { force: true });
    return { ok: true, daemon: "stopped", pid };
  }
  process.kill(pid, "SIGTERM");
  rmSync(PID_FILE, { force: true });
  return { ok: true, daemon: "stopped", pid };
}

function daemonStatus(): unknown {
  const pid = readPid();
  if (!pid) {
    return { ok: true, daemon: "stopped" };
  }
  if (!isProcessRunning(pid)) {
    rmSync(PID_FILE, { force: true });
    return { ok: true, daemon: "stopped" };
  }
  return { ok: true, daemon: "running", pid };
}

function parseStartArgs(args: string[]): { type: string; name: string; cwd?: string } {
  const type = args.shift();
  if (!type) {
    printError("start requires <type>");
  }

  let name: string | undefined;
  let cwd: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }

    if (token === "--name") {
      const value = args.shift();
      if (!value) {
        printError("missing value for --name");
      }
      name = value;
      continue;
    }

    if (token === "--cwd") {
      const value = args.shift();
      if (!value) {
        printError("missing value for --cwd");
      }
      cwd = value;
      continue;
    }

    printError(`unknown start option: ${token}`);
  }

  if (!name) {
    printError("start requires --name <name>");
  }

  return { type, name, cwd };
}

function parseAskArgs(args: string[]): AskOptions {
  const name = args.shift();
  if (!name) {
    printError("ask requires <name>");
  }
  let stream = false;
  const promptParts: string[] = [];
  while (args.length > 0) {
    const token = args.shift() as string;
    if (token === "--stream") {
      stream = true;
      continue;
    }
    promptParts.push(token);
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    printError("ask requires <prompt>");
  }
  return { name, prompt, stream };
}

function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: JsonValue,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    } catch (error) {
      reject(new Error(`invalid base url: ${baseUrl}`));
      return;
    }

    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = httpRequest(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          let data: unknown = null;

          if (text.length > 0) {
            try {
              data = JSON.parse(text);
            } catch {
              data = { raw: text };
            }
          }

          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(data);
            return;
          }

          reject({ statusCode, data });
        });
      },
    );

    req.on("error", (error) => {
      reject(error);
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function requestSse(baseUrl: string, path: string, body?: JsonValue): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    } catch {
      reject(new Error(`invalid base url: ${baseUrl}`));
      return;
    }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();
            let data: unknown = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch {
                data = { raw: text };
              }
            }
            reject({ statusCode, data });
          });
          return;
        }

        let buffer = "";
        let doneResult: unknown = null;

        const consumeBlock = (block: string) => {
          const lines = block.split("\n");
          let event = "message";
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }
          if (dataLines.length === 0) {
            return;
          }
          let payloadData: any = dataLines.join("\n");
          try {
            payloadData = JSON.parse(payloadData);
          } catch {
            // keep raw string
          }
          if (event === "chunk") {
            const text = payloadData?.chunk;
            if (typeof text === "string") {
              process.stdout.write(text);
            }
            return;
          }
          if (event === "done") {
            doneResult = payloadData;
            return;
          }
          if (event === "error") {
            reject(new Error(payloadData?.error || "stream error"));
          }
        };

        res.on("data", (chunk) => {
          buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          let splitIndex = buffer.indexOf("\n\n");
          while (splitIndex >= 0) {
            const block = buffer.slice(0, splitIndex).trim();
            buffer = buffer.slice(splitIndex + 2);
            if (block) {
              consumeBlock(block);
            }
            splitIndex = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => {
          process.stdout.write("\n");
          resolve(doneResult);
        });
      },
    );

    req.on("error", (error) => {
      reject(error);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function main(): Promise<void> {
  const { baseUrl, command, args } = parseArgs(process.argv.slice(2));
  const rest = [...args];

  try {
    let result: unknown;

    if (command === "start") {
      const parsed = parseStartArgs(rest);
      result = await requestJson(baseUrl, "POST", "/agents", {
        type: parsed.type,
        name: parsed.name,
        cwd: parsed.cwd,
      });
    } else if (command === "daemon") {
      const action = parseDaemonAction(rest);
      if (action === "start") {
        result = daemonStart();
      } else if (action === "stop") {
        result = daemonStop();
      } else {
        result = daemonStatus();
      }
    } else if (command === "ask") {
      const parsed = parseAskArgs(rest);
      if (parsed.stream) {
        result = await requestSse(
          baseUrl,
          `/agents/${encodeURIComponent(parsed.name)}/ask?stream=true`,
          { prompt: parsed.prompt },
        );
      } else {
        result = await requestJson(baseUrl, "POST", `/agents/${encodeURIComponent(parsed.name)}/ask`, {
          prompt: parsed.prompt,
        });
      }
    } else if (command === "status") {
      const name = rest.shift();
      if (!name) {
        printError("status requires <name>");
      }
      result = await requestJson(baseUrl, "GET", `/agents/${encodeURIComponent(name)}`);
    } else if (command === "list") {
      result = await requestJson(baseUrl, "GET", "/agents");
    } else if (command === "stop") {
      const name = rest.shift();
      if (!name) {
        printError("stop requires <name>");
      }
      result = await requestJson(baseUrl, "DELETE", `/agents/${encodeURIComponent(name)}`);
    }

    printJson(result ?? { ok: true });
  } catch (error: any) {
    if (error && typeof error === "object" && "statusCode" in error) {
      printError(`http error ${(error as any).statusCode}`, (error as any).data);
    }

    if (error instanceof Error) {
      printError(error.message);
    }

    printError(String(error));
  }
}

void main();
