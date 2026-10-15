# 定时任务（Cron）时区支持设计规范 (Design Spec)

- **Date:** 2026-10-15
- **Author:** AI Assistant & yatao
- **Status:** Approved Draft

---

## 1. 目标与背景 (Goals & Background)

在之前的实现中，`src/shared/utils/cronParser.ts` 默认基于 `UTC` 时区进行匹配和下次运行时间计算（使用了 `getUTCHours()`, `getUTCMinutes()` 等）。这导致在非 UTC 时区（例如中国北京时间 UTC+8）的主机或使用场景中：
- 用户配置 `0 2 * * *`（期望每天凌晨 2:00 执行），实际却在 UTC 02:00（即北京时间上午 10:00）才触发。
- Web 界面和 CLI 呈现的“下次运行倒计时”与用户按本地时间心算的倒计时相差 8 个小时。

本设计的核心目标是：
1. **默认使用目标节点本地时区（Local System Time）**：当任务未指定时区时，调度器默认采用 Agent 所在机器的系统本地时区，符合传统 Linux crontab 与运维直觉。
2. **支持显式指定任意标准 IANA 时区**：在任务配置中支持指定 `timezone`（例如 `Asia/Shanghai`, `UTC`, `America/New_York` 等）。无论 Agent 部署在全球哪里的机房，任务均按该时区的钟点准时触发。
3. **零外部重量依赖**��基于 Node.js 与现代浏览器内置原生的 `Intl.DateTimeFormat` 进行时区换算与合法性校验，保证 `dist/gt.js` 单文件打包零体积膨胀。
4. **全链路对齐**：贯通共享数据模型、Cron 算法、Agent 调度执行、Hub 持久化与 REST API、CLI 命令行参数（`gt cron add --tz`）及 Web 控制台（下拉时区选择与列表标识）。

---

## 2. 详细技术方案 (Technical Design)

### 2.1 时区有效性校验与时间计算 (`src/shared/utils/cronParser.ts`)

利用原生 `Intl.DateTimeFormat` 校验时区与提取特定时区的分、时、日、月、星期：

```typescript
export function isValidTimezone(tz?: string): boolean {
  if (!tz || tz === 'local') return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
```

在 `getNextCronTime(expr: string, fromDate?: Date, timezone?: string): Date` 中：
1. **未指定时区或为 `'local'`**：
   使用 `Date` 对象的本地时区方法（`getMinutes()`, `getHours()`, `getDate()`, `getMonth()`, `getDay()` 等），按 Agent 本地时钟逐分钟递进计算下一个匹配时间点。
2. **指定了特定时区（如 `Asia/Shanghai` 或 `UTC`）**：
   使用缓存好的 `Intl.DateTimeFormat(undefined, { timeZone: timezone, ... })` 解析当前候选时间戳在目标时区下的年月日时分和星期，校验是否匹配 5 字段 Cron 规则，并返回对应的标准 `Date` 对象。

### 2.2 数据模型扩展 (`src/shared/types/cron.ts` 与前端 `types/cron.ts`)

在 `CronJobConfig` 与 `CronJobSummary` 接口中增加可选的 `timezone` 字段：

```typescript
export interface CronJobConfig {
  id: string;
  name: string;
  cron: string;
  timezone?: string;          // 可选。未设置或为 "local" 表示目标节点本地时区；也可指定如 "Asia/Shanghai", "UTC"
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
```

### 2.3 Agent 端边缘调度适配 (`src/agent/cron/cronScheduler.ts`)

- 在 Agent 调度循环中计算下一次触发时间时，调用：
  ```typescript
  const nextDate = getNextCronTime(job.cron, undefined, job.timezone);
  ```
- 在返回 `CronJobSummary` 时，基于 `job.timezone` 正确生成 `nextRunTime`。

### 2.4 Hub 端服务与 REST API 校验 (`src/terminal/services/terminalCronService.ts`)

- 在创建任务 (`POST /api/terminal/cron/:hostId`) 和更新任务 (`PATCH /api/terminal/cron/:hostId/:jobId`) 时，对客户端传入的 `timezone` 进行校验：
  - 若 `timezone` 存在且不合法，直接返回 HTTP 400：`Invalid timezone: "${timezone}"`。
  - 合法时保存到 `~/.gt/cron/<nodeId>.json`，并通过 WebSocket `cron_sync` 同步给对应 Agent。

### 2.5 CLI 命令行扩展 (`src/client/commands/cron.ts` & `src/client/index.ts`)

- 在 `gt cron add` 中新增 `--tz, --timezone <tz>` 选项：
  ```bash
  # 默认使用本地机器时区
  gt cron add srv-1 --name "daily-backup" --cron "0 2 * * *" --cmd "backup.sh"

  # 显式指定时区
  gt cron add srv-1 --name "bj-report" --cron "0 9 * * 1-5" --cmd "report.sh" --tz "Asia/Shanghai"
  ```
- 在 `gt cron ls` 输出表格中：
  - 若任务配置了自定义时区，在 CRON 列表达式旁清晰标注（例如 `0 9 * * 1-5 (Asia/Shanghai)`）。

### 2.6 Web 控制台前端页面设计

#### 1. 创建/编辑弹窗 (`CronJobModal.tsx`)
- 在 Cron 表达式输入框下方新增【执行时区】下拉与输入组合控件：
  - 默认选中：`🖥️ 节点本地时区 (默认)`
  - 常用快捷选项：
    - `🇨🇳 中国标准时间 (Asia/Shanghai, UTC+8)`
    - `🌐 协调世界时 (UTC)`
    - `🇺🇸 美国东部时间 (America/New_York)`
    - `🇯🇵 日本标准时间 (Asia/Tokyo, UTC+9)`
    - `✏️ 自定义输入时区...`
  - 前端实时使用 `isValidTimezone` 进行预检，非法时给出红色文字提示。

#### 2. 定时任务列表展示 (`TerminalCronView.tsx`)
- 在任务名称和 Cron 表达式旁边，若指定了自定义时区，展示带有地球/时钟图标的小徽章（如 `Asia/Shanghai`），未指定则显示或省略默认本地时区。

#### 3. 国际化字典支持 (`zh.ts` & `en.ts`)
- 增加 `cron.modal.timezoneLabel`, `cron.modal.timezoneLocal`, `cron.modal.timezoneInvalid` 等中英文字典项。

---

## 3. 异常处理与边界防御 (Resilience & Edge Cases)

1. **夏令时（DST - Daylight Saving Time）时钟跳变**：
   采用 `Intl.DateTimeFormat` 原生时区计算，自动遵循 IANA 时区规则处理春季/秋季夏令时跳跃或重叠。
2. **非法时区字符串防御**：
   在前端表单、Hub API、CLI 三层均做统一合法性验证（`isValidTimezone`），拒绝无效输入（如 `Asia/Invalid`），防止计算抛出未捕获异常。
3. **历史数据向下兼容**：
   已有配置中没有 `timezone` 字段的任务，视为 `undefined`，统一按节点本地时区（Local）平滑无缝执行，不发生任何破坏性变更。

---

## 4. 验证与测试策��� (Testing Strategy)

1. **时区计算单元测试 (`tests/cronParserTimezone.test.ts`)**：
   - 验证未指定时区时按本地时区计算。
   - 验证指定 `Asia/Shanghai` 与 `UTC` 时，同一 Cron 表达式计算出的时间戳差值符合时区偏移。
   - 验证跨天、跨月、跨年计算。
   - 验证非法时区输入拦截。
2. **API 与 Hub 持久化测试**：
   - 测试创建带 `timezone: "Asia/Shanghai"` 任务能够成功保存与同步。
   - 测试传入非法时区返回 400 错误。
3. **CLI 测试**：
   - 测试 `gt cron add --tz "Asia/Shanghai"` 及 `gt cron ls` 能够展示时区标签。
4. **前端构建验证**：
   - 运行 `npm run build:frontend` 确保 TypeScript 类型与 Vite 编译通过。
