# ACP Bridge

A daemon + CLI tool that manages coding agents (like [OpenCode](https://opencode.ai), Codex CLI, Claude CLI) through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — replacing fragile tmux screen-scraping with structured JSON-RPC communication.

> ⚠️ **Early stage** — This project is under active development. APIs may change.

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
    }
  }
}
```

Environment variables like `ACP_BRIDGE_PORT` and `ACP_BRIDGE_HOST` still override config file values.

## Supported Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [OpenCode](https://opencode.ai) | ✅ Working | Native ACP support via `opencode acp` |
| [Codex CLI](https://github.com/openai/codex) | 🔜 Planned | Needs [codex-acp](https://github.com/cola-io/codex-acp) adapter |
| [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) | 🔜 Planned | Needs Zed SDK adapter |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 🔜 Planned | Native ACP support |

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
| `DELETE` | `/agents/:name` | Stop an agent |

## Roadmap

- [x] Phase 1: Daemon + CLI + OpenCode support
- [ ] Phase 2: Codex CLI + Claude CLI support, permission approval flow
- [ ] Phase 3: Async tasks, parallel agents, task dependencies
- [ ] Phase 4: OpenClaw skill integration, npm publish

## Related

- [ACP Protocol](https://agentclientprotocol.com) — The standard this project builds on
- [agent-team](https://github.com/nekocode/agent-team) — Multi-agent CLI orchestrator (standalone)
- [codex-acp](https://github.com/cola-io/codex-acp) — Codex CLI ACP adapter

## License

MIT
