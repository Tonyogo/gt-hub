# 定时任务（Cron）时区支持实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 gt-hub 定时任务（Cron）系统增加时区支持，默认按 Agent 目标节点本地机器时区执行，同时支持显式指定任意标准 IANA 时区（如 `Asia/Shanghai`、`UTC`），并在 CLI 和 Web 控制台中贯通时区配置与展示。

**Architecture:** 
在 `src/shared/utils/cronParser.ts` 中基于原生 `Intl.DateTimeFormat` 升级 `getNextCronTime` 与新增 `isValidTimezone` 校验，未指定时区时默认走机器本地系统时间，指定时区时按对应时区年月日时分换算；在 `CronJobConfig` 数据模型中增加 `timezone?: string`；在 Hub `TerminalCronService` 中进行合法性校验并落盘；在 `gt cron add` 中增加 `--tz, --timezone` 选项，并在 `gt cron ls` 中展示时区；在 Web 端 `CronJobModal` 增加常用时区下拉与自定义输入，并在 `TerminalCronView` 列表中呈现时区标签徽章。

**Tech Stack:** TypeScript, Node.js (`Intl.DateTimeFormat`), React 18, Tailwind CSS, Jest.

**Spec:** `docs/superpowers/specs/2026-10-15-cron-timezone-support-design.md`

## Global Constraints

- 零外部重量依赖：时区校验与时间换算统一使用运行时原生的 `Intl.DateTimeFormat`，不得引入 moment-timezone 或类似重型包。
- 默认向下兼容：当 `timezone` 为 `undefined`、空字符串或 `'local'` 时，必须默认作为节点本地机器时区计算。
- 非法时区输入防御：在前端表单、Hub API 与 CLI 三层均做合法性检查，非法 IANA 字符串立即拒绝。
- 格式规范：CLI 支持 `--tz <tz>` 与 `--timezone <tz>`。

## Review Focus

- **非法时区字符串拦截**：传入 `Invalid/Timezone` 或乱码时，`isValidTimezone` 必须返回 `false`，API 需返回 400，CLI 必须报错并以非零码退出，前端表单应就地阻止提交。
- **本地时区（Local）计算准确性**：未设置时区时，`0 2 * * *` 必须在当前系统的本地时间 02:00 匹配，而不是之前的 UTC 02:00。
- **显式跨时区计算（如 Asia/Shanghai 与 UTC）**：在同一机器上，对于指定了 `Asia/Shanghai` 和 `UTC` 的相同 Cron 表达式，计算出的时间戳应恰好相差其时区偏移量。
- **夏令时（DST）平滑切换**：指定跨夏令时时区（如 `America/New_York`）��，计算下次触发不发生死循环或时钟溢出。
- **历史旧数据兼容性**：之前创建的不带 `timezone` 属性的历史任务文件能正常加载、正常计算（按 Local 执行）、正常在页面和 CLI 呈现。

---

### Task 1: 共享类型与 Cron 表达式时区解析引擎 (Types & Timezone Cron Parser)

**Files:**
- Modify: `src/shared/types/cron.ts`
- Modify: `src/shared/utils/cronParser.ts`
- Test: `tests/cronParserTimezone.test.ts`
- Test: `tests/cronParser.test.ts`

**Interfaces:**
- Produces:
  - `timezone?: string` in `CronJobConfig` and `CronJobSummary`
  - `isValidTimezone(tz?: string): boolean`
  - `getNextCronTime(expr: string, fromDate?: Date, timezone?: string): Date`

- [x] **Step 1: 编写时区计算与校验的失败测试**

创建 `tests/cronParserTimezone.test.ts`：
1. 验证 `isValidTimezone` 校验（`UTC`, `Asia/Shanghai`, `America/New_York`, `local`, `undefined` 均为合法；`Invalid/Zone`, `foo` 为非法）。
2. 验证未指定时区时按系统 Local 时间计算 `0 2 * * *`（`next.getHours() === 2`）。
3. 验证显式指定 `UTC` 时 `next.getUTCHours() === 2`。
4. 验证显式指定 `Asia/Shanghai` 时，按中国时间计算下一次触发。

```typescript
// tests/cronParserTimezone.test.ts
import { isValidTimezone, getNextCronTime } from '../src/shared/utils/cronParser';

describe('Cron Parser Timezone Support', () => {
  it('validates IANA timezones accurately', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('local')).toBe(true);
    expect(isValidTimezone(undefined)).toBe(true);
    expect(isValidTimezone('')).toBe(true);
    expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    expect(isValidTimezone('foobar')).toBe(false);
  });

  it('calculates next run using local time when timezone is omitted', () => {
    const base = new Date('2026-10-15T10:00:00.000Z');
    const next = getNextCronTime('0 2 * * *', base);
    expect(next.getHours()).toBe(2);
  });

  it('calculates next run using UTC when timezone is UTC', () => {
    const base = new Date('2026-10-15T10:00:00.000Z');
    const next = getNextCronTime('0 2 * * *', base, 'UTC');
    expect(next.getUTCHours()).toBe(2);
  });

  it('throws for invalid timezone in getNextCronTime', () => {
    expect(() => getNextCronTime('0 2 * * *', new Date(), 'Invalid/Zone')).toThrow('Invalid timezone');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/cronParserTimezone.test.ts --detectOpenHandles --forceExit`
预期：FAIL（方法签名或断言不匹配）

- [x] **Step 3: 实现时区解析引擎与模型字段**

1. 修改 `src/shared/types/cron.ts`，为 `CronJobConfig` 与 `CronJobSummary` 增加 `timezone?: string;`。
2. 修改 `src/shared/utils/cronParser.ts`：
   - 实现 `isValidTimezone(tz?: string): boolean`；
   - 升级 `getNextCronTime(expr: string, fromDate?: Date, timezone?: string): Date`：
     - 若 `!timezone || timezone === 'local'`：使用 `current.getSeconds()`, `current.getMinutes()`, `current.getHours()`, `current.getDate()`, `current.getMonth()`, `current.getDay()` 等本地方法。
     - 若 `timezone` 为合法 IANA 字符串：创建 `Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })`，按时区分离出 `year, month, day, hour, minute, weekday` 进行 Cron 字段匹配。
3. 更�� `tests/cronParser.test.ts` 中的用例，使其兼容本地时间计算。

- [x] **Step 4: 运行所有 cronParser 测试验证通过**

运行：`npx jest tests/cronParserTimezone.test.ts tests/cronParser.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/shared/types/cron.ts src/shared/utils/cronParser.ts tests/cronParserTimezone.test.ts tests/cronParser.test.ts
git commit -m "feat(cron): add timezone support to cron types and getNextCronTime"
```

---

### Task 2: Agent 端调度器与 Hub 服务端 REST API 适配 (Agent & Hub Services)

**Files:**
- Modify: `src/agent/cron/cronScheduler.ts`
- Modify: `src/terminal/services/terminalCronService.ts`
- Modify: `src/terminal/controllers/terminalCronController.ts`
- Test: `tests/cronSchedulerTimezone.test.ts`
- Test: `tests/terminalCronApi.test.ts`

**Interfaces:**
- Consumes:
  - `isValidTimezone`, `getNextCronTime` from `src/shared/utils/cronParser.ts`
- Produces:
  - Agent 调度器在 `scheduleJob` 与 `getSummaries` 中带入 `job.timezone`
  - Hub API 在创建/更新任务时验证 `timezone`，非法时返回 400

- [x] **Step 1: 编写 Agent 调度器与 Hub API 时区测试**

编写 `tests/cronSchedulerTimezone.test.ts`：
1. 测试 Agent 调度器保存和同步带 `timezone: "Asia/Shanghai"` 的任务，生成的 `summary.timezone` 与 `summary.nextRunTime` 与指定时区一致。
2. 在 `tests/terminalCronApi.test.ts` 中增加测试：
   - 提交非法时区 `POST /api/terminal/cron/:nodeId` 返回 400 与错误消息。
   - 提交合法时区成功落盘并能查询返回。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/cronSchedulerTimezone.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 改造 `AgentCronScheduler` 与 `TerminalCronService`**

1. 修改 `src/agent/cron/cronScheduler.ts`：
   - `scheduleJob`: `getNextCronTime(job.cron, undefined, job.timezone)`；
   - `getSummaries`: `getNextCronTime(job.cron, undefined, job.timezone).getTime()`。
2. 修改 `src/terminal/controllers/terminalCronController.ts` 与 `TerminalCronService`：
   - 在接收 `timezone` 时调用 `isValidTimezone(timezone)`，若为 `false` 则返回 `{ success: false, error: 'Invalid timezone' }`；
   - 将 `timezone` 持久化保存至 `~/.gt/cron/<nodeId>.json`。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/cronSchedulerTimezone.test.ts tests/terminalCronApi.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/agent/cron/cronScheduler.ts src/terminal/services/terminalCronService.ts src/terminal/controllers/terminalCronController.ts tests/cronSchedulerTimezone.test.ts tests/terminalCronApi.test.ts
git commit -m "feat(hub/agent): support and validate timezone in cron scheduler and hub api"
```

---

### Task 3: CLI 命令行扩展 (`gt cron add --tz` & `gt cron ls`)

**Files:**
- Modify: `src/client/commands/cron.ts`
- Modify: `src/client/index.ts`
- Test: `tests/gtCronTimezone.test.ts`

**Interfaces:**
- Produces:
  - `handleCronAdd({ ..., timezone })`
  - `gt cron add <node> ... --tz <timezone>`
  - `gt cron ls` 显示指定时区标识

- [x] **Step 1: 编写 CLI 时区参数测试**

编写 `tests/gtCronTimezone.test.ts`：
1. 验证 `gt cron add --help` 输出包含 `--tz, --timezone` 选项。
2. 验证非法 `--tz "Bad/Zone"` 时客户端立即抛出错误并退出。
3. 模拟返回带 `timezone: "Asia/Shanghai"` 的任务，验证 `gt cron ls` 输出表格包含时区标签。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/gtCronTimezone.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 修改 `src/client/commands/cron.ts` 与 `src/client/index.ts`**

1. 在 `src/client/index.ts` 的 `cron.command('add')` 注册 `.option('--tz, --timezone <tz>', 'Timezone for cron schedule (e.g. Asia/Shanghai, UTC, default: local)')`。
2. 在 `src/client/commands/cron.ts` 中：
   - `handleCronAdd` 接收 `timezone`，校验 `isValidTimezone`，非法时打印错误并 `process.exit(1)`；
   - 发送请求时包含 `timezone`；
   - `handleCronLs` 表格中，若 `job.timezone` 存在且不为 `local`，在 CRON 列表达式旁展示 `(Asia/Shanghai)`。

- [x] **Step 4: 运行测试并打包 CLI 验证通过**

运行：
1. `npm run build:gt`
2. `npx jest tests/gtCronTimezone.test.ts tests/gtCronCommand.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add src/client/commands/cron.ts src/client/index.ts tests/gtCronTimezone.test.ts
git commit -m "feat(cli): add --tz option to gt cron add and display timezone in gt cron ls"
```

---

### Task 4: Web 控制台时区交互扩展 (`CronJobModal` & `TerminalCronView`) 与全量构建

**Files:**
- Modify: `frontend/src/components/terminal/types/cron.ts`
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Modify: `frontend/src/components/terminal/components/CronJobModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalCronView.tsx`
- Test: `tests/frontendCronTimezone.test.ts`

**Interfaces:**
- Produces:
  - ���区快捷下拉菜单与自定义输入
  - 任务列表展示时区徽章
  - 中英文字典翻译

- [x] **Step 1: 编写前端时区交互与 i18n 测试**

创建 `tests/frontendCronTimezone.test.ts`：
1. 验证 `zh.ts` 与 `en.ts` 均包含 `cron.modal.timezoneLabel`, `cron.modal.timezoneLocal`, `cron.modal.timezoneInvalid` 等翻译项。
2. 验证 `CronJobModal.tsx` 中包含时区选项与 `timezone` 表单字段绑定。
3. 验证 `TerminalCronView.tsx` 中渲染了时区徽章。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/frontendCronTimezone.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 实现���端组件时区选择与展示**

1. 更新 `frontend/src/components/terminal/types/cron.ts`，为 `CronJobConfig` 与 `CronJobSummary` 增加 `timezone?: string;`。
2. 在 `frontend/src/i18n/locales/zh.ts` 与 `en.ts` 增加对应词条。
3. 修改 `frontend/src/components/terminal/components/CronJobModal.tsx`：
   - 增加时区选择下拉框（本地时区、Asia/Shanghai、UTC、America/New_York、Asia/Tokyo、自定义输入）；
   - 前端校验 `isValidTimezone`；
   - 提交时包含 `timezone` 字段。
4. 修改 `frontend/src/components/terminal/TerminalCronView.tsx`：
   - 在 Cron 表达式旁，当配置了特定时区时渲染时区标签小徽章。

- [x] **Step 4: 运行前端构建与全量测试**

运行：
1. `npx jest tests/frontendCronTimezone.test.ts --detectOpenHandles --forceExit`
2. `npm run build:frontend`
3. `npm test`
预期：全部 PASS，0 错误。

- [x] **Step 5: 提交任务代码**

```bash
git add frontend/src/components/terminal/types/cron.ts frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts frontend/src/components/terminal/components/CronJobModal.tsx frontend/src/components/terminal/TerminalCronView.tsx tests/frontendCronTimezone.test.ts
git commit -m "feat(frontend): add timezone selector to CronJobModal and timezone badge in TerminalCronView"
```
