# agent-team

多 Agent CLI 编排器。通过 ACP 协议统一管理 Claude Code、Gemini CLI、Copilot CLI 等 Coding Agent。

```
agent-team = N × 独立 session 进程 + CLI 客户端
```

本身不是 Agent，是**多 ACP Client 管理器**。

---

## 目录结构

```
agent-team/
├── Cargo.toml
├── ARCHITECTURE.md              # 本文档
├── CLAUDE.md                    # 编码规范
├── src/
│   ├── main.rs                  # 入口：tracing + clap → 分发
│   ├── lib.rs                   # pub mod 导出（供集成测试 import）
│   ├── bin/
│   │   └── mock_agent.rs        # 测试用 ACP echo agent（Agent trait 实现）
│   ├── cli/
│   │   ├── mod.rs               # parse() + run()，session UDS 通信
│   │   ├── commands.rs          # clap derive 命令定义
│   │   ├── display.rs           # 终端输出格式化（纯文本对齐）
│   │   └── update.rs            # 自更新：npm view 查版本 + npm install -g
│   ├── session/
│   │   ├── mod.rs               # pub mod
│   │   ├── server.rs            # session 主循环：UDS listener + 请求分发 + stdout 输出
│   │   ├── server_tests.rs      # server 单元测试（handle_request 分发 + 辅助函数）
│   │   └── agent.rs             # AgentHandle + AgentStatus + OutputRingBuffer + spawn_agent
│   ├── acp_client/
│   │   ├── mod.rs               # pub mod
│   │   └── team_client.rs       # ACP Client trait 实现（回调处理 + output 桥接）
│   ├── protocol/
│   │   ├── mod.rs               # pub mod
│   │   ├── messages.rs          # SessionRequest / SessionResponse + OutputType
│   │   └── transport.rs         # JsonLineReader / JsonLineWriter
│   └── config/
│       ├── mod.rs               # pub use 重导出
│       └── defaults.rs          # TeamConfig + session socket 辅助
├── npm/                         # npm 分发（Node.js wrapper + 平台二进制）
│   ├── agent-team/              # 主包：平台检测 + 二进制执行器
│   │   ├── package.json         # bin: agent-team → bin/agent-team.js
│   │   ├── bin/agent-team.js    # 运行时 require.resolve 定位平台二进制
│   │   └── install.js           # postinstall: 验证平台包存在
│   ├── agent-team-darwin-arm64/ # macOS ARM64 预编译二进制
│   ├── agent-team-darwin-x64/   # macOS x64 预编译二进制
│   ├── agent-team-linux-x64/    # Linux x64 预编译二进制
│   └── agent-team-win32-x64/   # Windows x64 预编译二进制
├── scripts/
│   ├── build-npm.sh             # cargo build + 复制二进制到平台包
│   └── publish-npm.sh           # 版本同步 + 按序发布全部 npm 包
└── tests/
    └── integration.rs           # 6 个集成测试（独立 session + mock agent）
```

---

## 进程模型

```
终端 A                  终端 B                  终端 C (CLI)
┌──────────────┐  ┌──────────────┐
│ add gemini   │  │ add claude   │       agent-team ls
│              │  │              │       agent-team ask gemini-1 "..."
│ session 进程  │  │ session 进程  │       agent-team log claude-1
│ (LocalSet)   │  │ (LocalSet)   │
│              │  │              │
│ AgentHandle  │  │ AgentHandle  │
│ ├─ acp_conn  │  │ ├─ acp_conn  │
│ ├─ child     │  │ ├─ child     │
│ └─ buffer    │  │ └─ buffer    │
│              │  │              │
│ ┌──────────┐ │  │ ┌──────────┐ │
│ │ gemini   │ │  │ │ claude   │ │
│ │ 子进程    │ │  │ │ 子进程    │ │
│ └──────────┘ │  │ └──────────┘ │
│              │  │              │
│ UDS: gemini- │  │ UDS: claude- │
│ 1.sock       │  │ 1.sock       │
└──────┬───────┘  └──────┬───────┘
       │                 │
       └────── /tmp/agent-team-{uid}/ ──────┘
```

每个 `add` = 一个进程 = 一个 agent = 一个 UDS socket。CLI 通过 socket 目录发现并操作各 session。

---

## 核心架构决策

### 1. 独立 session 模型

每个 agent 独立运行在自己的进程中，互不干扰：
- `add` 启动 session 进程，stdout 实时输出所有事件
- `add -b` 后台启动：re-exec 自身 → stdout 重定向日志文件 → 等 socket → 返回
- 进程维护单个 AgentHandle（Rc<RefCell<>>）
- Ctrl+C / SIGTERM 优雅退出

### 2. LocalSet + spawn_local

ACP SDK 的 `Client` trait 是 `?Send`，`io_task` 的 Future 是 `!Send`。session 跑在 `tokio::task::LocalSet` 上，所有 ACP 任务用 `spawn_local`。因此 handle 用 `Rc<RefCell<>>` 而非 `Arc<Mutex<>>`。

### 3. Arc<Mutex<>> 跨 callback 共享

`TeamClient`（ACP 回调）和 `AgentHandle` 需要共享三块状态：
- `status: Arc<Mutex<AgentStatus>>`
- `output_buffer: Arc<Mutex<OutputRingBuffer>>`
- `pending_permissions: Arc<Mutex<VecDeque<PendingPermission>>>`

`TeamClient` 在 ACP callback 中异步写入，`AgentHandle` 在请求处理时读取。

### 4. Rc 共享连接

`RefCell` 的 borrow 不能跨 await。`acp_conn` 用 `Rc<ClientSideConnection>` 共享：clone Rc 后 drop borrow，await 完不需放回。cancel 和 prompt 可并发访问同一连接（cancel 是 notification，不阻塞 prompt）。Shutdown / Restart 用 `take()` 销毁旧连接。

### 5. 事件桥接

```
TeamClient 回调 ── mpsc<OutputEntry> ──► bridge task ──► mpsc<Event> ──► stdout printer
                                                              ▲
session lifecycle ── Event::Info("idle") ─────────────────────┘
```

两种事件源汇聚到统一的 Event 流，stdout 打印器处理流式输出（AgentMessage 拼接）和结构化信息。

### 6. 零额外能力

不向 Agent 提供 fs / terminal 等 ACP host capability。Agent（如 Claude Code CLI、Gemini CLI）自带完整的文件操作和命令执行能力，无需 host 代理。只实现核心回调：`session_notification` + `request_permission`。

### 7. 优雅关闭

```
Ctrl+C / SIGTERM / Shutdown 请求
  → cancel ACP session
  → SIGTERM 子进程
  → wait(3s timeout)
  → 超时 SIGKILL
  → 清理 socket 文件
```

---

## 数据流

### 启动 Session

```
agent-team add gemini
  1. bind UDS listener（socket 文件立即可见）
  2. 查 AgentTypeConfig（命令 + 默认参数）
  3. spawn 子进程（stdin/stdout piped）
  4. 创建 TeamClient（共享 status/buffer/permissions + output_tx）
  5. ClientSideConnection::new(client, stdin, stdout, spawn_local)
  6. ACP initialize → new_session
  7. 保存 agent_info（名称 + 版本）
  8. 进入主循环：accept 连接 / 信号退出
```

### 发送 Prompt（fire-and-forget + 轮询）

```
CLI ── SessionRequest::Prompt ──► session (via UDS)
  1. 前置检查（running? conn? session?）
  2. UserPrompt 写入 buffer + 事件流
  3. spawn_local(do_prompt) ── 后台执行
  4. 立即返回 Ok
  5. CLI 轮询 GetStatus 等待 idle / error / waiting_permission
  6. GetOutput(last=1) 取回最后一条消息（agent 回复 / 权限请求）

do_prompt 内部:
  a. clone Rc<acp_conn> → conn.prompt(req).await
  b. TeamClient 回调 → output_buffer + stdout
  c. PromptResponse → 写入 buffer，状态 → Idle
```

### Session 发现

```
agent-team ls
  1. scan /tmp/agent-team-{uid}/*.sock
  2. 逐个 connect → GetStatus
  3. 连不上的 → 清理残留 socket
```

### 权限处理

```
Agent 请求权限 → TeamClient.request_permission()
  auto-approve? → 直接返回 Selected
  否则 → oneshot channel 挂起，状态 → WaitingPermission
  等待 CLI 发 Approve/Deny → channel 解除阻塞
```

---

## 模块依赖

```
main.rs ──► cli ──► protocol, config, session::server
             │
             └──► session::server ──► session::agent
                       │                    │
                       └──► acp_client ◄────┘
                              │
                              ├──► protocol::messages（OutputEntry / OutputType）
                              └──► config（AutoApprovePolicy）
```

- **cli** 是客户端层：`add` 直接调 session::server::run，其余命令通过 UDS 通信
- **session** 持有所有业务逻辑（单 agent 生命周期管理）
- **acp_client** 实现 ACP Client trait 核心回调（通知 + 权限）
- **protocol** 定义双向消息格式 + 传输层
- **config** 零依赖，纯数据 + socket 辅助

---

## 命令一览

| 命令 | 行为 | 说明 |
|------|------|------|
| `add <type>` | 启动 session 进程 | 阻塞，stdout 输出，Ctrl+C 退出。`-b` 后台运行 |
| `rm <name>` | Shutdown → 目标 socket | 关闭指定 agent，`--all` 关闭全部 |
| `ls` | 扫描 socket 目录 | 逐个 GetStatus，清理残留 |
| `ask <name> [text]` | Prompt → 轮询等待 | 轮询 GetStatus + GetOutput(last=1)。省略 text 从 stdin 读取。`-f` 附加文件 |
| `log <name>` | GetOutput → 目标 socket | `-n N` 最后 N 条消息，`-a` 仅 agent 输出 |
| `cancel <name>` | Cancel | 取消当前任务 |
| `allow/deny <name>` | 权限审批 | |
| `info <name>` | GetStatus | 详细信息（含 agent_info） |
| `restart <name>` | Restart | 保留配置重启 |
| `mode <name> <mode>` | SetMode | 切换 agent 模式（ask/code/architect） |
| `set <name> <key> <value>` | SetConfig | 运行时调参 |
| `update` | 自更新 | npm view 查版本 + npm install -g 升级 |

---

## ACP 协议覆盖

### Client → Agent（我们调用）

| 方法 | 状态 |
|------|------|
| `initialize()` | ✅ |
| `new_session()` | ✅ |
| `prompt()` | ✅ |
| `cancel()` | ✅ |
| `set_session_mode()` | ✅ mode 子命令 |
| `set_session_config_option()` | ✅ config 子命令 |

### Agent → Client（回调）

| 回调 | 状态 |
|------|------|
| `session_notification()` | ✅ 7/9 种 SessionUpdate |
| `request_permission()` | ✅ auto-approve + oneshot |

---

## 内置 Agent 类型（20 种）

三种 ACP 启动范式：

### --acp / --experimental-acp flag

| 类型 | 命令 | Flag |
|------|------|------|
| copilot | `copilot` | `--acp` |
| auggie | `auggie` | `--acp` |
| cline | `cline` | `--acp` |
| qoder | `qodercli` | `--acp` |
| qwen | `qwen` | `--acp` |
| gemini | `gemini` | `--experimental-acp` |
| blackbox | `blackbox` | `--experimental-acp` |

### acp 子命令

| 类型 | 命令 |
|------|------|
| goose | `goose acp` |
| kiro | `kiro-cli acp` |
| openhands | `openhands acp` |
| opencode | `opencode acp` |
| kimi | `kimi acp` |
| cagent | `cagent acp` |
| stakpak | `stakpak acp` |
| vtcode | `vtcode acp` |

### 独立 ACP 二进制 / 适配器

| 类型 | 命令 | 说明 |
|------|------|------|
| vibe | `vibe-acp` | Mistral Vibe 独立二进制 |
| fast-agent | `fast-agent-acp` | 独立二进制 |
| claude | `claude-code-acp` | 适配器（需 `npm i -g @zed-industries/claude-code-acp`） |
| codex | `codex-acp` | 适配器（需 `npm i -g @zed-industries/codex-acp`） |
| pi | `pi-acp` | 适配器（需 `npm i -g pi-acp`） |

适配器检测：`add` 时若命令不在 PATH，打印安装提示并退出。

---

## 测试

- **78 单元测试**：messages 序列化 + label、transport 收发、ring buffer、agent handle + status + summary、server 请求分发（10+ 路径）+ 辅助函数、display 格式化、team_client helpers（permission_response + fmt_tool_info + extract_text + write_output）、config socket 辅助 + agent 类型注册 + adapter hint、update 版本比较
- **6 集成测试**：独立 session + mock agent，覆盖 status、prompt/output（含 last + agent_only）、cancel、restart、graceful shutdown、output last round
- **覆盖率**：64.74%（617/953 行）
