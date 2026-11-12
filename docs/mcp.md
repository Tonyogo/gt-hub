# gt-hub Model Context Protocol (MCP) 使用指南

`gt-hub` 原生支持 **Model Context Protocol (MCP)**，将集群纳管、远程命令执行、文件管理与分布式定时任务等能力以标准化的方式开放给大模型（LLM）与 AI Agent。

---

## 目录
- [一、核心特性](#一核心特性)
- [二、支持的 17 个 MCP 工具清单](#二支持的-17-个-mcp-工具清单)
- [三、客户端配置指南](#三客户端配置指南)
  - [1. Claude Desktop（桌面应用）](#1-claude-desktop桌面应用)
  - [2. Claude Code（命令行 Agent）](#2-claude-code命令行-agent)
  - [3. Cursor（AI 编辑器）](#3-cursorai-编辑器)
  - [4. 云端 Agent / HTTP 模式接入](#4-云端-agent--http-模式接入)
- [四、安全护栏配置](#四安全护栏配置)
  - [1. 只读安全模式 (`--read-only`)](#1-只读安全模式---read-only)
  - [2. 节点白名单限制 (`--nodes`)](#2-节点白名单限制---nodes)
  - [3. 上下文切换 (`-c, --context`)](#3-上下文切换--c---context)
  - [4. 输出防撑爆截断 (`--max-output`)](#4-输出防撑爆截断---max-output)
- [五、与大模型日常交互示例](#五与大模型日常交互示例)

---

## 一、核心特性

1. **双传输协议支持**：
   - **本地 Stdio 模式（`gt mcp`）**：单文件打包无外部重依赖，基于标准输入/输出通信，极速响应，适合本地 Claude Desktop / Cursor / Claude Code。
   - **远程 HTTP 模式（`/api/terminal/mcp`）**：基于 Express 服务端内存直调，受 `adminAuthMiddleware` 保护，无需在客户端安装 CLI，适合云端 Agent 平台（如 Dify、FastGPT、n8n、飞书/企微 Bot）。
2. **多环境无缝切换**：直接复用本地 `~/.gt/config.json` 多 Context 配置（通过 `-c <context>`）。
3. **输出防撑爆保护**：内置 `maxOutputChars` 字符截断，防止大文件内容或海量任务日志挤占大模型上下文窗口，并附带分页 `offset` 提示。
4. **智能节点匹配**：支持精确匹配节点 ID、大小写不敏感的主机名称（name），以及唯一前缀模糊解析（遇多节点重名前缀自动报错拦截，避免误操作）。

---

## 二、支持的 17 个 MCP 工具清单

| 领域分类 | 工具名称 (`Tool Name`) | 只读 (`readOnly`) | 功能说明与核心参数 |
| :--- | :--- | :---: | :--- |
| **节点管理<br>(Nodes)** | `gt_list_nodes` | ✅ | 查询 Hub 纳管的节点列表。<br>参数：`all` (boolean, 是否包含离线机器) |
| **命令与任务<br>(Exec/Tasks)** | `gt_exec` | ❌ | 在指定节点执行 Shell 命令。<br>参数：`node`, `command`, `cwd`, `env`, `stdin`, `timeoutMs`, `waitMs`, `detach` |
| | `gt_task_list` | ✅ | 查询节点最近执行的任务列表。<br>参数：`node`, `limit` (默认 20 条) |
| | `gt_task_status` | ✅ | 查询指定任务的运行状态、退出码与增量输出日志。<br>参数：`node`, `taskId`, `offset` |
| | `gt_task_kill` | ❌ | 终止节点上正在运行的后台任务。<br>参数：`node`, `taskId`, `signal` (默认 SIGTERM) |
| **远程文件<br>(Files)** | `gt_list_files` | ✅ | 浏览节点指定路径下的文件/目录列表。<br>参数：`node`, `path` |
| | `gt_read_file` | ✅ | 读取远程文本文件内容（支持分页切片与二进制检测）。<br>参数：`node`, `path`, `offset`, `limit` |
| | `gt_write_file` | ❌ | 写入或覆盖远程节点的文件内容。<br>参数：`node`, `path`, `content` |
| | `gt_mkdir` | ❌ | 在指定目录下新建远程文件夹。<br>参数：`node`, `path`, `dirName` |
| | `gt_delete_file` | ❌ | 删除远程节点指定文件或目录。<br>参数：`node`, `path` |
| | `gt_rename_file` | ❌ | 重命名或移动远程节点文件/文件夹。<br>参数：`node`, `oldPath`, `newPath` |
| **分布式 Cron<br>(Cron)** | `gt_cron_list` | ✅ | 查询节点所有定时任务。<br>参数：`node` |
| | `gt_cron_add` | ❌ | 在节点创建新的定时任务。<br>参数：`node`, `name`, `cron`, `command`, `cwd`, `timeoutMs`, `concurrency`, `paused` |
| | `gt_cron_update` | ❌ | 修改定时任务配置（支持修改状态 `paused` / `active`、表达式、命令等）。<br>参数：`node`, `jobId`, `status`, `cron`, `command` 等 |
| | `gt_cron_delete` | ❌ | 删除节点上的指定定时任务。<br>参数：`node`, `jobId` |
| | `gt_cron_run` | ❌ | 立即手动触发执行一次指定定时任务。<br>参数：`node`, `jobId` |
| | `gt_cron_logs` | ✅ | 查看定时任务历史执行日志。<br>参数：`node`, `jobId`, `offset` |

---

## 三、客户端配置指南

### 1. Claude Desktop（桌面应用）

1. 打开 Claude Desktop 的配置文件：
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
2. 添加 `gt-hub` 服务定义：
   ```json
   {
     "mcpServers": {
       "gt-hub": {
         "command": "gt",
         "args": ["mcp"]
       }
     }
   }
   ```
   > 若 `gt` 未加进全局系统环境变量，可使用绝对路径（如 `/usr/local/bin/gt`）或使用 `node` 执行编译出的产物：
   > ```json
   > {
   >   "command": "node",
   >   "args": ["/Users/yourname/github/gt-hub/dist/gt.js", "mcp"]
   > }
   > ```
3. **重启 Claude Desktop**。在输入框右下方可看到 🔨 图标，展开即可看到全部 17 个可用工具。

---

### 2. Claude Code（命令行 Agent）

在终端中使用 Claude Code CLI 时，只需一条命令即可添加：

```bash
# 全局添加当前环境的 gt mcp
claude mcp add gt-hub -- gt mcp

# 或为当前代码工程添加（写入当前目录 .claude/settings.json）
claude mcp add --scope project gt-hub -- gt mcp
```

查看已注册的 MCP 服务状态：
```bash
claude mcp list
```

---

### 3. Cursor（AI 编辑器）

1. 打开 Cursor 设置：`Settings` -> `Features` -> `MCP`。
2. 点击 **+ Add New MCP Server**。
3. 输入参数：
   - **Name**: `gt-hub`
   - **Type**: `command`
   - **Command**: `gt mcp`
4. 点击添加，刷新后看到绿色指示灯即表示就绪。在 Cursor Composer 或 Agent 模式中可自动调用。

---

### 4. 云端 Agent / HTTP 模式接入

适用于无本地环境的云端 Agent 平台（如 Dify、FastGPT、n8n、飞书/企微机器人）：

- **HTTP Endpoint**: `POST http://<hub-ip>:8000/api/terminal/mcp`
- **鉴权 Header**: `x-admin-key: <your-gt-key>` 或 `Authorization: Bearer <your-gt-key>`
- **健康检查**: `GET http://<hub-ip>:8000/api/terminal/mcp`
- **调用示例**:
  ```bash
  # 查询当前可用工具清单
  curl -s -X POST http://localhost:8000/api/terminal/mcp \
    -H "x-admin-key: your-admin-key" \
    -H "Content-Type: application/json" \
    -d '{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "tools/list"
    }'
  ```

---

## 四、安全护栏配置

针对线上生产环境，推荐通过参数启用安全护栏：

### 1. 只读安全模式 (`--read-only`)
只暴露 7 个查询类工具，彻底隐藏并拦截任何文件写入、命令执行和定时任务修改能力：
```json
{
  "mcpServers": {
    "gt-hub-readonly": {
      "command": "gt",
      "args": ["mcp", "--read-only"]
    }
  }
}
```
*HTTP 模式对应 Header*: `x-mcp-readonly: true`（或 Query `?readOnly=true`）。

### 2. 节点白名单限制 (`--nodes`)
限制大模型只能感知并操作指定的机器（支持 ID 或主机名，以逗号分隔）：
```json
{
  "mcpServers": {
    "gt-hub-dev": {
      "command": "gt",
      "args": ["mcp", "--nodes", "test-web-1,dev-docker"]
    }
  }
}
```
*HTTP 模式对应 Header*: `x-mcp-nodes: test-web-1,dev-docker`（或 Query `?nodes=test-web-1,dev-docker`）。

### 3. 上下文切换 (`-c, --context`)
指定连接哪个 Hub 实例（对应 `gt config get-contexts` 中的配置）：
```json
{
  "mcpServers": {
    "gt-hub-staging": {
      "command": "gt",
      "args": ["mcp", "-c", "staging"]
    }
  }
}
```

### 4. 输出防撑爆截断 (`--max-output`)
单次输出最大字符数（默认 32768，约 8k~10k tokens）：
```json
{
  "mcpServers": {
    "gt-hub": {
      "command": "gt",
      "args": ["mcp", "--max-output", "16384"]
    }
  }
}
```

---

## 五、与大模型日常交互示例

配置完成后，在大模型客户端中无需记忆任何 CLI 命令，直接用自然语言交流即可：

### 1. 集群健康巡检
> **你**：“帮我查看当前集群有哪些在线节点？操作系统各是什么？”  
> 🤖 **大模型**：调用 `gt_list_nodes({ all: false })`，解析返回的节点列表，并按表格整理回复给你。

### 2. 故障排查与诊断
> **你**：“在 prod-web-1 机器上查看下 nginx 进程是否正常，并检查下根目录磁盘使用率。”  
> 🤖 **大模型**：调用 `gt_exec({ node: "prod-web-1", command: "ps aux | grep nginx && df -h /" })`，同步返回输出并解释分析。

### 3. 日志排查
> **你**：“读取一下 node-1 机器上 `/var/log/app.log` 的最新内容，排查刚刚发生的错误原因。”  
> 🤖 **大模型**：调用 `gt_read_file({ node: "node-1", path: "/var/log/app.log" })`，阅读内容并指出异常堆栈。

### 4. 分布式定时任务运维
> **你**：“在 backup-node 机器上看一下每天有哪些定时任务？如果任务 daily-backup 处于暂停状态，帮我恢复它。”  
> 🤖 **大模型**：先调用 `gt_cron_list({ node: "backup-node" })`，定位到 `daily-backup` 的 `jobId`，再调用 `gt_cron_update({ node: "backup-node", jobId: "...", status: "active" })` 完成恢复。
