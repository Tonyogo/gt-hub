# Rust 版 `gt` 客户端协议对接文档（基于 `PROTOCOL_VERSION = 2`）

> 本文档面向 Rust 版 `gt` CLI 客户端开发者，依据 `gt-hub` 仓库实际服务端/Agent/客户端实现整理，与规范 [protocol.md](./protocol.md) 保持一致。

---

## 1. 整体架构与协议范围

`gt` 客户端与 `gt-hub` 之间通过 **HTTP(S) REST** 与 **WebSocket** 两类传输通道交互：

| 功能模块 | 传输通道 | 端点路径 | 说明 |
|---|---|---|---|
| 认证状态与登录探测 | HTTP | `/api/auth/status`、`/api/auth/login` | 校验 `x-admin-key` 与持久化上下文 |
| 节点发现与清理 | HTTP | `/api/terminal/hosts`、`/api/terminal/hosts/offline` | `gt nodes` / `gt ps` / 节点 ID 解析 |
| 版本查询 | HTTP | `/api/terminal/version`、`/health` | `gt version` |
| 流式命令执行 | WebSocket | `/api/terminal/exec-ws` | `gt exec` / `gt exec -i` / `gt exec -it`（首选） |
| 异步/轮询命令执行 | HTTP | `/api/terminal/exec/:hostId` 等 | `gt exec -d` / `--poll` / `gt task` / `gt logs` |
| 文件上传与断点下载 | HTTP | `/api/terminal/files/upload`、`/api/terminal/files/download` | `gt cp`（multipart 上传 & `Range` 下载） |
| 定时任务管理 | HTTP | `/api/terminal/cron/:nodeId` 等 | `gt cron ls|add|rm|pause|resume|run|logs` |
| 端口转发与本地代理 | WebSocket | `/api/terminal/proxy-ws` | `gt forward` / `gt proxy`（TCP 流多路复用） |
| 网络测速与连通性探测 | HTTP | `/api/proxy/:hostId/speedtest/*`、`/api/proxy/:hostId/ports` | `gt speedtest` |
| MCP Server (stdio) | HTTP + stdio | `/api/terminal/mcp` 或本地引擎转调 REST API | `gt mcp`（JSON-RPC 2.0） |
| （可选）Agent 守护进程 | WebSocket | `/api/terminal/agent-ws` | 如 Rust 客户端也包含 `gt agent` 子命令 |

> 注：服务端同时挂载了兼容别名 `/api/admin/terminal/*` 与 `/api/admin/proxy/*`，新版客户端统一使用 `/api/terminal/*` 与 `/api/proxy/*`。

---

## 2. 本地配置、上下文与凭据解析（`~/.gt/config.json`）

### 2.1 存储路径与权限

- 配置目录优先读取环境变量 `GT_CONFIG_DIR`，未设置时使用 `$HOME/.gt`（目录权限建议 `0700`）。
- 配置文件为 `<config_dir>/config.json`（文件权限建议 `0600`）。

```json
{
  "currentContext": "default",
  "contexts": {
    "default": {
      "server": "http://localhost:8000",
      "key": ""
    }
  },
  "machineId": "a1b2c3d4e5f6",
  "agentName": "my-node",
  "server": "http://localhost:8000",
  "key": ""
}
```

- `machineId`：首次初始化时生成 6 字节随机 hex（12 个小写十六进制字符）。
- 为兼容旧版配置，顶层保留 `server` / `key`，切换或更新当前上下文时需同步更新顶层字段。

### 2.2 参数优先级

按由高到低顺序解析有效配置：

- **Server URL**：`--server` (`-s`) > `GT_SERVER` > `contexts[targetContext].server` > 顶层 `server` > `"http://localhost:8000"`
- **Admin Key**：`--key` (`-k`) > `ADMIN_SECRET_KEY` > `GT_KEY` > `contexts[targetContext].key` > 顶层 `key` > `""`
- **Context Name**：`--context` (`-c`) > `currentContext` > `"default"`

---

## 3. URL 构造、鉴权与 HTTP 客户端契约

### 3.1 子路径保留规则（必须严格实现）

当 Hub 部署在反向代理子路径下（如 `https://example.com:8443/gt-hub/`）时，**禁止**直接使用基于域名根路径的拼接（否则会丢失 `/gt-hub`）：

1. 若 `serverUrl` 缺少 scheme（非 `http://`、`https://`、`ws://`、`wss://` 开头），自动补 `http://`。
2. 剥离基础 URL 自身携带的 `search` 与 `hash`，取 `basePath = parsed.pathname.trim_end_matches('/')`。
3. 目标路径拼接为：`{basePath}/{endpoint_path.trim_start_matches('/')}`（合并连续斜杠）。
4. 构造 WebSocket URL 时，将 `http` -> `ws`、`https` -> `wss`。

### 3.2 鉴权与敏感参数禁止外泄

1. **HTTP 请求头**：若 `apiKey` 非空，设置请求头 `x-admin-key: <apiKey>`（服务端同时接受 `Authorization: Bearer <apiKey>`）。
2. **WebSocket Upgrade 握手**：
   - Rust 客户端**必须**通过 Upgrade HTTP Header 传递 `x-admin-key: <apiKey>`。
   - **禁止**在 WebSocket URL Query 参数中携带 `key`、`x-admin-key`、`admin_key`、`ticket`、`timezone`（仅浏览器因无法自定义 WS Header 才允许走 `?ticket=` / `?x-admin-key=`）。
3. **日志与限流**：
   - 服务端使用常量时间比对验证密钥，认证失败返回 HTTP `401`，连续失败触发 IP 限流返回 HTTP `429` 并带 `Retry-After` 秒数。

### 3.3 HTTP 压缩解码、完整性与超时

- 普通 JSON API 请求头：
  - `Accept: application/json`
  - `Accept-Encoding: gzip, deflate`
- 响应解压规则：
  - `Content-Encoding` 包含 `gzip`：使用 gzip 解压；
  - `Content-Encoding` 包含 `deflate`：先尝试标准 zlib（RFC 1950 `ZlibDecoder`），失败时回退裸 deflate（RFC 1951 `DeflateDecoder`）；
  - 解压后再按 UTF-8 解析 JSON（非 JSON 时不可误判为完整结构化响应）。
- **流完整性校验**：必须确保响应体完整读到正常 EOF 且无传输截断错误；遇到连接中途重置/关闭时**必须报错（或按策略重试）**，不可将半截响应当作成功结果。
- 默认超时：
  - 普通 JSON API 请求：`30,000 ms`
  - `gt cp` 上传/下载 Socket 空闲超时：`60,000 ms`
  - `gt speedtest` ping/probe 请求：`30,000 ms`；download/upload 请求：`120,000 ms`

### 3.4 节点标识符解析（`resolveHost`）

CLI 接受 `<host>` 参数（可为节点 ID、节点名称或前缀），通过 `GET /api/terminal/hosts` 解析为规范 `hostId`，顺序如下：

1. **精确 ID 匹配**：`host.id == input`（区分大小写）。
2. **精确名称匹配**：先检查 `host.name == input`，无结果再检查 `host.name.eq_ignore_ascii_case(input)`：
   - 若匹配到多个 `status == "online"` 节点 -> **报错并列出候选节点（拒绝歧义）**；
   - 若仅有 1 个在线节点 -> 选中该在线节点；
   - 若全为离线节点 -> 选中首个匹配节点。
3. **前缀匹配**：筛选 `id` 或 `name`（忽略大小写）以 `input` 开头的节点：
   - 仅 1 个匹配 -> 返回；
   - 多个匹配时，仅当其中恰好有 1 个 `status == "online"` 节点时返回该在线节点；否则报错拒绝歧义。
4. 无匹配 -> 报错 `No such host`。

---

## 4. 全量 HTTP REST API 规范

### 4.1 认证接口

- **`GET /api/auth/status`**（带 `x-admin-key` 请求头）
  - `200`: `{ "authRequired": bool, "authenticated": bool, "allowedParentOrigins": string[] }`
  - `429`: `{ "error": "..." }`（带 `Retry-After`）
  - *兼容降级*：若服务端返回 `404`（旧版无 `/api/auth/status`），回退请求 `GET /api/terminal/hosts`，若 `200` 且返回 `hosts` 数组则视为鉴权通过。
- **`POST /api/auth/login`**
  - Body: `{ "key": "<secret>" }`
  - `200`: `{ "success": true }`；`401`: `{ "error": "..." }`；`429`: 限流。

### 4.2 节点与版本接口

- **`GET /api/terminal/hosts`**
  - `200`:
    ```json
    {
      "success": true,
      "hosts": [
        {
          "id": "abc123def456",
          "name": "gpu-box",
          "hostname": "gpu-box",
          "ip": "10.0.0.2",
          "platform": "linux",
          "status": "online",
          "lastSeen": 1732690000000,
          "startTime": 1732680000000,
          "type": "agent",
          "machineId": "abc123def456",
          "version": "1.3.2"
        }
      ],
      "timezone": "Asia/Shanghai",
      "serverStartTime": 1732680000000,
      "serverUptimeMs": 10000000
    }
    ```
- **`DELETE /api/terminal/hosts/offline`**
  - `200`: `{ "success": true, "prunedCount": 2, "prunedIds": ["..."] }`
- **`GET /api/terminal/version`**
  - `200`: `{ "success": true, "version": "1.3.2", "gitCommit": "...", "buildTime": "...", "platform": "linux-x64", "timezone": "..." }`

### 4.3 异步命令执行与任务管理接口（`exec -d` / `--poll` / `task` / `logs`）

- **`POST /api/terminal/exec/:hostId`**
  - Body:
    ```json
    {
      "command": "uname -a",
      "cwd": "/tmp",
      "timeoutMs": 300000,
      "waitMs": 30000,
      "env": { "FOO": "bar" },
      "stdin": "optional string"
    }
    ```
    - `timeoutMs` 服务端限幅 `[1000, 3600000]`；`waitMs`（可选，上限 `60000`）若传入且任务在等待期内完成，返回 HTTP `200` 且 `completed: true` 并附完整输出；否则返回 HTTP `202`（未传 `waitMs` 时立即异步返回）：
    - `202`: `{ "success": true, "taskId": "task-...", "hostId": "...", "status": "running", "command": "...", "cwd": "...", "startTime": 1732690000000 }`
    - `200`（`waitMs` 内完成）: `{ "success": true, "completed": true, "taskId": "...", "hostId": "...", "status": "completed|failed|timeout|killed", "exitCode": 0, "stdout": "...", "stderr": "...", "output": "...", "totalBytes": 123, "durationMs": 45, "startTime": ..., "endTime": ... }`
- **`GET /api/terminal/exec/:hostId?limit=20`**
  - `200`: `{ "success": true, "hostId": "...", "tasks": [ { "taskId", "command", "cwd", "status", "exitCode", "durationMs", "startTime", "endTime" } ] }`
- **`GET /api/terminal/exec/:hostId/:taskId?offset=0`**
  - 增量拉取日志与状态：`offset` 为字节偏移。
  - `200`: `{ "success": true, "hostId": "...", "taskId": "...", "status": "running|completed|failed|timeout|killed", "exitCode": number|null, "stdout": "...", "stderr": "...", "output": "...", "offset": number, "outputOffset": number, "totalBytes": number, "durationMs": number, "startTime": number, "endTime": number|null }`
  - 客户端轮询建议间隔 `500ms`，以响应返回的 `outputOffset ?? offset` 作为下次请求的 `offset`（注意：服务端的 `sliceBufferUtf8Safe` 会跳过 UTF-8 续字节以防多字节字符截断）。
- **`POST /api/terminal/exec/:hostId/:taskId/kill`**
  - Body: `{ "signal": "SIGTERM" }`（仅支持 `"SIGTERM"` 或 `"SIGKILL"`）
  - `200`: `{ "success": true, "taskId": "...", "status": "killed", "message": "..." }`

> 注意：`gt logs <node> [taskId]` 与 `gt kill <node> <taskId>` 支持任务 ID 前缀/子串匹配（先请求 `GET /api/terminal/exec/:hostId`，若唯一起始或包含匹配则补全 `taskId`，多匹配报错 `Ambiguous task identifier`）。

### 4.4 文件传输接口（`gt cp`）

1. **单文件上传**
   - `POST /api/terminal/files/upload?hostId=<hostId>&path=<remoteDir>`
   - **格式 1（推荐，与现有 `gt cp` 一致）**：`Content-Type: multipart/form-data; boundary=<boundary>`
     - Part Header：`Content-Disposition: form-data; name="file"; filename="<safeFilename>"` + `Content-Type: application/octet-stream`
     - `<safeFilename>` 必须将 `"`、`\r`、`\n` 替换为 `_` 防止头部注入。
     - **建议显式计算并携带准确的 `Content-Length`**，流式读取本地文件避免大文件占用内存。
   - **格式 2（备选）**：直接传输原始二进制请求体，通过请求头 `x-filename: <url_encoded_filename>` 指定文件名。
   - 响应 `200`: `{ "success": true, "uploaded": ["<filename>"] }`；错误返回 `4xx/5xx` JSON `{ "success": false, "error": "..." }`。

2. **可断点续传下载**
   - `GET /api/terminal/files/download?hostId=<hostId>&path=<remotePath>`
   - **不要**在 `gt cp` 下载请求中发送 `Accept-Encoding: gzip` 或 `?compress=1`，确保服务器返回原始未压缩字节流，保证 HTTP `Range` 字节偏移与本地 `<dest>.part` 大小完全一致。
   - 续传流程：
     1. 若 `<dest>.part` 存在且大小 `existingBytes > 0`，附加请求头 `Range: bytes=<existingBytes>-`。
     2. 响应状态码处理：
        - **`206 Partial Content`**：以追加模式打开 `.part`；从 `Content-Range`（`bytes <start>-<end>/<total>`）解析 `expectedTotal`，若缺失则用 `existingBytes + Content-Length`。
        - **`200 OK`**：服务端不支持或未启用 Range，以截断写模式（从头覆写）打开 `.part`，`expectedTotal = Content-Length`。
        - **`416 Range Not Satisfiable`**：本地 `.part` 可能已损坏或超出远端大小，删除 `.part` 并立即无 `Range` 重下一次（若再次 416 则报错）。
        - **`429` 或 `5xx`**：进入可重试分支。
        - **其他 `4xx`**：读取错误 JSON 并立即失败，**不重试**。
     3. 完整性与错误隔离：
        - **本地磁盘写入错误**（如 `EISDIR`、`EACCES`、`ENOSPC`）**必须立即失败，绝不重试**。
        - 仅对网络传输中断 / Socket 超时（`60s`） / `5xx` / `429` / 响应流提前关闭（`!complete` 或接收字节不足 `expectedTotal`）进行最多 `10` 次重试，退避时间 `min(500 * 1.5^(retry - 1), 3000) ms`。
        - 接收字节大于 `expectedTotal` 时删除 `.part` 并从头重下。
        - 全部完成后校验总字节数一致，再将 `.part` 原子重命名覆盖目标文件。

3. **其他文件管理 REST 接口**（供 `gt mcp` 等工具调用）：
   - `GET /api/terminal/files/:hostId/list?path=<dir>`
   - `GET /api/terminal/files/:hostId/content?path=<file>`
   - `POST /api/terminal/files/:hostId/save` (`{ path, content }`)
   - `POST /api/terminal/files/:hostId/mkdir` (`{ path, dirName }`)
   - `POST /api/terminal/files/:hostId/rename` (`{ oldPath, newPath }`)
   - `DELETE /api/terminal/files/:hostId/delete` (`{ path }`)

### 4.5 定时任务（`gt cron`）

- `GET /api/terminal/cron/:nodeId` -> `{ "success": true, "data": CronJobSummary[], "timezone": "..." }`
- `POST /api/terminal/cron/:nodeId` -> Body:
  `{ "name": "...", "cron": "0 2 * * *", "source": "command"|"hub", "command": "...", "scriptName": "...", "scriptArgs": [], "cwd": "...", "timeoutMs": 60000, "concurrency": "forbid"|"allow", "status": "active"|"paused" }`
  -> `201 { "success": true, "data": CronJobConfig }`
- `PATCH /api/terminal/cron/:nodeId/:jobId` -> Body `{ "status": "paused"|"active", ... }` -> `200 { "success": true, "data": CronJobConfig }`
- `DELETE /api/terminal/cron/:nodeId/:jobId` -> `200 { "success": true, "message": "..." }`
- `POST /api/terminal/cron/:nodeId/:jobId/run` -> `200 { "success": true, "message": "..." }`
- `GET /api/terminal/cron/:nodeId/:jobId/logs?offset=0` -> `{ "success": true, "taskId": "...", "stdout": "...", "stderr": "...", "output": "...", "offset": number, "status": "..." }`

### 4.6 Proxy 测速与端口扫描（`gt speedtest`）

- `GET /api/proxy/:hostId/speedtest/ping` -> `{ "success": true, "hubAgentRttMs": number, "timestamp": number }`
  - 客户端测量整段 HTTP RTT `totalRttMs`，计算 `clientHubRttMs = max(0, totalRttMs - hubAgentRttMs)`。
- `GET /api/proxy/:hostId/speedtest/download?bytes=<sizeBytes>`（Agent 侧限幅 `64 KiB` – `256 MiB`）
  - 返回 `200 application/octet-stream`，客户端必须校验响应完整结束（无提前 close/截断）。
- `POST /api/proxy/:hostId/speedtest/upload`
  - 发送 `Content-Type: application/octet-stream` 与精确 `Content-Length: <sizeBytes>` 的伪随机字节流（分块写入背压控制）。
  - 返回 `200 { "receivedBytes": number, "agentDurationMs": number }`。
  - **关键校验**：若服务端在客户端未写完所有 `sizeBytes` 前提前回复 `200` 并关闭（`sentBytes < sizeBytes`），或响应未完整结束，**必须判定为提前中止错误**。
- `POST /api/proxy/:hostId/speedtest/probe`
  - Body: `{ "targets"?: string[] }`
  - 返回 `200 { "success": true, "results": [ { "url": "...", "ok": bool, "statusCode"?: number, "latencyMs": number, "error"?: string } ] }`
- `GET /api/proxy/:hostId/ports`
  - 返回 `200 { "success": true, "ports": [ { "port": number, "address": string, "pid"?: number, "process"?: string } ] }`

### 4.7 MCP 接口（`gt mcp` / HTTP JSON-RPC 2.0）

- **HTTP 模式**：
  - `GET /api/terminal/mcp` -> `{ "success": true, "name": "gt-mcp", "version": "...", "protocol": "mcp-jsonrpc-2.0" }`
  - `POST /api/terminal/mcp` -> JSON-RPC 2.0 请求（Batch 数组空批返回 `-32600`，通知返回 `202` 空响应体），支持安全策略请求头：`x-mcp-readonly: true|1`、`x-mcp-nodes: node1,node2`、`x-mcp-max-output: 32768`。
- **CLI stdio 模式（`gt mcp`）**：
  - 按行从 `stdin` 读取 JSON-RPC 2.0（`initialize`、`ping`、`tools/list`、`tools/call`）并逐行写 `stdout`，普通日志全部重定向至 `stderr`；工具调用底层转调上述 REST API。
  - 工具清单：`gt_list_nodes`、`gt_exec`、`gt_task_list`、`gt_task_status`、`gt_task_kill`、`gt_list_files`、`gt_read_file`、`gt_write_file`、`gt_mkdir`、`gt_delete_file`、`gt_rename_file`、`gt_cron_list`、`gt_cron_add`、`gt_cron_update`、`gt_cron_delete`、`gt_cron_run`、`gt_cron_logs`。

### 4.8 错误 HTTP 状态映射

服务端内部通过 `mapRpcErrorToHttpStatus` 映射常见错误：`400`（参数缺失/无效/已存在）、`403`（权限/路径越界/Agent 禁用 proxy）、`404`（文件或任务不存在）、`503`（节点离线或重连取消）、`504`（超时）、`500`（兜底）。

---

## 5. WebSocket 二进制帧封装与隔离规范

### 5.1 WebSocket 帧类型纪律（Rust `tungstenite` 必读）

服务端使用 Node `ws` v8+，与 `tokio-tungstenite` 的对应关系如下：

- **Text 帧（`Message::Text(String)` / Opcode `0x1`）**：仅用于文本控制消息或交互式文本终端输出。**绝不可**被当作二进制协议包（`0x01`–`0x0a`）解码。
- **Binary 帧（`Message::Binary(Vec<u8>)` / Opcode `0x2`）**：用于原始二进制流（`exec-ws` stdin/stdout）或结构化二进制封包（`BIN_MSG_TYPE`）。
- **Compression（`permessage-deflate`）**：Hub 服务端配置为 `threshold = 1024, level = 3, clientNoContextTakeover = true, serverNoContextTakeover = true`。对于控制帧和小尺寸高频数据帧，Rust 客户端如启用 `permessage-deflate` 需注意避免小帧压缩带来延迟。

### 5.2 二进制协议包头布局（`BIN_MSG_TYPE`）

```text
+---------------+---------------+-------------------+----------------------+
| msgType (1B)  | idLen (1B)    | id (ASCII, 0..255)| payload (0..N bytes) |
+---------------+---------------+-------------------+----------------------+
  offset 0        offset 1        offset 2            offset 2 + idLen
```

| 字节 | 常量名 | 适用端点 | `id` 含义 | `payload` 内容 |
|---|---|---|---|---|
| `0x01` | `STREAM_INPUT` | `agent-ws` (Hub -> Agent) | `taskId` (`exec-...` / `pane-...`) | 原始 stdin 字节 |
| `0x02` | `STREAM_OUTPUT` | `agent-ws` (Agent -> Hub) | `taskId` (`exec-...` / `pane-...`) | 原始 stdout/stderr 字节 |
| `0x03` | `TERMINAL_RAW` | `agent-ws` (双向) | `"main"` 或分屏 `paneId` | 原始 PTY 终端字节 |
| `0x04` | `HISTORY_SYNC` | `agent-ws` (Agent -> Hub) | `hostId` 或 `paneId` | 历史回放缓冲区快照 |
| `0x05` | `PROXY_HTTP_REQ_BODY` | `agent-ws` (Hub -> Agent) | `reqId` | HTTP 代理请求体分片 |
| `0x06` | `PROXY_HTTP_RES_BODY` | `agent-ws` (Agent -> Hub) | `reqId` | HTTP 代理响应体分片 |
| `0x07` | `PROXY_TCP_DATA` | `proxy-ws` & `agent-ws` (双向) | `streamId` | 原始 TCP 字节分片（建议 `<= 32 KiB`/包） |
| `0x08` | `CONTROL_JSON` | `agent-ws` / `ws` / `proxy-ws` | `clamp(id, 255B)` | UTF-8 JSON 控制帧（必须满足白名单） |
| `0x09` | `FILE_CHUNK_REQ` | `agent-ws` (Hub -> Agent) | `reqId` | `u32 BE metaLen + JSON meta + rawData` |
| `0x0a` | `FILE_CHUNK_RES` | `agent-ws` (Agent -> Hub) | `reqId` | `u32 BE metaLen + JSON meta + rawData` |

---

## 6. CLI WebSocket 子协议详细状态机

### 6.1 流式命令执行：`/api/terminal/exec-ws?hostId=<hostId>`

对应 `gt exec`（非 `-d`、非 `--poll`）以及 `gt exec -it`（`interactive && tty`）。

> **核心设计**：`/api/terminal/exec-ws` 采用**严格 Opcode 隔离**（`capabilities.binaryControl` 恒为 `false`）：
> - 所有**控制消息**均为 **`Message::Text`**（纯 JSON，**无** `JSON:` 前缀）；
> - 所有 **stdin / stdout / stderr 数据**均为 **`Message::Binary`**（**无** `BIN_MSG_TYPE` 包头，直接透传裸字节）。

#### 状态机流程

1. **连接与鉴权**：
   - URL：`<ws_base>/api/terminal/exec-ws?hostId=<resolvedHostId>`（禁止放 key 到 Query）。
   - Header：`x-admin-key: <apiKey>`。
   - 若 Upgrade 阶段返回 HTTP `401` / `403` / `429`：**立即报错退出（码 `1`），严禁回退 HTTP 轮询**。
   - 若 Upgrade 阶段因反向代理不支持 WebSocket 或连接拒绝失败（且尚未收到 `exec_started`）：可回退到 `POST /api/terminal/exec/:hostId` HTTP 轮询模式。

2. **发送启动指令（`Open` 后立即发送 `Message::Text`）**：
   ```json
   {
     "type": "exec_start",
     "protocolVersion": 2,
     "command": "<fullCommand>",
     "cwd": "/optional/workdir",
     "env": { "KEY": "VAL" },
     "timeoutMs": 300000,
     "tty": false,
     "interactive": false,
     "cols": 80,
     "rows": 24
   }
   ```
   - 注意参数解析时：单个命令字符串（`commandParts.len() == 1`）按 `trim()` 保留原串；多参数时按 `quoteShellArg` 规则空格拼接（匹配 `/^[a-zA-Z0-9_.\-\/=:@]+$/` 直接透传，否则用单引号包裹并将内部 `'` 转义为 `'\''`）。

3. **等待 `exec_started` 协商后再挂载标准输入（关键防竞态）**：
   - 服务端检查节点在线后，先下发 `Message::Text`：
     ```json
     {
       "type": "exec_started",
       "taskId": "exec-...",
       "protocolVersion": 2,
       "capabilities": {
         "stdinEof": true,
         "binaryStdin": true,
         "binaryControl": false
       }
     }
     ```
   - **在收到 `exec_started`（或 `3000ms` v1 兼容兜底超时）之前，不得开始读取和发送本地 `stdin`**（防止过早向 v1/v2 误注入 `0x04` 或阻塞）。
   - 协商后输入行为：
     - **流式/管道/交互（`interactive || !stdin.is_tty`）**：持续读取本地 `stdin` 字节并以 `Message::Binary(chunk)` 发送。当本地 `stdin` 到达 `EOF` 时（非 TTY 或未开启 TTY raw mode）：
       - 若 `capabilities.stdinEof == true` -> 发送 `Message::Text`: `{"type":"exec_stdin_eof"}`
       - 若为 v1 服务端（无 `stdinEof`） -> 发送 `Message::Binary([0x04])`
     - **非交互 TTY（`!interactive && stdin.is_tty`）**：`exec_started` 后立即发送上述 EOF 通知，避免远端 `cat` 等读 stdin 命令卡死。
   - **交互式 TTY 模式（`interactive && tty`）**：
     - 本地开启终端 Raw Mode（若 `stdin` 为 TTY），监听终端窗口变化（`SIGWINCH`）发送 `Message::Text`: `{"type":"resize","cols":u16,"rows":u16}`。
     - 退出或中断时务必恢复本地终端模式，并在 `tty == true` 时输出 `\x1b[?25h\x1b[0m`。

4. **入站帧分发规则**：
   - **`Message::Binary(bytes)`**：直接原样写入本地 `stdout`（并标记 `receivedServerOutput = true`）。
   - **`Message::Text(text)`**：
     - 若包含 `"[Host Offline]"` 或 `"[Agent Disconnected]"` -> 写入 `stderr`。
     - 尝试解析 JSON 对象（非数组）：
       - `type == "exec_started"` -> 触发 stdin 管道，记录 `execStarted = true` 与 `capabilities.stdinEof`。
       - `type == "pong"` -> 心跳保活，忽略。
       - `type == "exec_exit"` -> 取 `exitCode`（默认 `0`），关闭 WS `1000`，以 `exitCode` 退出。
       - `type == "exec_error"` -> 打印 `error` 到 `stderr`，关闭 WS，以 `json.exitCode ?? 1` 退出。
     - 其余非控制文本 -> 写入 `stdout`（标记 `receivedServerOutput = true`）。

5. **信号转发、心跳与断连退出码规则**：
   - **信号**：收到 `SIGINT` / `SIGTERM` 时，先发送 `Message::Text`: `{"type":"exec_kill","signal":"SIGINT"|"SIGTERM"}` 并等待发出（最多等 ~80ms），随后关闭 WS，进程退出 `130`（`SIGINT`）或 `143`（`SIGTERM`）。
   - **心跳**：每 `15s` 发送 WS `Ping` + `Message::Text({"type":"ping"})`；任何 `Pong` 或入站消息刷新 `lastActivityAt`；超过 `45s` 无任何活动则主动断开。
   - **WS Close 退出码判定（必须严格遵守）**：
     - 收到 `1008` -> 返回退出码 `1`（不回退 HTTP）。
     - 收到 `1000` 且已确认执行开始（`execStarted || stdinBytesSent > 0 || receivedServerOutput`）-> 返回退出码 `0`。
     - **切勿**将 `1005`（No Status Received）视作正常退出 `0`。
     - 若尚未开始执行（`!hasExecutionStarted()`）且非 `401`/`403`/`429` -> 报错允许回退 HTTP 轮询；若**已开始执行**（如收到 `1001` Server shutting down、`1012` Agent disconnected、`1005`/`1006` 异常断开）-> **直接报错退出（码 `1`），严禁回退 HTTP 重新执行命令**。

---

### 6.2 TCP 隧道代理：`/api/terminal/proxy-ws?hostId=<hostId>[&binaryControl=1]`

对应 `gt forward` 与 `gt proxy`。

1. **连接**：
   - URL：`<ws_base>/api/terminal/proxy-ws?hostId=<resolvedHostId>`（可选加 `&binaryControl=1` 让 Hub 下发二进制 `CONTROL_JSON`）。
   - Header：`x-admin-key: <apiKey>`。
   - Upgrade 被拒（如 `401`）或在 `open` 前收到 `close` 必须立即返回错误，不可悬空等待。

2. **控制消息编解码**：
   - **发送控制消息**：默认发送 `Message::Text("JSON:" + serde_json::to_string(&msg))`（若带 `&binaryControl=1`，也可编码为 `BIN_MSG_TYPE.CONTROL_JSON (0x08)` 以 `Message::Binary` 发送；Hub `terminalProxyBridge.ts` 同时接受两者）。
   - **接收帧规则**：
     - `Message::Binary(buf)`：
       - 若 `buf[0] == 0x07` (`PROXY_TCP_DATA`)：解析 `streamId` 与 `payload`，投递给对应本地 TCP stream。
       - 若 `buf[0] == 0x08` (`CONTROL_JSON`)：解析校验 `VALID_CONTROL_TYPES` 控制消息；畸形丢弃。
       - **其他任意 `Message::Binary` 帧（首字节既非 `0x07` 也非 `0x08`）：直接丢弃，严禁当成 UTF-8 `JSON:` 文本解析！**
     - `Message::Text(text)`：仅当以 `"JSON:"` 开头且通过控制消息类型检查时处理。
   - **端口映射语法（`parseForwardMapping`）**：支持 `3000`、`8080:3000`、`8080:192.168.1.10:80`、`0.0.0.0:8080:3000`、`0.0.0.0:8080:127.0.0.1:3000`（本地端口允许 `0` 自动分配，远端端口须 `1..=65535`）。

3. **多路复用 TCP 流状态机**：
   - **建立流**：生成 `streamId`（非空 ASCII，长度 `<= 255` 字节，**禁止包含 `\0`**，如 `tcp-<ms>-<rand>`），本地注册状态 `is_connected = false`，发送：
     `{"type":"proxy_tcp_connect","streamId":"...","host":"127.0.0.1","port":8080}`
   - **未连接前写入缓冲**：在收到 `proxy_tcp_connected` 前，本地 socket 读到的数据存入 `pendingWrites` 队列，**单流缓冲上限 `2 MiB`（`2 * 1024 * 1024` 字节）**；超出则立即移除流、关闭本地 socket 并通知服务端 `proxy_tcp_close`。
   - **连接确认**：收到 `{"type":"proxy_tcp_connected","streamId":"..."}`：
     - 标记 `is_connected = true`；
     - 若为本地 HTTP CONNECT 代理模式，此时向本地 client socket 写入 `"HTTP/1.1 200 Connection Established\r\n\r\n"` 及初始 `head` 字节；
     - 依次冲洗 `pendingWrites`。
   - **数据转发**：所有出站 TCP 数据切分为 **`<= 32 KiB`（`32768` 字节）** 分片，封装 `BIN_MSG_TYPE.PROXY_TCP_DATA (0x07)` 以 `Message::Binary` 发送。
   - **关闭清理**：
     - 本地 socket 断开或出错 -> 发送 `proxy_tcp_close { streamId }` 并移除流；
     - 收到 `proxy_tcp_close { streamId, error?, code? }`（服务端可能返回 `EINVAL`、`EEXIST`、`EHOSTUNREACH`、`ECONNRESET`、`EACCES`、`EMFILE`）-> 移除流并销毁本地 socket。
   - **心跳**：每 `15s` 发 WS `Ping` + `JSON:{"type":"ping"}`，`45s` 无任何响应超时关闭隧道并清理所有活跃流。

---

## 7. （可选）Agent 反向隧道协议要点：`/api/terminal/agent-ws`

如果 Rust 客户端也需要实现 `gt agent` 守护进程模式，关键规范如下（完整细节见 [protocol.md](./protocol.md)）：

- **连接 URL**：`<ws_base>/api/terminal/agent-ws?hostId=...&name=...&hostname=...&ip=...&platform=...&machineId=...&version=...&startTime=...&protocolVersion=2&binaryControl=1&binaryFile=1&framedTerminal=1`（同样通过 Header `x-admin-key` 鉴权）。
- **握手结算**：
  - 连接打开时先置 `_binaryControl = false`、`_binaryFile = false`、`_framedTerminal = false`、`_handshakeSettled = false`，将早期主 PTY 输出暂存在内存队列（`256 KiB` 上限）。
  - 收到 `registered` 控制帧后应用 `capabilities`，置 `_handshakeSettled = true`，发初始 `reset`/`resize`，并按 `_framedTerminal` 冲洗队列（`true` 时用 `BIN_MSG_TYPE.TERMINAL_RAW` 包装 `id = "main"`）。若对接旧版 Mock Hub 未发 `registered`，需有 `3000ms` 宽限定时器结算为 v1 默认值。
  - 若收到 `rejected` 或 WS 关闭码 `4009`（节点名/machineId 冲突），**立即以退出码 `1` 终止进程，不得重连**。
- **核心能力**：
  - `TERMINAL_RAW (0x03)`：主 PTY（`id="main"`）与分屏 PTY 双向数据。
  - `HISTORY_SYNC (0x04)`：重连或收到 `history_req` 时回传缓冲区快照（空历史回复 `history_sync` 控制帧 `{ type: "history_sync", history: "" }`）。
  - `cmd_exec (action: start | poll | status | stream | kill | list | start_stream)` 与 `STREAM_INPUT (0x01)` / `STREAM_OUTPUT (0x02)` / `cmd_stream_eof` / `cmd_stream_resize` / `cmd_stream_kill` / `cmd_stream_exit`。注意 `!tty` 流式 stdout 必须走**原始字节合批（不经 UTF-8 替换解码）**，避免非 UTF-8 输出变成 `U+FFFD`。
  - `file_rpc` 与 `FILE_CHUNK_REQ (0x09)` / `FILE_CHUNK_RES (0x0a)` 零 Base64 分片读写。
  - `cron_sync` / `cron_trigger` / `cron_report` 与 `proxy_*` 处理。
- **Agent 心跳与重连**：每 `15s` 发 WS `Ping` + `ping` 控制帧；超时 `60s`（存在活跃 `file_rpc` 时放宽为 `2x = 120s`）；断连指数退避重连 `min(30000, 1000 * 1.5^min(attempts, 8)) ms`。

---

## 8. Rust 工程落地清单与易错点提醒

1. **推荐 Crate 选型**
   - 异步运行时：`tokio`（`full`）
   - WebSocket：`tokio-tungstenite`（原生区分 `Message::Text` / `Message::Binary` / `Message::Ping` / `Message::Pong` / `Message::Close`）
   - HTTP：`reqwest`（注意：`cp` 下载和 `speedtest/download` 请关闭自动解压或使用底层流直接读取精确字节数，普通 API 请求使用 `flate2` 的 `GzDecoder` + `ZlibDecoder` / `DeflateDecoder` 回退）
   - 终端 Raw Mode & 窗口尺寸：`crossterm`（`enable_raw_mode()` + `SIGWINCH` / `Event::Resize`）
   - CLI 参数解析：`clap`（注意 `gt exec [OPTIONS] <host> <command...>` 在遇到 `<host>` 或 `--` 之后的参数需透传给远端，不可被本地 `clap` 吞掉，对应 `trailing_var_arg = true`）

2. **重点避坑校验表**
   - [ ] `gt exec -it` 时 `exec_start` 等 `exec_started` 返回后再 attach 本地 `stdin`，避免能力协商未完成导致 EOF/Control 丢失。
   - [ ] `exec-ws` 收到 `1005` 关闭码且无 `exec_exit` 时，**绝对不能**返回退出码 `0`。
   - [ ] `exec-ws` 在 `exec_started` 之后断连或遭遇 `401/403/429` 时，**绝对不能**降级调用 HTTP `/api/terminal/exec/:hostId` 重放命令。
   - [ ] `gt cp` 遇到本地文件写入错误（`EISDIR` / `EACCES`）直接报错，**不重试**；遇网络断流或 `5xx`/`429` 才使用 `.part` + `Range` 续传重试。
   - [ ] `gt speedtest` 上传阶段若服务器在全量发完前提前回 `200`，判定为异常中止。
   - [ ] `CliTcpTunnelClient` 中 `Message::Binary` 首字节不是 `0x07`/`0x08` 时直接丢弃，不回落 UTF-8 解析。
   - [ ] 所有 HTTP 与 WS URL 拼接均通过子路径保留构造器完成，且 Node/Rust WS 绝不在 URL Query 暴露 `x-admin-key`。
