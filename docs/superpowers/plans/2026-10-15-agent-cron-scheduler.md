# Agent 定时执行脚本功能实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 gt-hub 构建基于 Agent 本地守护进程的分布式定时任务调度（Cron）系统，支持 Hub 中心化管理、离线边缘自主调度、Hub 托管脚本缓存与直接 Shell 命令执行，以及完整的 `gt cron` CLI 命令集。

**Architecture:** 
采用“中心分发 + 本地自主运行（Hybrid 模式）”。定义统一的 `CronJobConfig` 与 `CronExecutionRecord` 模型；在 shared 层提供自研轻量级 5 字段 Cron 表达式解析器与下次触发时间计算器（零重量依赖，保证打包独立性）；在 Agent 守护进程中嵌入 `AgentCronScheduler`，基于 `TaskManager` 派生执行并默认执行重叠跳过（`forbid` 并发保护）；在 Hub 端建立 `TerminalCronService` 管理持久化配置并挂载 REST API 及 WebSocket 隧道同步机制；在客户端实现 `gt cron ls|add|rm|pause|resume|run|logs` 命令行工具。

**Tech Stack:** TypeScript, Node.js (fs, path, child_process, crypto, os), WebSocket (ws / custom adapter), Express, Commander.js, Jest.

**Spec:** `docs/superpowers/specs/2026-10-15-agent-cron-scheduler-design.md`

## Global Constraints

- 调度器语法支持标准 5 字段 Cron 表达式（`分 时 日 月 星期`），步进 `*/n`、范围 `a-b`、列表 `a,b`、通配符 `*`。
- CLI 顶级命令名为 `gt cron`（含 `ls`, `add`, `rm`, `pause`, `resume`, `run`, `logs`）。
- 默认并发重叠策略为 `concurrency: 'forbid'`。若上一周期未执行完毕，本次标记为 `skipped` 并记录警告，不派生重复进程。
- Hub 端持久化路径为 `~/.gt/cron/<nodeId>.json`；Agent 端持久化路径为 `~/.gt/cron.json`，缓存路径为 `~/.gt/scripts/cache/<scriptName>`。
- 遵循零第三方重型包原则：Cron 解析器与调度器均自研轻量实现，便于 esbuild 单文件打包 `dist/gt.js`。

## Review Focus

- **非法 Cron 字段越界**（例如分钟设为 60、月份设为 13、负数或格式不规范）：解析器必须抛出明确错误并阻止保存，避免死循环或定时器崩溃。
- **跨日/跨月/跨年时间计算**（例如 `0 2 * * *` 在 23:59 触发计算，或 `0 0 1 1 *` 跨年）：下次计算必须跨过月末/年末且不发生溢出。
- **长时间运行任务重叠触发**：当任务执行时间超过 Cron 周期，下一次触发必须被判定为 `skipped`，不得产生二次并发进程。
- **离线与断连自愈**：Agent 在无 Hub 连线时依然正常触发调度；Hub 发送 `cron_sync` 后 Agent 能原子替换本地配置并刷新定时器。
- **Hub 托管脚本不存在或拉取失败**：任务应优雅失败并记录清晰错误，Agent 守护进程绝不崩溃退出。

---

### Task 1: 共享类型定义与 Cron 表达式解析器 (Types & Cron Parser)

**Files:**
- Create: `src/shared/types/cron.ts`
- Create: `src/shared/utils/cronParser.ts`
- Test: `tests/cronParser.test.ts`

**Interfaces:**
- Produces:
  - `CronJobConfig`, `CronExecutionRecord`, `CronJobSummary`, `CronConcurrencyPolicy`, `CronJobStatus`, `CronScriptSource` in `src/shared/types/cron.ts`
  - `parseCronExpression(expr: string): ParsedCron`
  - `getNextCronTime(expr: string, fromDate?: Date): Date`
  - `isValidCronExpression(expr: string): boolean`

- [x] **Step 1: 编写 Cron 表达式解析器与类型定义的失败测试**

编写 `tests/cronParser.test.ts`，涵盖：
1. 正常 5 字段解析（如 `*/15 * * * *`, `0 2 * * *`, `30 4 1,15 * 1-5`）
2. 非法字段拦截（如 6 字段、越界数字 `60 * * * *`、字母乱码）
3. 计算下一次触发时间 `getNextCronTime`（精确分钟、跨小时、跨天）

```typescript
// tests/cronParser.test.ts
import { parseCronExpression, getNextCronTime, isValidCronExpression } from '../src/shared/utils/cronParser';

describe('Cron Parser Utility', () => {
  it('validates standard 5-part cron expressions', () => {
    expect(isValidCronExpression('* * * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(isValidCronExpression('0 2 * * *')).toBe(true);
    expect(isValidCronExpression('0 0 1 1 *')).toBe(true);
    expect(isValidCronExpression('invalid')).toBe(false);
    expect(isValidCronExpression('* * * * * *')).toBe(false); // 6 fields
    expect(isValidCronExpression('60 * * * *')).toBe(false); // minute out of range
  });

  it('calculates the next run timestamp accurately', () => {
    // 2026-10-15 10:00:00
    const base = new Date('2026-10-15T10:00:00.000Z');
    
    // Every 5 minutes -> next is 10:05:00
    const next5 = getNextCronTime('*/5 * * * *', base);
    expect(next5.toISOString()).toBe('2026-10-15T10:05:00.000Z');

    // Daily at 02:00 -> next is 2026-10-16 02:00:00
    const nextDaily = getNextCronTime('0 2 * * *', base);
    expect(nextDaily.toISOString()).toBe('2026-10-16T02:00:00.000Z');
  });

  it('handles month end / year end rollover', () => {
    const dec31 = new Date('2026-12-31T23:55:00.000Z');
    const nextYear = getNextCronTime('0 0 1 1 *', dec31);
    expect(nextYear.getFullYear()).toBe(2027);
    expect(nextYear.getMonth()).toBe(0);
    expect(nextYear.getDate()).toBe(1);
  });
});
```

- [x] **Step 2: 运行测试以确认失败**

运行：`npx jest tests/cronParser.test.ts --detectOpenHandles --forceExit`
预期：FAIL（文件未找到或模块未定义）

- [x] **Step 3: 实现数据结构定义与轻量 Cron 解析器**

创建 `src/shared/types/cron.ts`：
```typescript
export type CronConcurrencyPolicy = 'forbid' | 'allow';
export type CronJobStatus = 'active' | 'paused';
export type CronScriptSource = 'hub' | 'command';

export interface CronJobConfig {
  id: string;
  name: string;
  cron: string;
  source: CronScriptSource;
  command?: string;
  scriptName?: string;
  scriptArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  concurrency: CronConcurrencyPolicy;
  status: CronJobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CronExecutionRecord {
  executionId: string;
  jobId: string;
  jobName: string;
  triggerTime: number;
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'timeout';
  exitCode: number | null;
  error?: string | null;
  durationMs?: number;
}

export interface CronJobSummary extends CronJobConfig {
  nextRunTime: number | null;
  lastExecution?: CronExecutionRecord | null;
}
```

创建 `src/shared/utils/cronParser.ts`：
包含 5 个维度（分钟 0-59、小时 0-23、日期 1-31、月份 1-12、星期 0-7 其中 0 和 7 均为周日）的匹配规则生成，以及由指定 `fromDate` 逐步向前搜索下一个匹配分钟的自增算法（带防卡死最大步数上限 525600 分钟/1年）。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/cronParser.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/shared/types/cron.ts src/shared/utils/cronParser.ts tests/cronParser.test.ts
git commit -m "feat(cron): add cron types and lightweight 5-part cron parser"
```

---

### Task 2: Agent 端本地定时任务调度器 (AgentCronScheduler)

**Files:**
- Create: `src/agent/cron/cronScheduler.ts`
- Modify: `src/agent/index.ts`
- Test: `tests/cronScheduler.test.ts`

**Interfaces:**
- Consumes:
  - `CronJobConfig`, `CronExecutionRecord` from `src/shared/types/cron.ts`
  - `getNextCronTime`, `isValidCronExpression` from `src/shared/utils/cronParser.ts`
  - `taskManager` from `src/agent/tasks/taskManager.ts`
- Produces:
  - `export class AgentCronScheduler`:
    - `constructor(options?: { storageFile?: string; cacheDir?: string; getScriptContent?: (name: string) => Promise<string> })`
    - `start(): void`
    - `stop(): void`
    - `syncJobs(jobs: CronJobConfig[]): void`
    - `getJobs(): CronJobConfig[]`
    - `getSummaries(): CronJobSummary[]`
    - `getExecutionHistory(jobId?: string, limit?: number): CronExecutionRecord[]`
    - `triggerJob(jobId: string): Promise<CronExecutionRecord>`
    - `onReport(callback: (record: CronExecutionRecord) => void): void`

- [x] **Step 1: 编写调度器与并发重叠保护的单元测试**

编写 `tests/cronScheduler.test.ts`：
1. 测试配置的本地持久化读取与写入
2. 测试 `syncJobs` 后定时器调度计划的更新
3. 测试 `concurrency: 'forbid'` 时，若前一次任务处于 `running` 状态，重复触发自动被���为 `skipped` 并生成对应的 `CronExecutionRecord`
4. 测试 Hub 托管脚本缓存写入与直接命令执行

- [x] **Step 2: 运行测试以确认失败**

运行：`npx jest tests/cronScheduler.test.ts --detectOpenHandles --forceExit`
预期：FAIL（模块不存在）

- [x] **Step 3: 实现 `AgentCronScheduler`**

在 `src/agent/cron/cronScheduler.ts` 中实现：
1. 本地存储：管理 `~/.gt/cron.json` 和 `~/.gt/schedule/history.json`（限制最多保留 100 条历史记录）。
2. 定时主循环：维护 `activeTimers: Map<string, NodeJS.Timeout>`，每个任务基于 `getNextCronTime` 设置下一次运行。
3. 触发与重叠判断：
   - 检查任务是否 `paused`；
   - 检查同 `jobId` 的上一个 `executionId` 在 `taskManager` 中是否仍在执行。若仍在执行且 `concurrency === 'forbid'`，生成 `skipped` 记录并触发 `onReport` 监听。
4. 执行与脚本缓存：
   - 若 `source === 'hub'`，检查 `~/.gt/scripts/cache/<scriptName>`，若不存在则调用拉取接口或 fallback，赋予执行权限后派生；
   - 若 `source === 'command'`，直接调用 `taskManager.startTask`；
   - 监听任务完成事件，写入执行记录历史并向外界（Hub 上报回调）派发。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/cronScheduler.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/agent/cron/cronScheduler.ts src/agent/index.ts tests/cronScheduler.test.ts
git commit -m "feat(agent): implement AgentCronScheduler with local persistence and concurrency protection"
```

---

### Task 3: Agent 守护进程集成与 WebSocket 协议扩展 (Agent Daemon Integration)

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `src/agent/handlers/cmdExecHandler.ts`
- Test: `tests/agentCronIntegration.test.ts`

**Interfaces:**
- Consumes:
  - `AgentCronScheduler` from `src/agent/cron/cronScheduler.ts`
- Produces:
  - Agent 在建立 `agent-ws` 隧道后响应 `cron_sync`、`cron_trigger`、`cron_list` 指令
  - Agent 执行完成时向上发送 `JSON:{"type":"cron_report","record":{...}}`

- [x] **Step 1: 编写 Agent Daemon 与 WebSocket 通信的集成测试**

在 `tests/agentCronIntegration.test.ts` 中模拟 WebSocket 连接，下发 `cron_sync` 并断言 Agent 能够接收并持久化，手动发送 `cron_trigger` 能够触发执行并通过 WS 返回 `cron_report`。

- [x] **Step 2: 运行测试以确认失败**

运行：`npx jest tests/agentCronIntegration.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 修改 `src/agent/daemon.ts` 与相关 Handler**

在 `AgentDaemon` 中初始化 `cronScheduler`：
- 启动守护进程时调用 `cronScheduler.start()`，退出时调用 `cronScheduler.stop()`；
- 当 WS 连接成功握手后，向 Hub 发送本地任务状态或者注册 `cronScheduler.onReport(record => sendWsMessage({ type: 'cron_report', record }))`；
- 在接收控制消息中分发 `cron_sync`、`cron_trigger`，并返回处理状态。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/agentCronIntegration.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/agent/daemon.ts src/agent/handlers/cmdExecHandler.ts tests/agentCronIntegration.test.ts
git commit -m "feat(agent): integrate cron scheduler into AgentDaemon with ws event sync"
```

---

### Task 4: Hub 端持久化服务与 REST API 路由 (TerminalCronService & API Routes)

**Files:**
- Create: `src/terminal/services/terminalCronService.ts`
- Create: `src/terminal/controllers/terminalCronController.ts`
- Modify: `src/terminal/routes/terminalRoutes.ts`
- Modify: `src/terminal/services/terminalHostManager.ts`
- Test: `tests/terminalCronApi.test.ts`

**Interfaces:**
- Produces:
  - `TerminalCronService` 提供：
    - `getJobs(nodeId: string): Promise<CronJobSummary[]>`
    - `addJob(nodeId: string, jobData: Partial<CronJobConfig>): Promise<CronJobConfig>`
    - `removeJob(nodeId: string, jobId: string): Promise<boolean>`
    - `updateJob(nodeId: string, jobId: string, updates: Partial<CronJobConfig>): Promise<CronJobConfig>`
    - `triggerJob(nodeId: string, jobId: string): Promise<boolean>`
    - `recordExecution(nodeId: string, record: CronExecutionRecord): Promise<void>`
  - REST Endpoints under `/api/terminal/cron/:nodeId`

- [x] **Step 1: 编写 Hub 端 Cron 管理 API 测试**

编写 `tests/terminalCronApi.test.ts`：
1. `GET /api/terminal/cron/:nodeId` 获取空列表与已有任务列表
2. `POST /api/terminal/cron/:nodeId` 新增定时任务（测试合法性校验及重复 ID 拦截）
3. `PATCH /api/terminal/cron/:nodeId/:jobId` 暂停与恢复
4. `DELETE /api/terminal/cron/:nodeId/:jobId` 删除任务
5. 测试在线节点时通过 `TerminalHostManager` 向对应 Agent 推送 `cron_sync` 消息

- [x] **Step 2: 运行测试以确认失败**

运行：`npx jest tests/terminalCronApi.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 实现 `TerminalCronService` 与控制器路由**

1. `src/terminal/services/terminalCronService.ts`：以 JSON 文件存储于 `~/.gt/cron/<nodeId>.json`，同步调用 `terminalHostManager` 向对应 Host 发送 WS 消息。
2. `src/terminal/controllers/terminalCronController.ts`：Express 控制器，处理参数校验与统一错误响应。
3. `src/terminal/routes/terminalRoutes.ts`：挂载 `/cron/:nodeId` 相关路由，受统一的 `adminAuthMiddleware` 保护。
4. `src/terminal/services/terminalHostManager.ts`：在接收 Agent 消息时支持处理 `cron_report`，交由 `terminalCronService.recordExecution` 持久化。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/terminalCronApi.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务��码**

```bash
git add src/terminal/services/terminalCronService.ts src/terminal/controllers/terminalCronController.ts src/terminal/routes/terminalRoutes.ts src/terminal/services/terminalHostManager.ts tests/terminalCronApi.test.ts
git commit -m "feat(hub): add TerminalCronService and REST endpoints for cron job management"
```

---

### Task 5: CLI 客户端交互命令 (`gt cron`) 实现

**Files:**
- Create: `src/client/commands/cron.ts`
- Modify: `src/client/index.ts`
- Modify: `src/bin/gt.ts`
- Test: `tests/gtCronCommand.test.ts`

**Interfaces:**
- Produces:
  - `handleCronLs({ server, key, node, json, format })`
  - `handleCronAdd({ server, key, node, name, cron, cmd, script, args, cwd, timeout, concurrency })`
  - `handleCronRm({ server, key, node, jobId })`
  - `handleCronPause({ server, key, node, jobId })`
  - `handleCronResume({ server, key, node, jobId })`
  - `handleCronRun({ server, key, node, jobId })`
  - `handleCronLogs({ server, key, node, jobId, tail, follow })`
  - 挂载至 `gt` 根命令: `gt cron <subcommand>`

- [x] **Step 1: 编写 CLI 命令单元与集成测试**

编写 `tests/gtCronCommand.test.ts`：
1. 验证 `gt cron --help` 输出包含完整子命令说明
2. 模拟 Hub API 响应，验证 `gt cron ls <node>` 表格输出对齐与 `--json` 格式
3. 验证 `gt cron add` 参数校验（`--cmd` 或 `--script` 必须提供其一，Cron 格式错误立即报错）
4. 验证 `gt cron rm`、`gt cron pause`、`gt cron resume`、`gt cron run` 的调用与输出

- [x] **Step 2: 运行测试以确认失败**

运行：`npx jest tests/gtCronCommand.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 实现 `src/client/commands/cron.ts` 并注册到 Commander**

1. 在 `src/client/commands/cron.ts` 中实现各子命令的处理函数，支持节点名称解析（`resolveHost`）、相对时间格式化（`formatRelativeTime`）、Docker 模板格式化（`formatTemplate`）。
2. 在 `src/client/index.ts` 的 `createProgram()` 中添加 `program.command('cron')`，并注册其子命令。
3. 在 `src/bin/gt.ts` 中导出相关新函数，并确保打包脚本 `npm run build:gt` 能正确打包。

- [x] **Step 4: 运行测试验证通过**

运行：`npm run build:gt && npx jest tests/gtCronCommand.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/client/commands/cron.ts src/client/index.ts src/bin/gt.ts tests/gtCronCommand.test.ts
git commit -m "feat(cli): add gt cron command suite for scheduling job management"
```

---

### Task 6: 端到端集成验证与构建流水线测试 (E2E Integration & Verification)

**Files:**
- Create: `tests/cronE2E.test.ts`
- Modify: `package.json` (如有需要)

- [x] **Step 1: 编写完整的端到端集成测试**

编写 `tests/cronE2E.test.ts`：
1. 启动轻量 Hub HTTP/WebSocket 服务器
2. 启动一个真实的虚拟 Agent 实例连接至该 Hub
3. 通过 CLI / 请求添加一个每分钟触发的定时任务 `* * * * *`（执行 `echo "cron works"`）
4. 手动调用 `gt cron run` 触发执行
5. 验证执行记录已上报给 Hub，并通过 `gt cron logs` 或 `task ls` 能够查看到标准输出包含 `"cron works"`
6. 验证任务暂停、恢复与删除后，Agent 本地定时器同步响应

- [x] **Step 2: 运行端到端测试**

运行：`npm run build:gt && npx jest tests/cronE2E.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 3: 运行代码检查与全量构建**

运行：
1. `npm run lint` 或 `npx eslint src/`
2. `npm run build`
3. 确保所有输出文件完整无错误。

- [x] **Step 4: 提交任务代码**

```bash
git add tests/cronE2E.test.ts
git commit -m "test(cron): add end-to-end integration test for cron scheduler"
```
