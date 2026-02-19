# ACP Bridge v0.3.0

Multi-agent orchestrator for [OpenClaw](https://openclaw.ai) and other AI platforms. Manages coding agents ([OpenCode](https://opencode.ai), [Codex CLI](https://github.com/openai/codex), [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli)) through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — structured JSON-RPC over stdio, multi-agent task execution, dependency chains, and built-in diagnostics.

## Why

If you use [OpenClaw](https://openclaw.ai) or orchestrate multiple AI coding agents, you've probably resorted to tmux `send-keys` / `capture-pane` hacks. That approach is:

- **Wasteful** - polling burns tokens on non-semantic terminal output
- **Fragile** - ANSI escape codes, progress bars, rendering artifacts
- **Blind** - no reliable way to know if an agent is idle, running, or waiting on approval

ACP Bridge replaces that with a stable HTTP API backed by the Agent Client Protocol (ACP).

## How it works

```text
You / Orchestrator
    ↓ HTTP
ACP Bridge Daemon
    ↓ JSON-RPC over stdio
opencode / codex / claude / gemini (ACP mode)
    ↓
LLM API
```

### OpenClaw Integration

ACP Bridge is designed to work with [OpenClaw](https://openclaw.ai) — an autonomous AI agent platform. OpenClaw agents can use ACP Bridge to dispatch coding tasks to multiple coding agents (Codex, Claude, Gemini) in parallel, with full permission control and diagnostics.

```text
OpenClaw Agent (e.g. Otacon, Raiden)
    ↓ HTTP (localhost:7800)
ACP Bridge Daemon
    ↓ ACP over stdio
codex / claude / gemini
    ↓
LLM APIs (OpenAI, Anthropic, Google)
```

Typical workflow:
1. OpenClaw agent starts ACP Bridge daemon
2. Spawns coding agents as needed (`start codex`, `start claude`, etc.)
3. Sends tasks via `ask` or creates multi-agent task graphs via `/tasks`
4. Monitors progress, approves/denies permissions, handles errors
5. Uses `doctor` and `diagnose` for automated troubleshooting

## Installation

```bash
# Global install (recommended)
npm install -g acp-bridge

# Or clone and build
git clone https://github.com/allvegetable/acp-bridge.git
cd acp-bridge
npm install && npm run build
```

## Quick Start

```bash
# Install globally
npm install -g acp-bridge

# Global commands installed by npm
acp-bridge --help
acp-bridged --help

# Start daemon (foreground)
ACP_BRIDGE_PORT=7800 acp-bridged

# Or manage daemon in background
acp-bridge daemon start

# Start agents
acp-bridge --url http://127.0.0.1:7800 start opencode --name my-agent --cwd ~/my-project
acp-bridge --url http://127.0.0.1:7800 start codex --name codex-agent --cwd ~/my-project
acp-bridge --url http://127.0.0.1:7800 start claude --name claude-agent --cwd ~/my-project
acp-bridge --url http://127.0.0.1:7800 start gemini --name gemini-agent --cwd ~/my-project

# Ask, stream, inspect
acp-bridge --url http://127.0.0.1:7800 ask my-agent "refactor the auth module"
acp-bridge --url http://127.0.0.1:7800 ask my-agent --stream "refactor the auth module"
acp-bridge --url http://127.0.0.1:7800 status my-agent
acp-bridge --url http://127.0.0.1:7800 list

# Permission and session control
acp-bridge --url http://127.0.0.1:7800 approve my-agent
acp-bridge --url http://127.0.0.1:7800 deny my-agent
acp-bridge --url http://127.0.0.1:7800 cancel my-agent

# Stop agent / daemon
acp-bridge --url http://127.0.0.1:7800 stop my-agent
acp-bridge daemon status
acp-bridge daemon stop
```

Default daemon address is `127.0.0.1:7800`.

Alternative local development flow:

```bash
git clone https://github.com/allvegetable/acp-bridge.git
cd acp-bridge
npm install
npm run build
node dist/daemon.js
```

## Config File

Create `~/.config/acp-bridge/config.json`:

```json
{
  "port": 7800,
  "host": "127.0.0.1",
  "agents": {
    "opencode": {
      "command": "~/.opencode/bin/opencode",
      "args": ["acp"],
      "env": {
        "OPENAI_API_KEY": "your-key",
        "OPENAI_BASE_URL": "https://api.openai.com/v1"
      }
    },
    "claude": {
      "command": "claude-agent-acp",
      "env": {
        "ANTHROPIC_API_KEY": "your-key",
        "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
      }
    },
    "codex": {
      "command": "codex-acp",
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    },
    "gemini": {
      "command": "gemini",
      "args": ["--experimental-acp"],
      "env": {
        "GEMINI_API_KEY": "your-key",
        "GOOGLE_GEMINI_BASE_URL": "https://generativelanguage.googleapis.com"
      }
    }
  }
}
```

Environment variables like `ACP_BRIDGE_PORT` and `ACP_BRIDGE_HOST` still override config file values.

## Supported Agents

| Agent | Status | Adapter | Notes |
|-------|--------|---------|-------|
| [OpenCode](https://opencode.ai) | ✅ Working | Native | `opencode acp` - built-in ACP support |
| [Codex CLI](https://github.com/openai/codex) | ✅ Working | [codex-acp](https://github.com/cola-io/codex-acp) | Third-party adapter, patched for Codex 0.101.0 |
| [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) | ✅ Working | [claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) | Zed's official ACP adapter wrapping Claude Agent SDK |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | ✅ Working | Native | `gemini --experimental-acp` - built-in ACP support |

### Adapter Details

Each agent type uses a different path to speak ACP over stdio:

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────┐
│  acp-bridge  │────▶│  opencode acp    │────▶│ LLM API │
│  daemon      │     └──────────────────┘     └─────────┘
│              │     ┌──────────────────┐     ┌─────────┐
│              │────▶│  codex-acp       │────▶│ OpenAI  │
│              │     └──────────────────┘     └─────────┘
│              │     ┌──────────────────┐     ┌─────────┐
│              │────▶│ claude-agent-acp │────▶│Anthropic│
│              │     └──────────────────┘     └─────────┘
│              │     ┌──────────────────┐     ┌─────────┐
│              │────▶│ gemini --exp-acp │────▶│ Google  │
└─────────────┘     └──────────────────┘     └─────────┘
```

**OpenCode** - Native ACP. Just works with `opencode acp`.

**Codex CLI** - Uses [codex-acp](https://github.com/cola-io/codex-acp), a Rust adapter that wraps the Codex CLI library as an ACP agent. We pin to the `rust-v0.101.0` revision to match Codex CLI 0.101.0. The daemon tries `codex-acp` first, then falls back to `codex mcp-server`.

**Claude CLI** - Uses [@zed-industries/claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) (v0.17.1), Zed's official adapter that wraps the Claude Agent SDK as a standard ACP agent. Install with `npm install -g @zed-industries/claude-agent-acp`. Note: this adapter uses ACP protocol version `1` (numeric) instead of the date-string format used by other agents - ACP Bridge handles both transparently.

Required environment variables for Claude:
```bash
ANTHROPIC_API_KEY="your-key"          # or use ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL="https://api.anthropic.com"  # optional, for proxy/custom endpoints
```

**Gemini CLI** - Native ACP support via `gemini --experimental-acp`. Install with `npm install -g @google/gemini-cli`. The daemon spawns `gemini --experimental-acp` over stdio. Like `claude-agent-acp`, it uses ACP protocol version `1` (numeric).

Required environment variables for Gemini:
```bash
GEMINI_API_KEY="your-key"
GOOGLE_GEMINI_BASE_URL="https://generativelanguage.googleapis.com"  # optional, for proxy
# Note: do NOT include /v1 suffix - the SDK appends /v1beta/ automatically
```

## API

The daemon exposes a REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/doctor` | Run system-wide diagnostics for all configured agent types |
| `POST` | `/agents` | Start a new agent |
| `GET` | `/agents` | List all agents |
| `GET` | `/agents/:name` | Get agent status |
| `POST` | `/agents/:name/ask` | Send prompt, wait for response |
| `POST` | `/agents/:name/ask?stream=true` | SSE stream chunks and final result |
| `POST` | `/agents/:name/approve` | Approve next pending permission request |
| `POST` | `/agents/:name/deny` | Deny next pending permission request |
| `POST` | `/agents/:name/cancel` | Cancel current session work (`session/cancel`) |
| `GET` | `/agents/:name/diagnose` | Deep health check for a running agent |
| `DELETE` | `/agents/:name` | Stop an agent |
| `POST` | `/tasks` | Create a task graph with one or more subtasks |
| `GET` | `/tasks` | List tasks |
| `GET` | `/tasks/:id` | Get task status and aggregate output |
| `GET` | `/tasks/:id/subtasks/:subtaskId` | Get one subtask status and output |
| `DELETE` | `/tasks/:id` | Cancel a running task |

## Task System

Use tasks to run multiple subtasks in parallel or in dependency chains across agents.

Create a parallel task:

```bash
acp-bridge task create '{"name":"ship-auth","subtasks":[{"id":"scan","agent":"codex-agent","prompt":"scan auth module for dead code"},{"id":"tests","agent":"claude-agent","prompt":"design edge-case tests for auth module"}]}'
```

Create a dependency chain with `dependsOn` and `{{dep.result}}` templates:

```bash
acp-bridge task create '{"name":"fix-and-verify","subtasks":[{"id":"analyze","agent":"my-agent","prompt":"find bug in session refresh flow"},{"id":"patch","agent":"my-agent","dependsOn":["analyze"],"prompt":"apply this fix: {{analyze.result}}"},{"id":"verify","agent":"codex-agent","dependsOn":["patch"],"prompt":"review and validate patch: {{patch.result}}"}]}'
```

Task lifecycle:

- `running` - task/subtask is actively executing
- `done` - completed successfully
- `error` - failed; inspect error payload and diagnostics
- `cancelled` - cancelled by user or cascading cancellation

Task CLI commands:

```bash
acp-bridge task create '{"name":"...","subtasks":[...]}'
acp-bridge task status <id>
acp-bridge task list
acp-bridge task cancel <id>
```

## Diagnostics

ACP Bridge includes runtime diagnostics and preflight validation to catch setup issues early.

- `acp-bridge doctor` - checks all configured agent types and reports readiness
- `GET /agents/:name/diagnose` - deep health check for a running agent process
- Preflight checks run on agent start (binary presence, config completeness, protocol compatibility, upstream connectivity)
- Error classification normalizes failures into stable codes for debugging and automation

Common error classes:

- `AUTH_INVALID` - API key invalid, expired, or rejected by provider/proxy
- `UPSTREAM_UNAVAILABLE` - provider/proxy unavailable (often HTTP 503)
- `CONNECTION_REFUSED` - daemon cannot reach configured base URL/endpoint
- `BINARY_NOT_FOUND` - required CLI/adapter executable missing in PATH
- `STREAM_TERMINATED` - upstream stream ended unexpectedly without finish reason
- `PROTOCOL_MISMATCH` - ACP protocol version mismatch between bridge and agent

## Troubleshooting

- **"API key invalid or expired"**: verify the key, and if using a proxy ensure provider-specific key format is accepted by that proxy.
- **"Service unavailable (503)"**: your proxy/provider likely has no available channels/capacity; retry later or switch endpoint.
- **"Connection refused"**: check `--url` and configured base URLs (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`).
- **"binary not found"**: install the agent CLI/adapter and confirm it is in PATH.
- **"Model stream ended without finish reason"**: usually an upstream proxy/provider stream issue, not local ACP Bridge config.
- **"protocol mismatch"**: upgrade ACP Bridge and the relevant agent adapter so protocol versions are compatible.
- Use `acp-bridge doctor` first, then call `GET /agents/:name/diagnose` for deep checks on a running agent.

## Roadmap

- [x] Phase 1: Daemon + CLI + OpenCode support
- [x] Phase 2: Codex, Claude, Gemini support + permission/session controls
- [x] Phase 3: Parallel multi-agent tasks, dependency chains, task lifecycle APIs and CLI
- [x] Phase 4: Diagnostics, npm publish, documentation updates
- [ ] Future: OpenClaw skill integration
- [ ] Future: Web UI

## Related

- [ACP Protocol](https://agentclientprotocol.com) - The standard this project builds on
- [agent-team](https://github.com/nekocode/agent-team) - Multi-agent CLI orchestrator (standalone)
- [codex-acp](https://github.com/cola-io/codex-acp) - Codex CLI ACP adapter (Rust)
- [claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) - Claude CLI ACP adapter by Zed Industries

## License

MIT
