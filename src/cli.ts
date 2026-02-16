#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Command = "start" | "ask" | "status" | "list" | "stop";

const DEFAULT_BASE_URL = "http://localhost:7890";

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
        "ask <name> <prompt>",
        "status <name>",
        "list",
        "stop <name>",
      ],
    });
  }
  if (!["start", "ask", "status", "list", "stop"].includes(command)) {
    printError(`unknown command: ${command}`);
  }

  return { baseUrl, command, args };
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
    } else if (command === "ask") {
      const name = rest.shift();
      if (!name) {
        printError("ask requires <name>");
      }
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        printError("ask requires <prompt>");
      }
      result = await requestJson(baseUrl, "POST", `/agents/${encodeURIComponent(name)}/ask`, {
        prompt,
      });
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
