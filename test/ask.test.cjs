const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { after, before, test } = require("node:test");
const { promisify } = require("node:util");

const repoPath = resolve(__dirname, "..");
const agentName = "ask-fixture";
const agentPath = `/agents/${agentName}`;
let daemon;
let baseUrl;
let tempPath;
let capturePath;
let daemonStderr = "";

before(async () => {
  tempPath = mkdtempSync(join(tmpdir(), "acp-bridge-ask-"));
  capturePath = join(tempPath, "prompts.jsonl");
  writeFileSync(capturePath, "");
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, [join(repoPath, "dist/daemon.js")], {
    cwd: repoPath,
    env: {
      ...process.env,
      ACP_BRIDGE_HOST: "127.0.0.1",
      ACP_BRIDGE_PORT: String(port),
      ACP_BRIDGE_ASK_TIMEOUT_MS: "500",
      OPENAI_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (data) => { daemonStderr += data.toString(); });
  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: daemon.stdout });
    const timer = setTimeout(() => finish(new Error(`Daemon startup timed out: ${daemonStderr}`)), 10000);
    const onExit = (code) => finish(new Error(`Daemon exited (${code}): ${daemonStderr}`));
    const finish = (error) => {
      clearTimeout(timer);
      lines.close();
      daemon.removeListener("exit", onExit);
      daemon.removeListener("error", finish);
      error ? reject(error) : resolve();
    };
    daemon.once("exit", onExit);
    daemon.once("error", finish);
    lines.on("line", (line) => {
      if (JSON.parse(line).event === "listening") finish();
    });
  });
  const response = await post("/agents", {
    name: agentName,
    type: "ask-test-fixture",
    cwd: repoPath,
    command: process.execPath,
    args: [join(__dirname, "fixtures/acp-agent.cjs"), capturePath],
  });
  assert.equal(response.status, 201, await response.text());
}, { timeout: 15000 });

after(async () => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const closed = once(daemon, "close");
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 5000);
    daemon.kill("SIGTERM");
    await closed;
    clearTimeout(timer);
  }
  if (tempPath) rmSync(tempPath, { recursive: true, force: true });
});

function post(path, body, raw = false) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

function capturedPrompts() {
  const lines = readFileSync(capturePath, "utf8").trim();
  return lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
}

async function readSse(response) {
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { value, done } = await reader.read();
    buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, boundary).split("\n");
      buffered = buffered.slice(boundary + 2);
      const event = frame.find((line) => line.startsWith("event: ")).slice(7);
      const data = JSON.parse(frame.find((line) => line.startsWith("data: ")).slice(6));
      events.push({ event, data });
    }
    if (done) break;
  }
  assert.equal(buffered, "");
  return events;
}

const image = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=",
  mimeType: "image/png",
  uri: "file:///attachments/pixel.png",
  annotations: { audience: ["user"], priority: 0.9, lastModified: "2026-03-22T00:00:00Z" },
  _meta: { "example.com/attachment": { id: "pixel", tags: [1, "image"] } },
  "example.com/extension": { trace: "preserve-on-wire" },
};
const audio = { type: "audio", data: "UklGRg==", mimeType: "audio/wav" };
const textFile = {
  type: "resource",
  resource: { uri: "file:///attachments/note.txt", mimeType: "text/plain", text: "设备参数\nline 2", _meta: { source: "upload" } },
};
const binaryFile = {
  type: "resource",
  resource: { uri: "file:///attachments/report.pdf", mimeType: "application/pdf", blob: "JVBERi0xLjQK" },
  annotations: { audience: ["user"] },
};
const link = {
  type: "resource_link", name: "report.pdf", uri: "file:///attachments/report.pdf",
  mimeType: "application/pdf", title: "Report", description: "Test attachment", size: 9,
};
const mixed = [{ type: "text", text: "分析图片和附件 🖼️" }, image, textFile, binaryFile, link, audio];
const legacyPrompt = "  保留原始空格\nsecond line 🖼️  ";
const successes = [
  ["legacy prompt", { prompt: legacyPrompt }, [{ type: "text", text: legacyPrompt }]],
  ["legacy whitespace prompt", { prompt: " " }, [{ type: "text", text: " " }]],
  ["text content", { content: [{ type: "text", text: "hello" }] }, [{ type: "text", text: "hello" }]],
  ["image content without prompt", { content: [image] }, [image]],
  ["embedded text file", { content: [textFile] }, [textFile]],
  ["embedded binary file", { content: [binaryFile] }, [binaryFile]],
  ["resource link", { content: [link] }, [link]],
  ["audio content", { content: [audio] }, [audio]],
  ["mixed content and metadata", { content: mixed }, mixed],
  ["content overrides prompt", { prompt: "legacy fallback", content: mixed }, mixed],
  ["content overrides empty prompt", { prompt: "", content: [image] }, [image]],
  ["nullable optional fields", { content: [{ type: "text", text: "", annotations: null, _meta: null }] }, [{ type: "text", text: "", annotations: null, _meta: null }]],
  ["large file body", { content: [{ type: "resource", resource: { uri: "file:///large.txt", text: "x".repeat(128 * 1024) } }] }, [{ type: "resource", resource: { uri: "file:///large.txt", text: "x".repeat(128 * 1024) } }]],
];

const invalidInputs = [
  ["issue #2 original image example", {
    prompt: "Please analyze this image",
    content: [
      { type: "text", text: "Please analyze this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
    ],
  }, /content\[1\].*top-level data.*mimeType.*source\.data.*source\.media_type/],
  ["missing input", {}, /prompt is required/],
  ["empty prompt", { prompt: "" }, /prompt is required/],
  ...[null, 42, false, {}, []].map((prompt) => [`legacy prompt ${JSON.stringify(prompt)}`, { prompt }, /prompt is required/]),
  ...[null, "hello", 42, []].map((body) => [`body ${JSON.stringify(body)}`, body, /JSON object/]),
  ...[null, "hello", {}, []].map((content) => [`content ${JSON.stringify(content)}`, { prompt: "fallback", content }, /non-empty array/]),
  ["invalid companion prompt", { prompt: 42, content: [image] }, /prompt must be a string/],
  ["null companion prompt", { prompt: null, content: [image] }, /prompt must be a string/],
  ...[
    null, "text", [], {}, { type: "file" }, { type: "video" },
    { type: "text", text: 42 },
    { type: "text", text: "ok", _meta: "bad" },
    { type: "text", text: "ok", annotations: { audience: ["invalid"] } },
    { type: "image", data: "abc" },
    { type: "image", data: 42, mimeType: "image/png" },
    { type: "image", data: "abc", mimeType: null },
    { type: "image", data: "abc", mimeType: "image/png", uri: 42 },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    { type: "audio", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "file:///report.pdf" } },
    { type: "resource", resource: { text: "missing uri" } },
    { type: "resource", resource: { uri: "file:///report.pdf", blob: 42 } },
    { type: "resource", resource: "bad" },
    { type: "resource_link", uri: "file:///report.pdf" },
    { type: "resource_link", name: "report.pdf", uri: 42 },
  ].map((block, index) => [`invalid block ${index}`, { content: [block] }, /content\[0\]/]),
  ["invalid second block", { content: [image, { type: "text" }] }, /content\[1\]/],
];

for (const stream of [false, true]) {
  const askPath = agentPath + "/ask" + (stream ? "?stream=true" : "");
  for (const [label, body, expected] of successes) {
    test(`${stream ? "SSE" : "JSON"}: ${label}`, async () => {
      const beforeCount = capturedPrompts().length;
      const response = await post(askPath, body);
      assert.equal(response.status, 200);
      const result = { name: agentName, state: "idle", stopReason: "end_turn", response: JSON.stringify(expected) };
      if (stream) {
        const events = await readSse(response);
        assert.deepEqual(events.map((item) => item.event), ["chunk", "chunk", "done"]);
        assert.equal(events.slice(0, 2).map((item) => item.data.chunk).join(""), result.response);
        assert.deepEqual(events[2].data, result);
      } else {
        assert.match(response.headers.get("content-type"), /^application\/json/);
        assert.deepEqual(await response.json(), result);
      }
      const requests = capturedPrompts();
      assert.equal(requests.length, beforeCount + 1);
      assert.deepEqual(requests.at(-1), { sessionId: "fixture-session", prompt: expected });
    });
  }

  test(`${stream ? "SSE" : "JSON"}: validation rejects before prompting or opening SSE`, async (t) => {
    const beforeCount = capturedPrompts().length;
    const statusBefore = await (await fetch(baseUrl + agentPath)).json();
    for (const [label, body, error] of invalidInputs) {
      await t.test(label, async () => {
        const response = await post(askPath, body);
        assert.equal(response.status, 400);
        assert.match(response.headers.get("content-type"), /^application\/json/);
        assert.match((await response.json()).error, error);
      });
    }
    for (const [label, raw, error] of [["malformed JSON", "{", "invalid JSON body"], ["empty body", "", "prompt is required"]]) {
      await t.test(label, async () => {
        const response = await post(askPath, raw, true);
        assert.equal(response.status, 400);
        assert.match(response.headers.get("content-type"), /^application\/json/);
        assert.deepEqual(await response.json(), { error });
      });
    }
    assert.equal(capturedPrompts().length, beforeCount);
    assert.deepEqual(await (await fetch(baseUrl + agentPath)).json(), statusBefore);
  });

  for (const failure of ["error", "timeout"]) {
    test(`${stream ? "SSE" : "JSON"}: upstream ${failure} preserves error handling`, async () => {
      const content = [{ type: "text", text: `fixture:${failure}` }, image, binaryFile];
      const response = await post(askPath, { content });
      const expectedStatus = failure === "timeout" ? 408 : 500;
      let error;
      if (stream) {
        assert.equal(response.status, 200);
        const events = await readSse(response);
        assert.deepEqual(events.map((item) => item.event), ["error"]);
        assert.equal(events[0].data.statusCode, expectedStatus);
        error = events[0].data.error;
      } else {
        assert.equal(response.status, expectedStatus);
        error = (await response.json()).error;
      }
      if (stream && failure === "error") {
        // SDK 0.14.1 rejects RPC errors as plain objects; preserve the existing SSE envelope.
        assert.equal(error, "[object Object]");
      } else {
        assert.match(error, failure === "timeout" ? /ask timeout after 500ms/ : /fixture prompt failure/);
      }
      assert.deepEqual(capturedPrompts().at(-1).prompt, content);
      const status = await (await fetch(baseUrl + agentPath)).json();
      assert.equal(status.state, failure === "timeout" ? "idle" : "error");
      if (failure === "error") assert.match(status.lastError, /fixture prompt failure/);
      const recovery = await post(agentPath + "/ask", { prompt: "recovered" });
      assert.equal(recovery.status, 200);
      assert.equal((await recovery.json()).state, "idle");
    });
  }
}

for (const stream of [false, true]) {
  test(`legacy CLI ask ${stream ? "SSE" : "JSON"}`, async () => {
    const prompt = "legacy CLI text";
    const expected = [{ type: "text", text: prompt }];
    const beforeCount = capturedPrompts().length;
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(repoPath, "dist/cli.js"), "--url", baseUrl, "ask", agentName,
      ...(stream ? ["--stream"] : []), prompt,
    ], { timeout: 10000 });
    const lines = stdout.trim().split("\n");
    assert.deepEqual(JSON.parse(lines.at(-1)), {
      name: agentName, state: "idle", stopReason: "end_turn", response: JSON.stringify(expected),
    });
    if (stream) assert.equal(lines[0], JSON.stringify(expected));
    assert.equal(capturedPrompts().length, beforeCount + 1);
    assert.deepEqual(capturedPrompts().at(-1).prompt, expected);
  });
}

test("legacy task caller preserves the string form of askAgent", async () => {
  const prompt = "  task text\nwith whitespace  ";
  const expected = [{ type: "text", text: prompt }];
  const beforeCount = capturedPrompts().length;
  const response = await post("/tasks", {
    name: "legacy-task-test",
    subtasks: [{ id: "text", agent: agentName, prompt }],
  });
  assert.equal(response.status, 201);
  let task = await response.json();
  const deadline = Date.now() + 5000;
  while (task.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    task = await (await fetch(baseUrl + `/tasks/${task.id}`)).json();
  }
  assert.equal(task.state, "done");
  assert.equal(task.subtasks[0].result, JSON.stringify(expected));
  assert.equal(capturedPrompts().length, beforeCount + 1);
  assert.deepEqual(capturedPrompts().at(-1).prompt, expected);
});
