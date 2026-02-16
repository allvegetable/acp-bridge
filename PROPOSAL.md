# ACP Bridge — OpenClaw 多 Agent 协调工具

## 一句话

一个 OpenClaw skill，通过 ACP（Agent Client Protocol）协议与 codex cli、claude cli、opencode 等编程 agent 结构化通信，彻底替代 tmux 刮屏方案。

---

## 问题

现在 OpenClaw 协调多个编程 agent 的方式是 tmux：

```
OpenClaw → tmux send-keys → CLI agent
OpenClaw ← tmux capture-pane ← CLI agent（轮询）
```

痛点：
- 每次交互浪费 2000-4000 token，其中 60-70% 是轮询垃圾
- capture-pane 抓到渲染残留、进度条碎片、ANSI 转义码
- 无法可靠判断 agent 状态（idle/working/waiting_confirm）
- context 膨胀导致后续每轮对话成本滚雪球
- 需要手动批准确认（send-keys Enter），时机不好会出错

## 方案

用 ACP 协议替代 tmux 通信层：

```
OpenClaw → ACP Bridge skill → Unix socket (JSON-RPC/stdio) → CLI agent
OpenClaw ← ACP Bridge skill ← Unix socket (JSON-RPC/stdio) ← CLI agent
```

### ACP 协议简介

ACP（Agent Client Protocol）是 Zed 主导的开放标准，定义了编辑器/调度器与编程 agent 之间的通信协议：
- 传输层：JSON-RPC over stdio（本地）或 HTTP/WebSocket（远程）
- 核心操作：`initialize` → `session/new` → `session/prompt` → `session/update`（流式）
- 支持：会话管理、模式切换、权限审批、取消任务、文件操作
- 已被 20+ 主流 CLI 支持或接入中

### 架构

```
┌─────────────────────────────────────────────────┐
│                   OpenClaw                       │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │          ACP Bridge Skill                 │   │
│  │                                           │   │
│  │  - agent_start(type, config)              │   │
│  │  - agent_ask(name, prompt) → response     │   │
│  │  - agent_status(name) → state             │   │
│  │  - agent_approve/deny(name)               │   │
│  │  - agent_cancel(name)                     │   │
│  │  - agent_stop(name)                       │   │
│  │  - agent_list() → [agents]                │   │
│  └──────────┬───────────────────────────────┘   │
│             │                                    │
│             ▼                                    │
│  ┌──────────────────────────────────────────┐   │
│  │        ACP Bridge Daemon                  │   │
│  │                                           │   │
│  │  - 管理 agent 子进程生命周期              │   │
│  │  - JSON-RPC over stdio 通信               │   │
│  │  - 事件缓冲与状态追踪                    │   │
│  │  - 权限请求队列                           │   │
│  │  - HTTP API 供 skill 调用                 │   │
│  └──────────┬───────────────────────────────┘   │
│             │ stdio (JSON-RPC)                   │
│             ▼                                    │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐          │
│  │ codex   │ │ claude  │ │ opencode │  ...      │
│  │ (ACP)   │ │ (ACP)   │ │ (ACP)    │          │
│  └─────────┘ └─────────┘ └──────────┘          │
└─────────────────────────────────────────────────┘
```

### 组件

#### 1. ACP Bridge Daemon（核心）

一个常驻后台进程（Node.js/TypeScript），职责：

- **进程管理**：启动/停止 agent 子进程，通过 stdio 管道连接
- **ACP 协议处理**：发送 JSON-RPC 请求，接收流式 `session/update` 事件
- **状态追踪**：维护每个 agent 的状态（idle/working/waiting_approval/error）
- **事件缓冲**：收集 agent 的流式输出，组装成完整响应
- **权限队列**：agent 请求文件写入/命令执行时，缓存待审批
- **HTTP API**：暴露 REST 接口供 OpenClaw skill 调用

```
POST /agents              → 启动 agent
GET  /agents              → 列出所有 agent
GET  /agents/:name        → 获取 agent 状态
POST /agents/:name/ask    → 发送 prompt，等待完整响应
POST /agents/:name/approve → 批准权限请求
POST /agents/:name/deny   → 拒绝权限请求
POST /agents/:name/cancel → 取消当前任务
DELETE /agents/:name      → 停止 agent
```

#### 2. OpenClaw Skill（调用层）

一个 OpenClaw skill，封装 daemon 的 HTTP API 为 shell 命令：

```bash
# 启动 agent
acp-bridge start codex --name bs-imago --model gpt-5.3-codex-high --cwd ~/project

# 发任务（阻塞等待完成，返回结构化结果）
acp-bridge ask bs-imago "审查 src/pipeline.py 的线程安全问题"

# 查看状态
acp-bridge status bs-imago
# → { "state": "working", "progress": "Reading files...", "elapsed_s": 12 }

# 批准权限
acp-bridge approve bs-imago

# 列出所有 agent
acp-bridge list
```

OpenClaw 通过 exec 调用这些命令，返回的是干净的结构化文本，不是 tmux 屏幕刮取。

#### 3. Agent Adapters

不同 CLI 的 ACP 接入方式：

| CLI | ACP 接入方式 | 适配器 |
|-----|-------------|--------|
| codex cli | 需要 codex-acp adapter（Rust） | 已有开源实现 `cola-io/codex-acp` |
| claude cli | 需要 Zed SDK adapter | 已有官方支持 |
| opencode | 原生 ACP 支持 | 无需适配器 |
| gemini cli | 原生 ACP 支持 | 无需适配器 |

---

## 对比：tmux vs ACP Bridge

| 维度 | tmux 方案 | ACP Bridge |
|------|----------|------------|
| 发送消息 | paste-buffer + send-keys | JSON-RPC `session/prompt` |
| 接收回复 | capture-pane 轮询 | 流式 `session/update` 事件 |
| 每次交互 token | 2000-4000 | ~300 |
| 节省 | — | 85-90% |
| agent 状态 | 猜（解析屏幕文字） | 精确（idle/working/waiting） |
| 权限审批 | send-keys Enter（盲操作） | approve/deny API |
| 输出质量 | ANSI 残留、截断、乱码 | 干净的结构化文本 |
| 多 agent | 多个 tmux session | 统一管理，独立进程 |
| 可靠性 | 脆弱（依赖渲染格式） | 稳定（标准协议） |

---

## 竞品分析

| 项目 | Stars | 定位 | 与我们的差异 |
|------|-------|------|-------------|
| agent-team | 8⭐ | 独立 CLI 调度器 | 不集成 OpenClaw，无 skill 封装 |
| agentpipe | 74⭐ | agent 间对话 | exec 模式调用，非持久连接 |
| agent-council | 97⭐ | 投票表决 | 只做意见收集，不做持久协作 |
| claude-tmux-orchestration | 6⭐ | tmux 方案 | 跟我们现在一样，有同样的问题 |
| obsidian-agent-client | 715⭐ | Obsidian 插件 | 面向笔记软件，不是 CLI 调度 |
| codex-acp | 114⭐ | codex ACP adapter | 只是适配器，不是调度工具 |

**空白地带**：没有人做 "OpenClaw/上层调度系统 + ACP 协议" 的 bridge。我们填这个空。

---

## 技术选型

- **语言**：TypeScript（OpenClaw 生态一致，npm 分发方便）
- **ACP SDK**：参考 `agentclientprotocol` 官方 TypeScript 库
- **进程管理**：Node.js `child_process.spawn`，stdio 管道
- **HTTP 服务**：轻量 HTTP server（fastify 或原生 http）
- **分发**：npm 包 + OpenClaw skill 安装

---

## 开发计划

### Phase 1：最小可用（1-2 周）
- ACP Bridge Daemon 核心：进程管理 + JSON-RPC stdio 通信
- 支持 opencode（原生 ACP，最简单）
- OpenClaw skill 基础命令：start/ask/status/stop
- 替代一个 tmux agent 验证效果

### Phase 2：主流 CLI 支持（1-2 周）
- 集成 codex-acp adapter（codex cli 支持）
- 集成 claude cli ACP adapter
- 权限审批流程（approve/deny）
- 任务取消（cancel）

### Phase 3：高级功能（2-3 周）
- 多 agent 并行任务调度
- 任务依赖链（A 完成后自动触发 B）
- 结果缓存与历史查询
- Web UI 状态面板（可选）
- gemini cli 支持

### Phase 4：开源发布
- 文档、README、示例
- npm 发布
- OpenClaw skill marketplace（clawhub.com）上架
- GitHub 推广

---

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| ACP 协议还在演进，可能 breaking change | adapter 需要更新 | 抽象协议层，adapter 可独立更新 |
| codex/claude 的 ACP adapter 不成熟 | 功能受限 | Phase 1 先用原生支持的 opencode 验证 |
| agent-team 快速发展抢占市场 | 竞争 | 差异化：OpenClaw 深度集成，不只是 CLI 工具 |
| OpenClaw 用户基数小 | 推广难 | 同时支持独立使用（不依赖 OpenClaw） |

---

## 命名

暂定 `acp-bridge`。备选：
- `agent-bridge`
- `claw-bridge`
- `agent-relay`

---

## 总结

核心价值：用标准协议替代 tmux hack，省 85-90% token，获得可靠的 agent 状态感知和结构化通信。

差异化：唯一一个面向 OpenClaw 生态的 ACP bridge，同时可独立使用。

时机：ACP 生态早期，主流 CLI 刚接入，好工具还没有，现在做正好。
