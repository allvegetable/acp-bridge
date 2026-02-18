# README Update Task

## Context
ACP Bridge README needs to be updated to document all features from Phase 1-4. The current README is missing:
- Task system (Phase 3): POST /tasks, dependency chains, task CLI commands
- Diagnostics (Phase 4): doctor command, diagnose endpoint, preflight checks, error classification
- Troubleshooting section
- Updated API table
- Installation via npm

## Requirements

Update README.md with the following sections (keep existing content where still accurate, replace outdated parts):

### 1. Update the header/description
- Version: 0.3.0
- Mention all 4 agent types and the diagnostics system

### 2. Update Quick Start
- Add `npm install -g acp-bridge` as primary install method
- Show `acp-bridge` and `acp-bridged` as global commands
- Keep git clone as alternative

### 3. Add Task System section (after API section)
Document the multi-agent task system:
- Creating parallel tasks with subtasks
- Dependency chains with `dependsOn` and `{{dep.result}}` templates
- Task lifecycle (running → done/error/cancelled)
- CLI examples: `acp-bridge task create '{"name":"...","subtasks":[...]}'`
- `acp-bridge task status <id>`, `acp-bridge task list`, `acp-bridge task cancel <id>`

### 4. Add Diagnostics section
- `acp-bridge doctor` — check all agent types
- `GET /agents/:name/diagnose` — deep health check for running agent
- Preflight checks on agent start
- Error classification (what each error code means)

### 5. Update API table
Add ALL endpoints including new ones:
- GET /doctor
- GET /agents/:name/diagnose
- POST /tasks
- GET /tasks
- GET /tasks/:id
- GET /tasks/:id/subtasks/:subtaskId
- DELETE /tasks/:id

### 6. Add Troubleshooting section
Common issues and solutions:
- "API key invalid or expired" → check key, check if proxy key format matches
- "Service unavailable (503)" → proxy has no available channels
- "Connection refused" → wrong base URL
- "binary not found" → install the agent CLI
- "Model stream ended without finish reason" → proxy issue, not local config
- "protocol mismatch" → version incompatibility
- How to use `doctor` and `diagnose` to debug

### 7. Update Roadmap
- Phase 1-3: checked
- Phase 4: checked (npm publish, docs)
- Future: OpenClaw skill, Web UI

### 8. Add Installation section
```bash
# Global install (recommended)
npm install -g acp-bridge

# Or clone and build
git clone https://github.com/allvegetable/acp-bridge.git
cd acp-bridge
npm install && npm run build
```

## Rules
- Only modify README.md
- Keep the existing adapter details section (it's good)
- Use clean markdown, no excessive formatting
- Keep examples practical and copy-pasteable
- Run NO commands, just write the file
