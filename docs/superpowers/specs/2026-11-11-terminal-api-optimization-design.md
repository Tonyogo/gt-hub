# 终端控制接口标准化与能力增强设计文档

- **日期**：2026-11-11
- **状态**：待评审

## 1. 背景与目标

在对 `gt-hub` 终端控制接口进行全景梳理后，识别出当前控制面在接口一致性、状态码语义、WebSocket 控制协议隔离、短命令执行体验以及响应结构方面的 5 项核心问题：

1. **路由参数命名与传参位置分裂**：Exec 使用 `:hostId`，Cron 使用 `:nodeId`，而 Files 接口仅支持 Query 或 Body 传参且在同一个 Controller 内部混用 `req.query.hostId` 与 `req.body.hostId`。
2. **HTTP 错误状态码映射粗糙**：节点离线在 `getExecStatus`、`killExec`、`listExec`、`files/*` 中被返回 `500`，在 `cron.triggerJob` 中被返回 `400`；权限拒绝、沙箱越界与 RPC 超时也全部笼统返回 `500`。
3. **RPC 通道与主终端输入缓冲耦合，且 `'JSON:'` 文本前缀存在误吞风险**：`RpcDispatcher` 调用 `session.write()` 发送 RPC 控制帧，导致断线时 RPC 消息混入主终端 4KB 键盘输入缓冲区（`pendingInputBuffer`）；同时终端流仅靠 `startsWith('JSON:')` 识别控制消息，缺少二进制控制帧与白名单校验。
4. **`POST /api/terminal/exec/:hostId` 缺少同步等待模式（`waitMs`）与脚本库联动能力（`scriptName`）**：短命令也必须走两步异步交互，且无法直接调用 Hub `/api/scripts` 托管的脚本。
5. **JSON 响应信封（Envelope）不统一**：`hosts`、`version`、`logs` 与 `proxy` 控制接口缺少顶层 `success: boolean` 字段。

本设计在不破坏任何既有前端、CLI 与测试套件兼容性的前提下，对上述 5 项问题进行系统性优化。

---

## 2. 详细架构与模块设计

### 2.1 统一路由寻址与节点参数解析（问题 1 优化）

1. **新增统一参数提取工具 `src/terminal/utils/requestParams.ts`**：
   - `extractHostId(req: Request): string`：
     按优先级依次读取 `req.params?.hostId`、`req.params?.nodeId`、`req.query?.hostId`、`req.query?.nodeId`、`req.body?.hostId`、`req.body?.nodeId`；若为数组则取首元素，转为字符串并 `.trim()`，未找到时返回空字符串 `''`。

2. **扩展文件管理与定时任务路由（`src/terminal/routes/terminalRoutes.ts`）**：
   - 保留所有原有 `/files/*` 路由，并新增 RESTful Path 路由别名：
     - `GET /files/:hostId/list`
     - `GET /files/:hostId/content`
     - `POST /files/:hostId/save`
     - `POST /files/:hostId/mkdir`
     - `POST /files/:hostId/rename`
     - `DELETE /files/:hostId/delete`
     - `GET /files/:hostId/download`
     - `POST /files/:hostId/upload`
   - `terminalFileController.ts` 中全部 8 个方法（`listFiles`, `readFileContent`, `saveFileContent`, `createDirectory`, `renameFile`, `deleteItem`, `downloadFile`, `uploadFile`）统一使用 `extractHostId(req)` 获取 `hostId`，使 Path、Query、Body 三种传参方式在所有文件接口上均有效。
   - `terminalExecController.ts` 与 `terminalCronController.ts` 同样支持通过 `extractHostId(req)` 兼容 `:hostId` 与 `:nodeId`。

---

### 2.2 标准化 HTTP 错误状态码映射（问题 2 优化）

1. **新增错误码映射工具 `src/terminal/utils/httpErrorMapper.ts`**：
   - `mapRpcErrorToHttpStatus(errorMsg?: string | null, fallbackStatus: number = 500): number`：
     按以下优先级匹配错误信息（大小写不敏感）：
     1. **`400 Bad Request`**：匹配 `/invalid|required|cannot be empty|not a directory|is a directory|already exists|malformed|boundary not found|no files uploaded/i`
     2. **`403 Forbidden`**：匹配 `/permission denied|eacces|eperm|access denied|outside.*workspace|path traversal|sandbox|forbidden/i`
     3. **`404 Not Found`**：匹配 `/not found|no such file|no such task|enoent|does not exist/i`
     4. **`503 Service Unavailable`**：匹配 `/offline|unavailable|not connected|disconnected|reconnected.*cancelled/i`
     5. **`504 Gateway Timeout`**：匹配 `/timed?\s*out/i`
     6. 未命中时返回 `fallbackStatus`。

2. **控制器错误响应标准化**：
   - **`terminalExecController.ts`**：
     - `startExec`（默认 fallback `400`）、`getExecStatus`（默认 fallback `500`）、`killExec`（默认 fallback `500`）、`listExec`（默认 fallback `500`）统一调用 `mapRpcErrorToHttpStatus(result.error, fallback)`。当节点离线时，四个接口一致返回 `503 Service Unavailable`；RPC 超时一致返回 `504 Gateway Timeout`。
   - **`terminalFileController.ts`**：
     - `listFiles`、`readFileContent`、`saveFileContent`、`createDirectory`、`renameFile`、`deleteItem`、`downloadFile`、`uploadFile` 在 `result.success === false` 时统一使用 `mapRpcErrorToHttpStatus(result.error, 500)`。
   - **`terminalCronController.ts`**：
     - `getJobs`、`addJob`、`updateJob`、`deleteJob`、`triggerJob`、`getJobLogs` 的 `catch (err)` 块统一使用 `mapRpcErrorToHttpStatus(err.message, 400)`，修复 `triggerJob` 在节点离线时误返 `400` 的问题（改为返回 `503`）。

---

### 2.3 RPC 通道解耦与 `BIN_MSG_TYPE.CONTROL_JSON (0x08)` 双栈控制协议（问题 3 优化）

1. **扩展二进制协议（`src/shared/protocol/binaryProtocol.ts`）**：
   - 在 `BIN_MSG_TYPE` 中新增：
     ```ts
     CONTROL_JSON: 0x08,
     ```
   - 新增辅助函数：
     - `encodeControlJsonPacket(control: Record<string, any>, id: string = ''): Buffer`：将控制对象序列化为 UTF-8 JSON 并通过 `encodeBinaryPacket(BIN_MSG_TYPE.CONTROL_JSON, id, jsonStr)` 编码。
     - `decodeControlJsonPacket(buf: Buffer | Uint8Array): Record<string, any> | null`：解码二进制包，若 `msgType === BIN_MSG_TYPE.CONTROL_JSON` 且 payload 为合法控制对象则返回解析后的对象，否则返回 `null`。
     - `isValidControlPayload(obj: unknown): obj is Record<string, any>`：校验 `obj` 为非空普通对象（`!Array.isArray(obj)`）且 `typeof obj.type === 'string'`，并且 `obj.type` 属于合法控制消息类型集合（涵盖 `ping`, `pong`, `registered`, `rejected`, `meta`, `resize`, `reset`, `pane_close`, `pane_exit`, `agent_offline`, `history_req`, `history_sync`, `file_rpc`, `file_rpc_res`, `cmd_exec`, `cmd_exec_res`, `cmd_task_finished`, `cmd_stream_input`, `cmd_stream_data`, `cmd_stream_resize`, `cmd_stream_kill`, `cmd_stream_exit`, `exec_start`, `exec_started`, `exec_exit`, `cron_sync`, `cron_trigger`, `cron_report`, 以及 `proxy_` 前缀消息）。
     - `sendControlFrame(ws: any, payload: Record<string, any>, id: string = ''): boolean`：若 `ws` 处于连接状态（`readyState === 1`），当 `ws._binaryControl === true` 时发送 `encodeControlJsonPacket(payload, id)`，否则发送 `JSON:${JSON.stringify(payload)}`。

2. **WebSocket 双端接收与终端防误吞（`terminalWs.ts`、`terminalHostManager.ts`、`daemon.ts`、`terminalUI.ts`）**：
   - 在 `terminalWs.ts`（`agentWss` 与 `wss`）以及 `src/agent/daemon.ts` 中：
     - 若连接 URL 携带 `?binaryControl=1` 或 `?binaryControl=true`，标记 `(ws as any)._binaryControl = true`。
     - 当收到二进制帧且 `decoded.msgType === BIN_MSG_TYPE.CONTROL_JSON` 时，解析 `decoded.payload` 并进入与 `JSON:` 完全一致的控制帧处理逻辑。
     - 当收到以 `'JSON:'` 开头的文本帧时，先尝试 `JSON.parse(msgStr.slice(5))` 并用 `isValidControlPayload(control)` 校验：
       - 若是合法控制帧，进入控制分支消费；
       - 若 `JSON.parse` 抛出异常或 `!isValidControlPayload(control)`，**不再丢弃**，而是将其作为普通终端数据透传（`hostMgr.handleAgentData` 或 `session.write`）。
   - 在 `RemoteAgentTerminalSession.handleData`（`src/terminal/services/terminalHostManager.ts:509`）中：
     - 将原本粗暴的 `if (typeof data === 'string' && data.startsWith('JSON:')) return;` 改为：仅当 `data.startsWith('JSON:')` 且解析后通过 `isValidControlPayload` 时才忽略，否则正常写入终端历史缓冲并广播给前端终端。

3. **`RpcDispatcher` 与 `session.write()` 解耦（`src/terminal/services/rpcDispatcher.ts`）**：
   - `executeCmdRpc(session, canonicalId, payload, timeoutMs = 30000)` 增加 `timeoutMs` 参数支持。
   - 在 `executeCmdRpc` 与 `executeFileRpc` 中：
     - 直接通过 `const agentWs = typeof session?.getAgentWs === 'function' ? session.getAgentWs() : null` 获取底层 Agent WebSocket；
     - 若 `!agentWs || (agentWs.readyState !== 1 && agentWs.readyState !== (agentWs.constructor?.OPEN ?? 1))`，立即返回 `{ success: false, error: 'Agent ... terminal session is not connected' }`；
     - 发送时直接调用 `sendControlFrame(agentWs, { type: '...', reqId, ...payload })`（若测试中传入的 mock `session` 没有 `getAgentWs` 方法但有 `write` 方法，仅在无 `getAgentWs` 函数时才回退调用 `session.write(rpcMsg)` 以保持纯单元测试 mock 兼容；对于真实 `RemoteAgentTerminalSession`，永远只通过 `agentWs` 直接发送，绝不经过 `session.write()`，从而彻底杜绝断线时 RPC 消息进入 `pendingInputBuffer`）。
   - 为 `executeCmdRpc` 与 `executeFileRpc` 中的 `timeoutTimer` 补齐 `if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()`。

---

### 2.4 `POST /api/terminal/exec/:hostId` 增强：`waitMs` 同步等待与 `scriptName` 脚本库联动（问题 4 优化）

1. **请求参数扩展（`StartExecutionOptions`）**：
   ```ts
   export interface StartExecutionOptions {
     command?: string;
     scriptName?: string;
     scriptArgs?: string[];
     cwd?: string;
     timeoutMs?: number;
     waitMs?: number;
     env?: Record<string, string>;
     stdin?: string;
     callback?: ExecCallbackConfig;
   }
   ```
   - **校验规则**：
     - `command` 与 `scriptName` 至少提供一个非空字符串；若两者均为空，返回 `400 Bad Request`（`Field "command" or "scriptName" is required`）。
     - 若提供 `scriptArgs`，必须为字符串数组（或自动将元素转为字符串），否则返回 `400 Bad Request`。
     - 若提供 `waitMs`，必须为非负数字，自动钳制在 `[0, 60000]`（0 ~ 60 秒）范围内。

2. **Hub 脚本库联动执行（`scriptName` + `scriptArgs`）**：
   - 当传入 `scriptName`（且未传 `command`）时：
     - `terminalExecService.startExecution` 调用 `scriptService.getScript(scriptName.trim())` 获取脚本内容：
       - 若脚本不存在或名称非法，直接返回 `{ success: false, error: err.message }`（由 `mapRpcErrorToHttpStatus` 映射为 `404 Not Found` 或 `400 Bad Request`）。
     - 将脚本内容作为待执行逻辑：
       - 若调用方未额外传入 `stdin`，可将脚本正文通过 `stdin` 注入，并将执行命令构造为：`sh -s -- <shellEscapedArgs>`；
       - 若调用方同时传入了自定义 `stdin`，则通过 Base64 内联方式构造命令：`eval "$(printf '%s' '<base64Script>' | base64 -d)" <shellEscapedArgs>` 或在临时脚本中执行，使自定义 `stdin` 仍能传给脚本自身标准输入。
       - 更通用且跨平台（Linux/macOS）一致的做法：当无自定义 `stdin` 时使用 `sh -s -- <escapedArgs>` + `stdin: scriptContent`；当有自定义 `stdin` 时，使用 `sh -c <shellEscapedScriptContent> sh <escapedArgs>` 并保留用户的 `stdin`。实际上，`sh -c <shellEscapedScriptContent> <scriptName> <escapedArgs>` 无论是否有自定义 `stdin` 都能完美工作，且不占用 `stdin` 通道！因此统一采用：
         ```ts
         // 构造安全的 sh -c 调用，使 $0 为 scriptName，$1..$N 为 scriptArgs，且完全保留用户传入的 stdin
         ```

3. **事件驱动的 `waitMs` 混合同步/异步等待机制**：
   - 在 `TerminalExecService` 中维护等待表 `private taskWaiters: Map<string, (event: any) => void> = new Map()`。
   - 当 `handleAgentTaskFinished(hostId, data)` 被触发时：
     - 首先检查 `this.taskWaiters.get(data.taskId)`：
       - 若存在正在等待同步返回的 HTTP 请求，立即调用该 waiter 解决 Promise（此时该任务还在 `waitMs` 窗口内，尚未注册后台 Webhook，因此直接由同步 HTTP 响应带回结果，不会触发重复 Webhook）。
       - 若不存在 waiter（说明未传 `waitMs` 或 `waitMs` 已超时返回了 `202`），则调用 `terminalExecCallbackService.handleTaskFinished(hostId, data)` 触发异步 Webhook 投递。
   - 在 `startExecution` 中，当 `waitMs > 0` 时：
     - 在调用 `executeCmdRpc` 启动任务**前**（因为极短命令可能在 `executeCmdRpc` 返回的同时就推送了 `cmd_task_finished`），先为生成的 `taskId` 在 `this.taskWaiters` 中注册 Promise 监听。
     - 若 `executeCmdRpc` 启动失败，立即清理 `taskWaiters.delete(taskId)` 并返回错误。
     - 若启动成功，等待 `Promise.race([finishPromise, sleepTimeout(waitMs)])`：
       - **情况 A（在 `waitMs` 内收到完成事件 `finishedData`）**：
         - 清理 `taskWaiters` 和定时器；
         - 返回包含完整执行结果的对象（控制器据此返回 **`200 OK`**）：
           ```json
           {
             "success": true,
             "completed": true,
             "taskId": "task-...",
             "hostId": "node-1",
             "command": "...",
             "cwd": "...",
             "status": "completed",
             "exitCode": 0,
             "stdout": "...",
             "stderr": "...",
             "output": "...",
             "totalBytes": 12,
             "durationMs": 45,
             "startTime": 1762848000000,
             "endTime": 1762848000045,
             "callbackRegistered": false,
             "callbackSkippedReason": "completed_within_wait"
           }
           ```
           （注：仅当请求传入了 `callback` 时附带 `callbackRegistered: false, callbackSkippedReason: 'completed_within_wait'`）。
       - **情况 B（超过 `waitMs` 仍未完成）**：
         - 从 `this.taskWaiters` 移除该 `taskId`；
         - 若请求携带了 `options.callback`，此时调用 `terminalExecCallbackService.registerCallback(...)` 注册异步 Webhook 回调；
         - 返回 `status: 'running', completed: false`（控制器据此返回 **`202 Accepted`**，若带了 `callback` 则 `callbackRegistered: true`）。

---

### 2.5 统一 JSON 响应信封（问题 5 优化）

在保留原有全部平铺字段的前提下，为以下接口补齐顶层 `success: boolean`：

1. **`src/terminal/controllers/terminalHostController.ts`**：
   - `getHosts` 返回 `{ success: true, hosts, timezone, serverStartTime, serverUptimeMs }`
   - `getVersion` 返回 `{ success: true, ...getVersionInfo(), timezone }`
2. **`src/terminal/controllers/terminalLogController.ts`**：
   - `getTerminalLogs`（非 SSE JSON 分支）返回 `{ success: true, logs: terminalLogService.getHistory() }`
3. **`src/terminal/routes/proxyRoutes.ts`**：
   - `proxyAuthMiddleware` 401 响应：`{ success: false, error: 'Unauthorized: Invalid x-admin-key or proxy session' }`
   - `GET /:hostId/ports`：成功返回 `{ success: true, ports: result.ports || [] }`，失败返回 `{ success: false, error: ... }`
   - `GET /:hostId/speedtest/ping`：成功返回 `{ success: true, hubAgentRttMs: ..., timestamp: ... }`，失败返回 `{ success: false, error: ... }`
   - `POST /:hostId/speedtest/probe`：成功返回 `{ success: true, results: result.results || [] }`，失败返回 `{ success: false, error: ... }`
   - `/:hostId/port/:port` 与 `/:hostId/request` 的参数校验 400 错误响应：统一包含 `success: false`。

---

## 3. 测试与验证计划

1. **新增专项测试套件 `tests/terminalApiOptimization.test.ts`**：
   - **问题 1 测试**：验证 `/api/terminal/files/:hostId/*` Path 路由别名，以及在 `/api/terminal/files/save`、`/mkdir`、`/rename`、`/list`、`/delete` 中分别通过 Path、Query、Body 传 `hostId` 均能正常响应。
   - **问题 2 测试**：验证 `mapRpcErrorToHttpStatus` 及各 Controller 在节点离线时一致返回 `503`、RPC 超时返回 `504`、权限拒绝/路径越界返回 `403`、目标不存在返回 `404`、参数非法返回 `400`。
   - **问题 3 测试**：
     - 验证 `encodeControlJsonPacket` / `decodeControlJsonPacket` 与 `BIN_MSG_TYPE.CONTROL_JSON (0x08)` 在 WebSocket 上的收发；
     - 验证以 `'JSON:'` 开头但非合法控制帧的普通文本（如 `'JSON: user typed this\n'`）不会被吞掉，而是正常进入终端历史缓冲与输出流；
     - 验证当 Agent 断开时调用 `rpcDispatcher.executeCmdRpc` / `executeFileRpc` 不会往 `session.pendingInputBuffer` 写入任何垃圾数据。
   - **问题 4 测试**：
     - 验证 `POST /api/terminal/exec/:hostId` 传入 `waitMs: 3000` 执行快速命令时直接返回 `200 OK` 及完整输出，且当同时传入 `callback` 时不触发重复 Webhook（`callbackRegistered: false, callbackSkippedReason: 'completed_within_wait'`）；
     - 验证当命令耗时超过 `waitMs`（如 `waitMs: 100` 执行 `sleep 0.5`）时，先返回 `202 Accepted (completed: false, callbackRegistered: true)`，随后命令结束时自动触发 Webhook 回调；
     - 验证传入 `scriptName` + `scriptArgs`（以及同时带自定义 `stdin`）直接执行 Hub 脚本库中的脚本并返回正确输出，脚本不存在时返回 `404`。
   - **问题 5 测试**：验证 `/api/terminal/hosts`、`/api/terminal/version`、`/api/terminal/logs`、`/api/proxy/:hostId/ports` 均包含 `success: true/false` 字段且保留原有平铺属性。
2. **全量回归测试**：
   - 运行既有测试套件与 `npm run build`，确保零回归。
