# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-02-18

### Added
- **Gemini CLI support** — native ACP via `gemini --experimental-acp`
- **Claude CLI support** — via `claude-agent-acp` adapter (Zed Industries)
- **Multi-agent task system** — parallel subtasks, dependency chains with `{{dep.result}}` templates
- **Diagnostics system** — `doctor` command, `/agents/:name/diagnose` endpoint, preflight checks
- **Error classification** — 401/403/429/500/502/503/504/ECONNREFUSED/ENOTFOUND mapped to user-friendly messages
- **Agent stderr capture** — last 50 lines buffered and exposed via API
- **TTL-based task cleanup** — configurable via `ACP_BRIDGE_MAX_TASKS` and `ACP_BRIDGE_TASK_TTL_MS`
- **CLI task commands** — `task create`, `task status`, `task list`, `task cancel`
- Published to npm as `acp-bridge`

### Changed
- Dependency waiting changed from polling to event-driven (Promise.race)
- Task state only finalizes when all subtasks are terminal
- Agent cancel is now scoped to active task ownership (no cross-task interference)
- Protocol version check accepts both string and numeric formats

## [0.2.0] - 2026-02-18

### Added
- **Codex CLI support** — via `codex-acp` adapter (pinned to 0.101.0)
- Permission approve/deny/cancel endpoints
- SSE streaming for ask responses
- Config file support (`~/.config/acp-bridge/config.json`)

## [0.1.0] - 2026-02-17

### Added
- Initial daemon + CLI
- OpenCode native ACP support
- Agent lifecycle management (start/stop/status/list)
- HTTP REST API on port 7800
