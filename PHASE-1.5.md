# ACP Bridge Phase 1.5 — 稳定化 + 实用化

## 目标
让 OpenClaw 的 Otacon 能通过 ACP Bridge 给 opencode agent 发任务，完全替代 tmux 刮屏方案。

## 当前状态
- daemon + CLI 基本功能已验证（start/ask/status/list/stop）
- opencode ACP 连接正常，能发 prompt 收回复
- 代码已推到 GitHub: https://github.com/allvegetable/acp-bridge

## 需要修的问题

### 1. 默认端口冲突
- daemon.ts 默认端口 7890 跟 Clash 代理冲突
- cli.ts 的 DEFAULT_BASE_URL 也要同步改
- 改成 7800 或其他不冲突的端口

### 2. PATH 问题
- daemon spawn opencode 时，子进程可能找不到 `~/.opencode/bin/opencode`
- 在 spawn 时把 `~/.opencode/bin` 加到 PATH 环境变量里
- 或者支持在 POST /agents 时传 `command` 字段指定完整路径

### 3. 环境变量传递
- daemon 需要把 OPENAI_API_KEY 和 OPENAI_BASE_URL 传给 opencode 子进程
- 现在用的是 `env: process.env`，daemon 启动时必须设好这些变量
- 加一个配置文件或启动参数来指定 agent 的环境变量

### 4. 错误处理
- daemon 启动失败（端口占用）没有友好提示
- agent spawn 失败（命令不存在）应该返回清晰的错误
- HTTP 请求超时没有处理

## 新增功能

### 5. 流式响应（重要）
- 当前 POST /agents/:name/ask 是阻塞的，长任务会 HTTP 超时
- 改成两种模式：
  - `?stream=false`（默认）：等完成后返回完整响应（短任务用）
  - `?stream=true`：SSE 流式返回，实时推送 agent 的输出
- 或者改成异步：POST 返回 task_id，GET /agents/:name/tasks/:id 轮询结果

### 6. daemon 自动管理
- 加一个 `acp-bridge daemon start` 命令，后台启动 daemon
- `acp-bridge daemon stop` 停止
- `acp-bridge daemon status` 检查是否在运行
- PID 文件写到 /tmp/acp-bridge.pid

### 7. 配置文件
- 支持 `~/.config/acp-bridge/config.json`：
```json
{
  "port": 7800,
  "host": "127.0.0.1",
  "agents": {
    "opencode": {
      "command": "~/.opencode/bin/opencode",
      "args": ["acp"],
      "env": {
        "OPENAI_API_KEY": "...",
        "OPENAI_BASE_URL": "..."
      }
    }
  }
}
```

## 任务拆分（给 BS-Imago）

按优先级排序，每个任务独立可测试：

### Task 1: 修端口 + PATH（5 分钟）
- daemon.ts 默认端口改成 7800
- cli.ts DEFAULT_BASE_URL 改成 http://localhost:7800
- spawn 时在 env.PATH 前面加 `~/.opencode/bin`
- README 同步更新

### Task 2: 错误处理（10 分钟）
- daemon 端口占用时输出友好错误
- agent spawn 失败返回 400 + 错误信息
- ask 超时处理（可配置，默认 5 分钟）

### Task 3: daemon 后台管理（15 分钟）
- 新增 src/daemon-ctl.ts
- 命令：`acp-bridge daemon start/stop/status`
- PID 文件管理
- package.json 加 bin 入口

### Task 4: 配置文件支持（15 分钟）
- 读取 ~/.config/acp-bridge/config.json
- 支持 port/host/agents 配置
- 启动时合并配置文件 + 环境变量 + 命令行参数

### Task 5: 流式响应或异步任务（20 分钟）
- POST /agents/:name/ask 支持 SSE 流式输出
- 或者改成异步 task 模式
- CLI 对应支持 --stream 或 --async 参数

## 完成标准
- `acp-bridge daemon start` 一键启动
- `acp-bridge start opencode --name worker --cwd ~/project` 创建 agent
- `acp-bridge ask worker "写一个 hello world"` 拿到结构化响应
- OpenClaw 的 Otacon 能通过 HTTP API 调用以上功能，不再需要 tmux
