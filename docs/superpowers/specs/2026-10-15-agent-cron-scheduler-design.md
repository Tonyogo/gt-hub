# Agent 定时执行脚本功能设计规范 (Design Spec)

- **Date:** 2026-10-15
- **Author:** AI Assistant & yatao
- **Status:** Approved Draft

---

## 1. 目标与背景 (Goals & Background)

在分布式节点管理与运维中，通常需要目标 Agent 定期执行某些脚本或命令（例如数据库备份、系统健康巡检、临时缓存清理、指标聚合上报等）。
目前 `gt-hub` 已经具备 Hub 服务端的 `ScriptService`（支持托管各种解释器的脚本）以及 Agent 端的 `TaskManager`（管理单个任务的运行、输出缓冲与终止）。

本设计的核心目标是：
1. **统一管控与持久化 (Centralized Configuration)**：在 Hub 与 CLI 层面提供统一的任务编排管理能力（`gt cron`）。
2. **边缘自主调度 (Edge Autonomous Execution)**：Agent 本地运行内置 Cron 调度器，即使与 Hub 断开连接或网络故障，仍能自主按时触发定时任务，网络恢复后向 Hub 上报运行记录。
3. **混合脚本源支持 (Hybrid Script Sources)**：支持执行 Hub 托管并自动缓存同步的脚本文件，以及直接在目标节点上执行的 Shell 命令。
4. **重叠保护与任务隔离 (Overlap Protection)**：支持标准 5 字段 Cron 表达式，默认具备重叠保护（若上一周期尚未退出则跳过本次执行），基于已有的 `TaskManager` 进行进程生命周期与日志管理。

---

## 2. 系统架构与数据模型 (Architecture & Data Model)

### 2.1 整体架构

```
┌────────────────────────────────────────────────────────┐
│                        gt CLI                          │
│   gt cron ls | add | rm | pause | resume | run | logs  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP REST API
                            ▼
┌────────────────────────────────────────────────────────┐
│                        gt Hub                          │
│   ┌────────────────────────────────────────────────┐   │
│   │ TerminalCronService: 任务持久化 (~/.gt/cron/)   │   │
│   │ ScriptService: 脚本仓库 (~/.gt/scripts/)        │   │
│   └───────────────────────┬────────────────────────┘   │
└───────────────────────────┼────────────────────────────┘
                            │ WebSocket (agent-ws 隧道)
                            │ cron_sync / cron_report
                            ▼
┌────────────────────────────────────────────────────────┐
│                      Agent 节点                        │
│   ┌────────────────────────────────────────────────┐   │
│   │ AgentCronScheduler (内置定时器 & 下次时间计算) │   │
│   │ 本地配置持久化 (~/.gt/cron.json)                │   │
│   │ 脚本离线缓存 (~/.gt/scripts/cache/)            │   │
│   └───────────────────────┬───────────���────────────┘   │
│                           │ 启动执行
│                           ▼
│   ┌────────────────────────────────────────────────┐   │
│   │ TaskManager: 进程树管理、超时杀死、输出缓冲     │   │
│   └────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

### 2.2 数据模型定义 (`src/shared/types/cron.ts`)

```typescript
export type CronConcurrencyPolicy = 'forbid' | 'allow';
export type CronJobStatus = 'active' | 'paused';
export type CronScriptSource = 'hub' | 'command';

export interface CronJobConfig {
  id: string;                          // 任务唯一ID，如 "cron_7f8a9b"
  name: string;                        // 用户可读名称，如 "db-backup"
  cron: string;                        // 标准 5 字段 cron，如 "0 2 * * *"
  source: CronScriptSource;            // 'hub' | 'command'
  command?: string;                    // 当 source='command' 时指定的 shell 命令行
  scriptName?: string;                 // 当 source='hub' 时在 Hub 注册的脚本名称
  scriptArgs?: string[];               // 脚本参数列表
  cwd?: string;                        // 工作目录（支持 ~ 展开）
  env?: Record<string, string>;        // 附加环境变量
  timeoutMs?: number;                  // 超时时间（毫秒，0 或未设表示不超时）
  concurrency: CronConcurrencyPolicy; // 默认 'forbid'
  status: CronJobStatus;               // 'active' | 'paused'
  createdAt: number;
  updatedAt: number;
}

export interface CronExecutionRecord {
  executionId: string;                 // 对应 taskManager 的 taskId，如 "cron_7f8a9b_1710000000"
  jobId: string;
  jobName: string;
  triggerTime: number;                 // 计划触发时间
  startTime: number;                   // 实际启动时间
  endTime: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'timeout';
  exitCode: number | null;
  error?: string | null;
  durationMs?: number;
}

export interface CronJobSummary extends CronJobConfig {
  nextRunTime: number | null;          // 下次计划执行时间戳
  lastExecution?: CronExecutionRecord | null; // 最近一次执行记录
}
```

---

## 3. 详细设计 (Detailed Design)

### 3.1 Hub 端服务与通信 (`TerminalCronService`)
1. **存储设计**：
   - 存储路径：`~/.gt/cron/<nodeId>.json`，保存对应节点的任务配置列表及最近执行记录（单任务保留最新 50 条记录）。
2. **REST API 规范**：
   - `GET /api/terminal/cron/:nodeId`：获取指定节点定时任务列表及执行摘要。
   - `POST /api/terminal/cron/:nodeId`：新增定时任务（参数校验：Cron 格式合规性、必填项、脚本存在性校验）。
   - `DELETE /api/terminal/cron/:nodeId/:jobId`：删除任务。
   - `PATCH /api/terminal/cron/:nodeId/:jobId`：更新任务状态（暂停/恢复）或修改参数。
   - `POST /api/terminal/cron/:nodeId/:jobId/run`：手动强制立即触发一次。
   - `GET /api/terminal/cron/:nodeId/:jobId/logs`：拉取指定任务的最新日志（内部转发到 taskManager 接口）。
3. **通信协议扩展**：
   - 在已建立的 `agent-ws` WebSocket 连接中下发消息包：
     - `JSON:{"type":"cron_sync","jobs":[...]}`：下发最新全量任务。
     - `JSON:{"type":"cron_trigger","jobId":"..."}`：触发手动立即执行。
   - 接收 Agent 上报消息包：
     - `JSON:{"type":"cron_report","record":{...}}`：Agent 端执行完成/跳过/超时后主动上报。

### 3.2 Agent 端边缘调度器 (`AgentCronScheduler`)
1. **生命周期与自愈**：
   - 随 Agent Daemon 启动 (`AgentDaemonManager`)，作为后台独立常驻服务启动。
   - 启动时自动从本地 `~/.gt/cron.json` 恢复任务配置，即使处于离线或断网状态也能无缝调度。
2. **轻量 Cron 调度算法**：
   - 解析 5 字段 Cron 表达式（`分 时 日 月 星期`），支持步进 `*/n`、范围 `a-b`、列表 `a,b,c` 以及通配符 `*`。
   - 计算任务下次执行时间戳（`nextRunTime`），基于按序最小时间差设置 `setTimeout`。
   - 时钟校验：每次定时器触发后，校对当前时间差，防止睡眠唤醒导致的漏执行或大量突发补偿。
3. **任务重叠策略控制**：
   - 当 `concurrency === 'forbid'` 时，检查同一 `jobId` 前次执行的 `taskId` 是否仍在 `taskManager` 中处于 `running` 状态。
   - 若前次仍在运行，则将本次触发记录为 `skipped`，记录日志并向 Hub 上报，不派生重复进程。
4. **Hub 托管脚本缓存与执行**：
   - 若 `source === 'hub'`，优先使用本地缓存 `~/.gt/scripts/cache/<scriptName>`；
   - 当收到 Hub 下发配置或缓存缺失时，通过已有 HTTP/WebSocket 协议同步脚本内容并自动设置执行权限。
   - 派生执行统一接入 `taskManager.startTask`，自动获得 stdout/stderr 分块缓冲、超时控制与进程树清理。

### 3.3 客户端交互 (`src/client/commands/cron.ts`)
提供直观易用的 `gt cron` 命令套件：
- `gt cron ls <node> [--json]`：列表展示定时任务、下次运行时间、最近运行状态及耗时。
- `gt cron add <node> --name <name> --cron "<expr>" [--cmd "<cmd>" | --script "<script>"] [--args "<args>"] [--cwd "<dir>"] [--timeout <ms>] [--concurrency forbid|allow]`：新增任务。
- `gt cron rm <node> <id|name>`：删除任务。
- `gt cron pause <node> <id|name>`：暂停任务。
- `gt cron resume <node> <id|name>`：恢复任务。
- `gt cron run <node> <id|name>`：立即手动执行一次任务。
- `gt cron logs <node> <id|name> [-f] [--tail <lines>]`：查看任务输出日志。

---

## 4. 异常处理与边界安全 (Resilience & Edge Cases)

1. **时钟异常与系统休眠唤醒**：
   采用自适应递进定时器，休眠唤醒后只调度未来的下一次执行，避免短时间内暴发性补跑积压任务。
2. **Cron 格式预检安全**：
   在 Hub 端与 CLI 端做双重正则与边界合法性验证，拒绝无效的 Cron 表达式，防止 Agent 端解析死循环或崩溃。
3. **本地磁盘与日志配额保护**：
   - 历史记录持久化采用固定容量环形队列（默认保留最近 50 次执行记录）。
   - 执行日志复用 `taskManager` 的内存限制（`MAX_BUFFER_SIZE`）和老化清理机制（`TASK_TTL_MS`）。
4. **Agent 离线与断线重连保障**：
   - 离线期间在本地执行并记录结果，连线后向 Hub 上报同步，保障定时业务连续性。

---

## 5. 验证与测试策�� (Testing Strategy)

1. **单元测试 (`tests/cronParser.test.ts`)**：
   - 验证标准 5 字段 Cron 表达式的解析、边界时间与下次运行时间戳计算。
2. **调度器与重叠保护测试 (`tests/cronScheduler.test.ts`)**：
   - 验证 `concurrency: 'forbid'` 在任务长时间占用时的正确跳过与记录生成。
   - 验证暂停、恢复、增删任务后的动态下次运行时间刷新。
3. **Hub 与通信接口测试 (`tests/terminalCron.test.ts`)**：
   - 测试 REST API 的增删改查及非法参数拦截。
   - 测试 WebSocket `cron_sync` 与 `cron_report` 消息的正确收发与落盘。
4. **CLI 集成验证**：
   - 验证 `gt cron ls`、`gt cron add`、`gt cron run`、`gt cron rm` 的终端输出排版与退出码。
