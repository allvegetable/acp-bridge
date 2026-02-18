# Diagnostics & Preflight Check Task

## Context
ACP Bridge manages coding agents (opencode, codex, claude, gemini) via ACP protocol over stdio. Users frequently encounter configuration issues: wrong API keys, broken proxy URLs, missing binaries, protocol mismatches. Current error reporting is poor — errors get swallowed as `[object Object]` or generic `exit code=1`.

## Requirements

### 1. Agent stderr capture
- Buffer the last 50 lines of each agent child process's stderr in AgentRecord (add `stderrBuffer: string[]` field)
- Append stderr lines as they arrive (cap at 50, drop oldest)
- Expose in `GET /agents/:name` response as `recentStderr: string[]`
- Expose in `toStatus()` serialization

### 2. Preflight checks on agent start
Before spawning the agent process in `startAgent()`, run type-specific preflight checks. If any check fails, throw a descriptive HttpError(400) with the exact problem.

Checks per agent type:
- **All types**: verify the command binary exists on PATH (use `which` or check with `execSync`)
- **codex**: check `OPENAI_API_KEY` env var is set and non-empty
- **claude**: check `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set
- **gemini**: check `GEMINI_API_KEY` is set
- **All types with known base URLs**: HTTP HEAD request to the base URL with 5s timeout, report if unreachable

The preflight function signature:
```typescript
async function preflightCheck(type: string, env: Record<string, string | undefined>): Promise<void>
```
It should throw HttpError with a clear message like:
- `"ANTHROPIC_API_KEY is not set. Set it in environment or config."`
- `"codex-acp binary not found on PATH. Install with: cargo install codex-acp"`
- `"Proxy https://example.com is unreachable (ECONNREFUSED). Check the URL."`

### 3. Error classification in askAgent
When askAgent catches an error from the ACP connection, classify it:
- Parse known HTTP status codes from error messages (401, 403, 429, 503)
- Map to user-friendly messages with fix suggestions:
  - 401/403 → "API key invalid or expired. Check your key."
  - 429 → "Rate limited. Check proxy quota."  
  - 503 → "Service unavailable. Check proxy status."
  - ECONNREFUSED → "Connection refused. Check base URL."
  - ENOTFOUND → "DNS resolution failed. Check network."
- Store the classified error in `record.lastError` (not raw object)

### 4. `/agents/:name/diagnose` endpoint
New GET endpoint that returns a diagnostic report:
```json
{
  "agent": "claude-1",
  "processAlive": true,
  "state": "idle",
  "recentStderr": ["...last few lines..."],
  "lastError": "...",
  "checks": {
    "apiKeySet": true,
    "apiKeyFormat": "valid",
    "endpointReachable": true,
    "endpointLatencyMs": 120,
    "protocolVersion": 1
  }
}
```
For endpoint reachability, do an HTTP HEAD to the relevant base URL with 5s timeout.
For API key format: check prefix patterns (sk- for OpenAI, cr_ or sk-ant- for Anthropic, AIza for native Gemini).

### 5. CLI `doctor` command
New CLI command that checks ALL configured agent types:
```
node dist/cli.js doctor
```
It calls `GET /doctor` on the daemon, which runs preflight checks for all known agent types (codex, claude, gemini, opencode) using current environment.

Response format:
```json
{
  "results": [
    { "type": "codex", "status": "ok", "binary": true, "apiKey": true, "endpoint": true },
    { "type": "claude", "status": "error", "binary": true, "apiKey": false, "endpoint": null, "message": "ANTHROPIC_API_KEY is not set" },
    { "type": "gemini", "status": "warning", "binary": true, "apiKey": true, "endpoint": false, "message": "Endpoint returned 503" }
  ]
}
```

### 6. CLI `doctor` pretty output
The CLI should format the doctor output nicely:
```
✅ codex: binary found, API key set, endpoint reachable
❌ claude: ANTHROPIC_API_KEY not set
⚠️  gemini: endpoint returned 503 (service unavailable)
✅ opencode: binary found
```

## Implementation Notes
- All changes in `src/daemon.ts` and `src/cli.ts` only. Do NOT create new files.
- Use `node:child_process` execSync for binary checks (wrap in try/catch)
- Use `node:http` or `node:https` for endpoint reachability checks (not fetch, to avoid Node version issues)
- Run `npx tsc --noEmit` after implementation to verify zero compile errors
- Keep existing code style
