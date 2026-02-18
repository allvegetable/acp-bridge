# ACP Bridge

A daemon + CLI tool that manages coding agents (like [OpenCode](https://opencode.ai), Codex CLI, Claude CLI) through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — replacing fragile tmux screen-scraping with structured JSON-RPC communication.

> ⚠️ **Early stage** — This project is under active development. Phase 1 & 2 complete (OpenCode + Codex + Claude), Phase 3 in progress.

## Why

If you orchestrate multiple AI coding agents, you've probably resorted to tmux `send-keys` / `capture-pane` hacks. That approach is:

- **Wasteful** — polling burns 2000-4000 tokens per interaction, 60-70% is garbage
- **Fragile** — ANSI escape codes, progress bars, rendering artifacts
- **Blind** — no reliable way to know if the agent is idle, working, or waiting for approval

ACP Bridge replaces all of that with a single HTTP API backed by the ACP standard protocol.

## How it works

```
You / Orchestrator
    ↓ HTTP
ACP Bridge Daemon
    ↓ JSON-RPC over stdio
opencode / codex / claude (ACP mode)
    ↓
LLM API
```

## Quick Start

```bash
# Install
git clone https://github.com/YourUsername/acp-bridge.git
cd acp-bridge
npm install
npx tsc

# Start the daemon
ACP_BRIDGE_PORT=7800 node dist/daemon.js
# or manage it in background
node dist/cli.js daemon start

# In another terminal — start an agent
node dist/cli.js --url http://localhost:7800 start opencode --name my-agent --cwd ~/my-project
# Codex (Phase 2): tries `codex-acp`, falls back to `codex mcp-server`
node dist/cli.js --url http://localhost:7800 start codex --name codex-agent --cwd ~/my-project
# Claude (Phase 2): uses `claude-agent-acp` adapter
node dist/cli.js --url http://localhost:7800 start claude --name claude-agent --cwd ~/my-project
# Gemini (Phase 2): uses `gemini --experimental-acp`
node dist/cli.js --url http://localhost:7800 start gemini --name gemini-agent --cwd ~/my-project

# Send a prompt and get a structured response
node dist/cli.js --url http://localhost:7800 ask my-agent "refactor the auth module"
# → {"name":"my-agent","state":"idle","stopReason":"end_turn","response":"..."}

# Stream output with SSE
node dist/cli.js --url http://localhost:7800 ask my-agent --stream "refactor the auth module"

# Check status
node dist/cli.js --url http://localhost:7800 status my-agent

# List all agents
node dist/cli.js --url http://localhost:7800 list

# Stop an agent
node dist/cli.js --url http://localhost:7800 stop my-agent

# Approve / deny / cancel (permission + session control)
node dist/cli.js --url http://localhost:7800 approve my-agent
node dist/cli.js --url http://localhost:7800 deny my-agent
node dist/cli.js --url http://localhost:7800 cancel my-agent

# daemon control
node dist/cli.js daemon status
node dist/cli.js daemon stop
```

Default daemon address is `127.0.0.1:7800`.

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
| [OpenCode](https://opencode.ai) | ✅ Working | Native | `opencode acp` — built-in ACP support |
| [Codex CLI](https://github.com/openai/codex) | ✅ Working | [codex-acp](https://github.com/cola-io/codex-acp) | Third-party adapter, patched for Codex 0.101.0 |
| [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) | ✅ Working | [claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) | Zed's official ACP adapter wrapping Claude Agent SDK |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | ✅ Working | Native | `gemini --experimental-acp` — built-in ACP support |

### Adapter Details

Each agent type uses a different path to speak ACP over stdio:

```
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

**OpenCode** — Native ACP. Just works with `opencode acp`.

**Codex CLI** — Uses [codex-acp](https://github.com/cola-io/codex-acp), a Rust adapter that wraps the Codex CLI library as an ACP agent. We pin to the `rust-v0.101.0` revision to match Codex CLI 0.101.0. The daemon tries `codex-acp` first, then falls back to `codex mcp-server`.

**Claude CLI** — Uses [@zed-industries/claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) (v0.17.1), Zed's official adapter that wraps the Claude Agent SDK as a standard ACP agent. Install with `npm install -g @zed-industries/claude-agent-acp`. Note: this adapter uses ACP protocol version `1` (numeric) instead of the date-string format used by other agents — acp-bridge handles both transparently.

Required environment variables for Claude:
```bash
ANTHROPIC_API_KEY="your-key"          # or use ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL="https://api.anthropic.com"  # optional, for proxy/custom endpoints
```

**Gemini CLI** — Native ACP support via `gemini --experimental-acp`. Install with `npm install -g @google/gemini-cli`. The daemon spawns `gemini --experimental-acp` over stdio. Like claude-agent-acp, it uses ACP protocol version `1` (numeric).

Required environment variables for Gemini:
```bash
GEMINI_API_KEY="your-key"
GOOGLE_GEMINI_BASE_URL="https://generativelanguage.googleapis.com"  # optional, for proxy
# Note: do NOT include /v1 suffix — the SDK appends /v1beta/ automatically
```

## API

The daemon exposes a simple REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/agents` | Start a new agent |
| `GET` | `/agents` | List all agents |
| `GET` | `/agents/:name` | Get agent status |
| `POST` | `/agents/:name/ask` | Send prompt, wait for response |
| `POST` | `/agents/:name/ask?stream=true` | SSE stream chunks and final result |
| `POST` | `/agents/:name/approve` | Approve the next pending permission request |
| `POST` | `/agents/:name/deny` | Deny the next pending permission request |
| `POST` | `/agents/:name/cancel` | Cancel current session work (`session/cancel`) |
| `DELETE` | `/agents/:name` | Stop an agent |

## Roadmap

- [x] Phase 1: Daemon + CLI + OpenCode support
- [x] Phase 2: Codex CLI support (codex-acp 0.101.0), Claude CLI support (claude-agent-acp), Gemini CLI support (native ACP), permission approve/deny, task cancel
- [ ] Phase 3: Parallel multi-agent tasks, task dependency chains, result caching
- [ ] Phase 4: OpenClaw skill integration, npm publish

## Related

- [ACP Protocol](https://agentclientprotocol.com) — The standard this project builds on
- [agent-team](https://github.com/nekocode/agent-team) — Multi-agent CLI orchestrator (standalone)
- [codex-acp](https://github.com/cola-io/codex-acp) — Codex CLI ACP adapter (Rust)
- [claude-agent-acp](https://www.npmjs.com/package/@zed-industries/claude-agent-acp) — Claude CLI ACP adapter by Zed Industries

## License

MIT
