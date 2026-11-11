# 通用机器人命令执行与异步回调接口设计文档

- **日期**：2026-11-11
- **状态**：待评审

## 1. 背景与目标

当前 `gt-hub` 已提供远程命令异步执行接口 `POST /api/terminal/exec/:hostId`，调用后在目标 Agent 节点的 `TaskManager` 中启动后台子进程并返回 `202 Accepted` 及 `taskId`。然而，现有机制仅支持调用方被动轮询 `GET /api/terminal/exec/:hostId/:taskId` 获取执行状态与结果。

在对接自研机器人服务（如飞书/企微/Slack Bot 后端、AI Agent 编排层或自动化工作流）时，调用方希望在发起命令执行请求的同时传入回调信息（Webhook Callback）及业务上下文（Context），当命令在远程节点执行完毕后，由 `gt-hub` 自动通过回调地址推送标准化执行结果，免去外部系统维护轮询状态机的复杂度。

**核心设计决策：**
1. **入口复用与向后兼容**：直接扩展现有的 `POST /api/terminal/exec/:hostId`（以及兼容路径 `/api/admin/terminal/exec/:hostId`），在请求 JSON Body 中新增可选的 `callback` 字段；不传 `callback` 时完全保持现有行为。
2. **事件主动推送（无轮询开销）**：采用 **Agent 任务结束主动推送事件（`cmd_task_finished`）+ Hub 统一投递 Webhook** 的架构，不引入 Hub 侧定时轮询。
3. **生产级回调投递**：支持自定义请求头（`headers`）、HMAC-SHA256 签名（`secret`）、业务上下文原样透传（`context`）、UTF-8 安全的尾部输出截断（`maxOutputBytes`）以及指数退避重试（`maxRetries`）。

---

## 2. 接口协议与数据结构设计

### 2.1 请求接口：`POST /api/terminal/exec/:hostId`

#### 请求体（Request Body）

```json
{
  "command": "sh /opt/scripts/deploy.sh --env prod",
  "cwd": "/opt/scripts",
  "timeoutMs": 300000,
  "env": {
    "DEPLOY_USER": "bot"
  },
  "stdin": "",
  "callback": {
    "url": "https://bot-service.internal/api/v1/webhooks/gt-exec",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer bot-secret-token-xxx"
    },
    "secret": "hmac-signing-secret-optional",
    "timeoutMs": 10000,
    "maxRetries": 3,
    "maxOutputBytes": 65536,
    "context": {
      "botPlatform": "feishu",
      "chatId": "oc_1234567890",
      "replyToMessageId": "om_abcdef123456",
      "requestId": "req-20261111-001"
    }
  }
}
```

#### `callback` 字段规范（`ExecCallbackConfig`）

| 字段 | 类型 | 必填 | 默认值 | 校验规则与说明 |
| :--- | :--- | :---: | :--- | :--- |
| `url` | `string` | **是** | - | 必须为非空字符串且是合法的 `http://` 或 `https://` URL，否则返回 `400 Bad Request` |
| `method` | `'POST' \| 'PUT'` | 否 | `'POST'` | 大小写不敏感归一化为 `'POST'` 或 `'PUT'`，传入其他方法返回 `400 Bad Request` |
| `headers` | `Record<string, string>` | 否 | `{}` | 自定义 HTTP 请求头（键与值均转为字符串）；若非普通对象返回 `400 Bad Request` |
| `secret` | `string` | 否 | `undefined` | 可选 HMAC-SHA256 签名密钥；提供非空字符串时自动生成 `X-GT-Signature-256` 请求头 |
| `timeoutMs` | `number` | 否 | `10000` | 单次 Webhook 请求超时毫秒数，自动钳制在 `[1000, 30000]` 范围内 |
| `maxRetries` | `number` | 否 | `3` | 投递失败时的最大重试次数，自动钳制在 `[0, 5]` 范围内 |
| `maxOutputBytes` | `number` | 否 | `65536` | 回调中 `stdout` / `stderr` / `output` 单字段最大字节数（默认 64KB），钳制在 `[1024, 1048576]`（1KB ~ 1MB）范围内 |
| `context` | `any` | 否 | `null` | 任意 JSON 可序列化的业务上下文数据，回调时原样透传 |

---

### 2.2 同步响应（`202 Accepted`）

当参数校验通过且目标 Agent 成功启动任务后，立即返回 `202 Accepted`：

```json
{
  "success": true,
  "taskId": "task-1762848000000-a1b2c3",
  "hostId": "prod-node-01",
  "status": "running",
  "command": "sh /opt/scripts/deploy.sh --env prod",
  "cwd": "/opt/scripts",
  "startTime": 1762848000000,
  "callbackRegistered": true
}
```

- 当请求未携带 `callback` 时，响应结构与既有行为保持一致（不包含或无需依赖 `callbackRegistered`）。
- 若 `callback` 参数格式非法（返回 `400`）、目标节点离线（返回 `503`）或进程启动当场失败（如 `cwd` 不存在，返回 `400`），则在当前同步 HTTP 响应中直接返回错误，**不注册**异步回调。

---

### 2.3 异步回调通知协议（`Hub -> callback.url`）

#### 回调请求头（HTTP Headers）

```http
POST /api/v1/webhooks/gt-exec HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: gt-hub-webhook/1.0
X-GT-Event: exec.finished
X-GT-Task-Id: task-1762848000000-a1b2c3
X-GT-Timestamp: 1762848012345
X-GT-Delivery-Attempt: 1
X-GT-Signature-256: sha256=<hex_digest>
```

- **自定义请求头合并规则**：先设置用户传入的 `callback.headers`（如 `Authorization`），再写入 `Content-Type`、`User-Agent` 及 `X-GT-*` 系统协议头，确保协议元信息与签名头不被意外覆盖。
- **HMAC 签名计算规则**：当 `callback.secret` 为非空字符串时，以 `${timestamp}.${rawJsonBody}` 作为签名原文，使用 `crypto.createHmac('sha256', secret)` 计算十六进制摘要，设置 `X-GT-Signature-256: sha256=${digest}`。每次重试时会更新 `timestamp`、`X-GT-Timestamp`、`X-GT-Delivery-Attempt` 并重新计算签名。

#### 回调请求体（`ExecCallbackPayload`）

```json
{
  "event": "exec.finished",
  "timestamp": 1762848012345,
  "taskId": "task-1762848000000-a1b2c3",
  "host": {
    "id": "machine-uuid-01",
    "name": "prod-node-01",
    "hostname": "ip-10-0-1-12",
    "ip": "10.0.1.12",
    "platform": "linux"
  },
  "execution": {
    "command": "sh /opt/scripts/deploy.sh --env prod",
    "cwd": "/opt/scripts",
    "status": "completed",
    "success": true,
    "exitCode": 0,
    "startTime": 1762848000000,
    "endTime": 1762848012300,
    "durationMs": 12300,
    "stdout": "Building...\nDeploy succeeded!\n",
    "stderr": "",
    "output": "Building...\nDeploy succeeded!\n",
    "totalBytes": 29,
    "truncated": false
  },
  "context": {
    "botPlatform": "feishu",
    "chatId": "oc_1234567890",
    "replyToMessageId": "om_abcdef123456",
    "requestId": "req-20261111-001"
  }
}
```

#### 字段语义说明

- `execution.status`：
  - `'completed'`：进程正常退出且 `exitCode === 0`（此时 `execution.success` 为 `true`）
  - `'failed'`：进程非零退出码或执行出错（`execution.success` 为 `false`）
  - `'timeout'`：任务超出 `timeoutMs` 被强制终止（`execution.success` 为 `false`）
  - `'killed'`：任务被主动终止（`execution.success` 为 `false`）
- `execution.truncated`：
  - 当 `stdout`、`stderr` 或 `output` 中任一字段的 UTF-8 字节长度超过 `maxOutputBytes` 时，按 UTF-8 字符边界截取保留**尾部最新内容**，并将 `truncated` 标记为 `true`；否则为 `false`。

---

## 3. 内部架构与模块设计

### 3.1 Agent 侧任务完成事件推送

1. **`TaskManager` 完成钩子（`src/agent/tasks/taskManager.ts`）**：
   - 在 `TaskManager` 中维护监听器集合 `finishListeners: Set<(event: TaskFinishedEvent) => void>`，并提供公开方法 `onTaskFinished(listener): () => void`。
   - 为 `TaskRecord` 增加内部布尔标记 `notifiedFinish?: boolean`，确保每个任务在生命周期内最多触发一次完成事件。
   - 在以下终态收敛点统一调用内部方法 `emitTaskFinished(record)`：
     - `child.on('close')` 进程正常/信号/超时退出且流解码刷新完毕后；
     - `child.on('error')` 进程启动/执行异常且无后续 `close` 事件或首次进入终态时；
     - `watchRunningProcess` 跨重启恢复的后台进程结束时。
   - 注意：当外部调用 `killTask(taskId)` 或超时定时器触发时，`killProcessTree` 会使子进程退出并最终触发 `child.on('close')`。在 `close` 回调中已包含完整的最终输出与准确 `endTime`，因此统一在进程退出收敛处触发 `emitTaskFinished`，避免在 `killTask` 调用瞬间过早触发导致丢失最后缓冲输出。

2. **Agent WebSocket 上报通道（`src/agent/daemon.ts` 与 `src/agent/handlers/cmdExecHandler.ts`）**：
   - 在 `src/agent/daemon.ts` 中订阅 `taskManager.onTaskFinished((record) => ...)`：当 `ws` 处于连接打开状态时，发送控制帧：
     ```json
     JSON:{"type":"cmd_task_finished","taskId":"...","command":"...","cwd":"...","status":"...","exitCode":0,"startTime":...,"endTime":...,"durationMs":...,"stdout":"...","stderr":"...","output":"...","totalBytes":...}
     ```
   - 同时在 `handleCmdExec`（`src/agent/handlers/cmdExecHandler.ts`）中：当 `action === 'start'` 启动任务时，若该任务在单元测试或独立模式下未通过 `daemon.ts` 全局监听，可通过在 `taskManager.startTask` 或 `handleCmdExec` 绑定的单任务完成回调将 `cmd_task_finished` 写入触发该任务的 `targetWs`（通过 `taskId` 去重或由 `TaskManager` 关联发起方发送，在 `daemon.ts` 与组件集成测试中均能无缝工作）。
   - **最佳实现方式**：在 `TaskManager.startTask` 中支持可选参数 `onFinish?: (event: TaskFinishedEvent) => void`，并在 `handleCmdExec` 处理 `action === 'start'` 时直接传入 `onFinish` 回调向 `targetWs` 发送 `JSON:{"type":"cmd_task_finished", ...}`；同时保留 `taskManager.onTaskFinished` 供全局监听。这样无论是真实 Daemon 还是集成测试中的 Mock Agent WebSocket，只要走 `handleCmdExec` 启动的任务，完成时都会自动向对应的 `targetWs` 推送 `cmd_task_finished` 控制帧，且不会重复发送。

### 3.2 Hub 侧回调管理与投递服务（`src/terminal/services/terminalExecCallbackService.ts`）

新建独立服务模块 `TerminalExecCallbackService`：

1. **配置校验（`validateCallbackConfig(raw: unknown)`）**：
   - 校验 `url` 是否为合法的 `http:` / `https:` URL（使用 `new URL(url)` 解析校验 protocol）。
   - 校验 `method`（默认 `'POST'`，仅允许 `'POST'` 或 `'PUT'`）。
   - 校验 `headers`（可选 plain object，所有键值转为 string）。
   - 归一化 `timeoutMs`（默认 `10000`，clamp 到 `[1000, 30000]`）、`maxRetries`（默认 `3`，clamp 到 `[0, 5]`）、`maxOutputBytes`（默认 `65536`，clamp 到 `[1024, 1048576]`）。

2. **UTF-8 安全尾部截断（`truncateUtf8Tail(text: string, maxBytes: number)`）**：
   - 若 `Buffer.byteLength(text, 'utf-8') <= maxBytes`，返回 `{ text, truncated: false }`。
   - 若超出 `maxBytes`，取 `buf.subarray(buf.length - maxBytes)`，并复用 `sliceBufferUtf8Safe` 跳过开头的 UTF-8 延续字节（`0b10xxxxxx`），返回 `{ text: sliced, truncated: true }`。

3. **待回调注册表与生命周期（`pendingCallbacks`）**：
   - `registerCallback({ taskId, hostId, command, cwd, startTime, taskTimeoutMs, callback })`：
     - 存入内存 `Map<string, PendingCallbackEntry>`。
     - 设置防泄漏清理定时器（`ttlMs = taskTimeoutMs + 120000`），到期后若仍未收到完成事件则自动移除条目并释放内存。

4. **事件处理与 Webhook 投递（`handleTaskFinished(hostId: string, event: any)`）**：
   - 根据 `event.taskId` 查找并原子删除 `pendingCallbacks` 中的条目（保证幂等，只触发一次）。
   - 清理该条目的 TTL 定时器。
   - 通过 `terminalHostManager.getHost(hostId)` 获取节点元数据（`id`, `name`, `hostname`, `ip`, `platform`），若节点此时刚下线则使用注册时缓存的快照。
   - 组装 `ExecCallbackPayload`，执行 `deliverWithRetry(entry, payload)`。

5. **退避重试投递器（`deliverWithRetry`）**：
   - 默认重试退避序列：`[1000, 5000, 15000, 30000, 60000]` ms（支持在构造函数注入自定义 `retryDelaysMs` 以便单元测试快速验证重试逻辑）。
   - 使用 Node.js 原生 `http` / `https` 模块发起请求：
     - 状态码 `200` ~ `299`：投递成功，记录 `terminalLogService.addLog('info', ...)` 并结束。
     - 状态码 `408`、`429`、`500` ~ `599` 或网络错误/超时：若 `attempt <= maxRetries`，等待对应退避时间后进行下一次重试；超过最大重试次数后记录 `terminalLogService.addLog('error', ...)`。
     - 其他 `4xx` 状态码（如 `400`, `401`, `403`, `404`）：视为客户端配置错误，不进行重试，直接记录 `terminalLogService.addLog('error', ...)` 并结束。

### 3.3 Hub 侧控制器、服务与 WebSocket 路由集成

1. **`src/terminal/controllers/terminalExecController.ts`**：
   - 在 `startExec` 中读取 `req.body.callback`。
   - 若 `callback !== undefined && callback !== null`，调用 `terminalExecCallbackService.validateCallbackConfig(callback)`；若校验失败，立即返回 `400 Bad Request`（`{ success: false, error: validation.error }`）。
   - 将校验后的 `callbackConfig` 传入 `terminalExecService.startExecution(hostId, { ..., callback: validation.config })`。

2. **`src/terminal/services/terminalExecService.ts`**：
   - 在 `startExecution` 中，当 `executeCmdRpc` 启动任务成功后，若传入了 `options.callback`，调用 `terminalExecCallbackService.registerCallback(...)`，并在返回对象中附带 `callbackRegistered: true`。
   - 新增 `handleAgentTaskFinished(hostId: string, payload: any)` 方法：
     - 记录任务完成日志到 `terminalLogService`（与 `getExecutionStatus` 共享 `loggedFinishedTasks` 去重集合，避免重复打印完成日志）。
     - 调用 `terminalExecCallbackService.handleTaskFinished(hostId, payload)`。

3. **`src/terminal/routes/terminalWs.ts`**：
   - 在 `agentWss` 的 `JSON:` 控制消息分发分支中，新增对 `control.type === 'cmd_task_finished'` 的处理：
     ```ts
     if (control.type === 'cmd_task_finished') {
       terminalExecService.handleAgentTaskFinished(hostId, control);
       return;
     }
     ```

---

## 4. 测试与验证计划

1. **单元测试与集成测试（`tests/botExecCallback.test.ts`）**：
   - **参数校验测试**：验证非法 `callback.url`（非 http/https、空字符串）、非法 `method`、非法 `headers` 时 `POST /api/terminal/exec/:hostId` 返回 `400 Bad Request`。
   - **端到端异步回调测试**：启动本地测试 Webhook HTTP Server + Hub + Mock/真实 Agent，调用 `POST /api/terminal/exec/:hostId` 传入 `callback`（含 `headers`、`secret`、`context`），验证：
     - 接口立即返回 `202 Accepted` 且包含 `callbackRegistered: true`；
     - 命令执行完成后，Webhook Server 自动收到 POST 请求；
     - 校验 `X-GT-Event`、`X-GT-Task-Id`、`X-GT-Signature-256`（HMAC 签名验证通过）及自定义 `Authorization` 请求头；
     - 校验回调 Body 中的 `host`、`execution`（`status: 'completed'`, `exitCode: 0`, `stdout`）以及 `context` 原样透传。
   - **失败、超时与 Kill 回调测试**：
     - 非零退出码命令触发 `status: 'failed'`, `success: false`, `exitCode: 1` 回调；
     - 超时命令触发 `status: 'timeout'`, `success: false` 回调；
     - 运行中被调用 `/kill` 触发 `status: 'killed'`, `success: false` 回调。
   - **UTF-8 尾部截断测试**：
     - 当命令输出包含多字节中文字符且超出 `maxOutputBytes` 时，验证回调 `stdout`/`output` 保留尾部最新内容、无 `U+FFFD` 乱码，且 `execution.truncated === true`。
   - **重试与退避机制测试**：
     - 模拟 Webhook Server 前两次返回 `502 Bad Gateway`、第 3 次返回 `200 OK`，验证 Hub 自动重试并最终成功，`X-GT-Delivery-Attempt` 递增为 `3`；
     - 模拟 Webhook Server 返回 `400 Bad Request`，验证 Hub 不做无意义重试（仅请求 1 次）。
2. **回归测试**：
   - 运行既有 `tests/terminalTaskManager.test.ts` 与 `tests/terminalTaskApi.test.ts`，确保不带 `callback` 的原有命令执行与轮询逻辑零回归。
