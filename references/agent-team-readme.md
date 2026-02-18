# agent-team

A multi-agent CLI orchestrator via the [ACP](https://agentclientprotocol.com/get-started/introduction) (Agent Client Protocol). Manage 20+ coding agents from one terminal.

[中文文档](README.zh-CN.md)

![Cover](cover.jpg)

## Why

Every coding agent has its own CLI, its own workflow, its own way of doing things. agent-team gives them a single control plane:

- **One interface for all agents**: Prompt, cancel, approve permissions, configure — the same commands work across 20+ agents
- **Independent sessions**: Each agent runs in its own process with its own UDS socket. No shared state, no interference
- **Any terminal, any agent**: Send prompts, review permissions, read logs — all from wherever you are

## Install

```bash
npm install -g agent-team
```

Update to the latest version:

```bash
agent-team update
```

## Quick Start

```bash
# Start a Gemini agent (foreground, Ctrl+C to exit)
agent-team add gemini

# Start a Claude agent in the background
agent-team add claude -b

# List running agents
agent-team ls

# Send a prompt
agent-team ask gemini-1 "Refactor the auth module"

# Read the conversation
agent-team log gemini-1
```

## Supported Agents

All agents listed on [agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents):

`gemini` `copilot` `goose` `claude`\* `codex`\* `auggie` `kiro` `cline` `blackbox` `openhands` `qoder` `opencode` `kimi` `vibe` `qwen` `cagent` `fast-agent` `stakpak` `vtcode` `pi`\*

\* Requires a separate adapter binary. agent-team will prompt you with install instructions if not found in PATH.

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `add <type>` | Start agent session (foreground). `-b` for background |
| `rm <name>` | Shut down agent. `--all` for all agents |
| `ls` | List running agents |
| `restart <name>` | Restart agent (preserves config) |
| `info <name>` | Show agent details |

### Interaction

| Command | Description |
|---------|-------------|
| `ask <name> [text]` | Send prompt and wait for response. `-f` to attach files |
| `log <name>` | Read conversation. `-n N` for last N messages, `-a` for agent-only |
| `cancel <name>` | Cancel current task |
| `allow/deny <name>` | Approve or reject permission request |

### Configuration

| Command | Description |
|---------|-------------|
| `mode <name> <mode>` | Switch agent mode (ask/code/architect) |
| `set <name> <key> <val>` | Change runtime config |
| `update` | Self-update via npm |

## Usage with AI Agents

### Just ask the agent

The simplest approach - just tell your agent to use it:

```
Use agent-team to manage coding agents. Run agent-team --help for usage.
```

The `--help` output is comprehensive and most agents can figure it out from there.

### AGENTS.md / CLAUDE.md

For more consistent results, add to your project instructions:

````markdown
## Multi-Agent Orchestration

Use `agent-team` to spin up and coordinate coding agents. Run `agent-team --help` for all options.

Usage:
- `agent-team add gemini -b` - Start a Gemini agent in background
- `agent-team ls` - List running agents
- `agent-team ask <name> "task"` - Send a prompt and wait for response
- `agent-team log <name> -a -n 1` - Read last agent response
- `agent-team cancel <name>` - Cancel current task
- `agent-team allow/deny <name>` - Approve or reject permission request
- `agent-team rm <name>` - Shut down agent

Typical workflow:
1. Start agents: `agent-team add gemini -b && agent-team add copilot -b`
2. Assign tasks: `agent-team ask gemini-1 "Refactor auth module"`
3. Check progress: `agent-team log gemini-1`
4. Clean up: `agent-team rm --all`
````

## License

MIT
