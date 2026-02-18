# Phase 3 Task: Advanced Features for ACP Bridge

## Context
ACP Bridge is a daemon + CLI that manages coding agents (OpenCode, Codex, Claude, Gemini) via the Agent Client Protocol (ACP). The daemon runs on port 7800 and exposes a REST API. Source is in `src/daemon.ts` (~780 lines) and `src/cli.ts`.

Current capabilities:
- Start/stop agents by type (opencode, codex, claude, gemini)
- Send prompts and get responses (ask)
- SSE streaming
- Permission approve/deny/cancel
- Agent status monitoring

## Phase 3 Requirements

### 1. Parallel Multi-Agent Task Scheduling
Add a `/tasks` endpoint that accepts a task with multiple sub-tasks, each assigned to a different agent. Sub-tasks run in parallel.

```
POST /tasks
{
  "name": "refactor-project",
  "subtasks": [
    { "agent": "claude-1", "prompt": "Review auth module for security issues" },
    { "agent": "gemini-1", "prompt": "Review database queries for performance" },
    { "agent": "codex-1", "prompt": "Check test coverage gaps" }
  ]
}
```

Response: task ID + status. Each subtask runs on its assigned agent concurrently.

```
GET /tasks/:id  — get task status with all subtask results
GET /tasks      — list all tasks
DELETE /tasks/:id — cancel a task
```

### 2. Task Dependency Chains
Support `dependsOn` field in subtasks. A subtask only starts after its dependencies complete. The result of a dependency is injected into the prompt via `{{dep.result}}` template.

```json
{
  "name": "review-then-fix",
  "subtasks": [
    { "id": "review", "agent": "claude-1", "prompt": "Review this code for bugs" },
    { "id": "fix", "agent": "codex-1", "prompt": "Fix these bugs: {{review.result}}", "dependsOn": ["review"] }
  ]
}
```

### 3. Result Caching & History
- Store completed task results in memory (Map)
- `GET /tasks/:id` returns cached results even after agents are stopped
- Add `GET /tasks/:id/subtasks/:subtaskId` for individual subtask results
- Tasks persist in memory for the lifetime of the daemon process

## Implementation Notes
- Add all new code in `src/daemon.ts` — keep it in one file
- Use TypeScript, match existing code style
- Tasks are identified by auto-generated UUIDs
- Subtask states: `pending` | `running` | `done` | `error` | `cancelled`
- Task states: `running` | `done` | `error` | `cancelled`
- A task is `done` when all subtasks are `done`
- A task is `error` if any subtask errors (but other subtasks continue)
- `DELETE /tasks/:id` cancels all pending/running subtasks
- Add corresponding CLI commands: `task create`, `task status`, `task list`, `task cancel`
- Update CLI in `src/cli.ts` to support the new task commands

## Testing
After implementation, verify:
1. `npx tsc --noEmit` passes with zero errors
2. Code is clean and follows existing patterns
