# Agent 后台任务可视化与服务器时区展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Agent 后台任务 Web 可视化管理面板（含任务监控列表、实时日志跟踪与终止控制、异步任务创建）及全局服务端时区展示徽章。

**Architecture:** 后端在主机与版本元数据接口注入全局服务器时区字段（`config.timeZone`）；前端在 `UnifiedTerminalView` 顶栏增加服务器时区胶囊徽章与第 4 个「任务管理」SubTab；构建 `TerminalTaskView` 独立视图，提供指标统计卡片、实时搜索筛选、任务状态流转展示、`TaskLogModal`（实时滚动日志与终止操作）以及 `CreateTaskModal`（启动后台任务）。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide Icons, Express, Node.js, Jest, Supertest.

**Spec:** `docs/superpowers/specs/2026-10-16-agent-task-visualization-and-timezone-design.md`

## Global Constraints

- **时区权威源**：服务器时区必须直接来自 `config.timeZone`，与 `AgentCronScheduler` 的基准保持一致。
- **任务状态定义**：严格对齐 `src/shared/types/task.ts` 的 `TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed'`。
- **国际化完整性**：所有界面文字、按钮、表头、状态描述必须同时在 `zh.ts` 和 `en.ts` 中维护，禁止写死中文。
- **轮询安全**：仅当组件激活且存在 `running` 状态任务时启用静默轮询（3s 刷新列表，1.5s 拉取运行中任务增量日志）；离开组件或失活时必须销毁定时器。
- **构建测试约束**：每次修改保证 `npm run build:frontend` 与 `npm test -- tests/<target>.test.ts` 通过，Jest 运行必须附带 `--detectOpenHandles --forceExit`。

## Review Focus

1. **节点离线或断连状态下操作**：切换到离线主机时，页面应展示清晰友好空状态，新建与操作按钮禁用，避免无谓的网络重试与崩溃。
2. **长任务大量输出内存膨胀**：`TaskLogModal` 拉取日志需支持分页增量拼接，并对过长输出做最大保留上限截断保护，防止浏览器卡死。
3. **任务日志实时跟踪与中断同步**：在弹窗内直接终止任务时，应立即向服务端发送 kill 信号，并将任务状态平滑更新为 killed，停止继续轮询。
4. **时区获取时序延迟**：当节点列表或版本尚未加载完成时，顶部时区徽章优雅占位或不展示破损内容，加载后自动渲染。
5. **小屏幕/移动端响应式布局**：在移动端或小屏宽度下，Tab 标签自动缩略为图标，时区徽章合理自适应，不破坏顶部控制栏的工具按钮排版。

---

### Task 1: 后端接口时区字段扩展与 API 测试

**Files:**
- Modify: `src/terminal/controllers/terminalHostController.ts:6-23`
- Test: `tests/terminalTaskApi.test.ts`

**Interfaces:**
- Consumes: `config.timeZone` from `src/server/config/default`
- Produces: `timezone: string` on `GET /api/terminal/hosts` and `GET /api/terminal/version`

- [x] **Step 1: Write the failing API test**

```typescript
// tests/terminalTaskApi.test.ts
import request from 'supertest';
import express from 'express';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import config from '../config/default';

describe('Terminal Task & Timezone API', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/terminal', terminalRoutes);

  const key = config.adminSecretKey || 'test-key';
  const originalKey = config.adminSecretKey;

  beforeAll(() => {
    config.adminSecretKey = key;
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  test('GET /api/terminal/hosts includes configured server timezone', async () => {
    const res = await request(app)
      .get('/api/terminal/hosts')
      .set('x-admin-key', key);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hosts');
    expect(res.body).toHaveProperty('timezone', config.timeZone);
  });

  test('GET /api/terminal/version includes server timezone', async () => {
    const res = await request(app)
      .get('/api/terminal/version')
      .set('x-admin-key', key);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('timezone', config.timeZone);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTaskApi.test.ts`
Expected: FAIL with `timezone` property missing on responses.

- [x] **Step 3: Update `terminalHostController.ts` to include timezone**

In `src/terminal/controllers/terminalHostController.ts`:
```typescript
import { Request, Response } from 'express';
import { terminalHostManager } from '../services/terminalHostManager';
import { getVersionInfo } from '../../shared/version';
import config from '../../server/config/default';

class TerminalHostController {
  public async getHosts(req: Request, res: Response): Promise<void> {
    const hosts = terminalHostManager.getHosts();
    res.json({ hosts, timezone: config.timeZone });
  }

  public async pruneOfflineHosts(req: Request, res: Response): Promise<void> {
    const prunedIds = terminalHostManager.pruneOfflineHosts(0);
    res.json({
      success: true,
      prunedCount: prunedIds.length,
      prunedIds,
    });
  }

  public async getVersion(req: Request, res: Response): Promise<void> {
    res.json({ ...getVersionInfo(), timezone: config.timeZone });
  }
}

export const terminalHostController = new TerminalHostController();
export default terminalHostController;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalTaskApi.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/terminal/controllers/terminalHostController.ts tests/terminalTaskApi.test.ts
git commit -m "feat(server): expose server timezone in terminal hosts and version APIs"
```

---

### Task 2: 前端数据类型与 i18n 语言包扩展

**Files:**
- Create: `frontend/src/components/terminal/types/task.ts`
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Test: `tests/frontendTaskI18n.test.ts`

**Interfaces:**
- Produces: `TaskSummary`, `TaskStatus`, `TaskLogResponse`, `CreateTaskInput`, `tasks.*` i18n keys

- [x] **Step 1: Write the failing i18n and type test**

```typescript
// tests/frontendTaskI18n.test.ts
import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('Frontend Task Management i18n Dictionary', () => {
  const requiredKeys = [
    'tasks.tabName',
    'tasks.title',
    'tasks.createTask',
    'tasks.refresh',
    'tasks.searchPlaceholder',
    'tasks.filterAll',
    'tasks.filterRunning',
    'tasks.filterCompleted',
    'tasks.filterFailed',
    'tasks.filterKilled',
    'tasks.statTotal',
    'tasks.statRunning',
    'tasks.statCompleted',
    'tasks.statFailed',
    'tasks.colTaskId',
    'tasks.colCommand',
    'tasks.colStatus',
    'tasks.colExitCode',
    'tasks.colDuration',
    'tasks.colStartTime',
    'tasks.colActions',
    'tasks.viewLogs',
    'tasks.killTask',
    'tasks.killConfirm',
    'tasks.copySuccess',
    'tasks.emptyTitle',
    'tasks.emptyDesc',
    'tasks.noNode',
    'tasks.nodeOffline',
    'tasks.createModal.title',
    'tasks.createModal.commandLabel',
    'tasks.createModal.cwdLabel',
    'tasks.createModal.timeoutLabel',
    'tasks.createModal.submit',
    'tasks.createModal.cancel',
    'tasks.logsModal.title',
    'tasks.logsModal.autoScroll',
    'tasks.logsModal.copy',
    'tasks.logsModal.close',
    'common.serverTimezone',
  ];

  it('contains all required task keys in both zh and en dictionaries', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendTaskI18n.test.ts`
Expected: FAIL with missing translation keys.

- [x] **Step 3: Create `frontend/src/components/terminal/types/task.ts`**

```typescript
export type TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed';

export interface TaskSummary {
  taskId: string;
  command: string;
  cwd?: string;
  status: TaskStatus;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  signal: string | null;
  error?: string | null;
  pid?: number;
}

export interface TaskLogResponse {
  success: boolean;
  taskId: string;
  status: TaskStatus;
  exitCode: number | null;
  signal: string | null;
  output: string;
  offset: number;
  totalBytes?: number;
  error?: string;
}

export interface CreateTaskInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}
```

- [x] **Step 4: Update `zh.ts` and `en.ts` with task dictionaries**

Add to `frontend/src/i18n/locales/zh.ts`:
```typescript
  'common.serverTimezone': '服务器时区',
  'common.serverTimezoneTooltip': '服务器全局基准时区',
  'tasks.tabName': '任务管理',
  'tasks.title': '后台任务管理',
  'tasks.createTask': '新建任务',
  'tasks.refresh': '刷新',
  'tasks.searchPlaceholder': '搜索任务 ID 或命令...',
  'tasks.filterAll': '全部状态',
  'tasks.filterRunning': '运行中',
  'tasks.filterCompleted': '已完成',
  'tasks.filterFailed': '失败',
  'tasks.filterKilled': '已终止',
  'tasks.statTotal': '总任务数',
  'tasks.statRunning': '运行中',
  'tasks.statCompleted': '已完成',
  'tasks.statFailed': '失败 / 超时',
  'tasks.colTaskId': '任务 ID',
  'tasks.colCommand': '执行命令',
  'tasks.colStatus': '状态',
  'tasks.colExitCode': '退出码',
  'tasks.colDuration': '耗时',
  'tasks.colStartTime': '启动时间',
  'tasks.colActions': '操作',
  'tasks.viewLogs': '查看日志',
  'tasks.killTask': '终止任务',
  'tasks.killConfirm': '确定要向该任务发送终止信号吗？',
  'tasks.copySuccess': '已复制到剪贴板',
  'tasks.emptyTitle': '暂无后台任务',
  'tasks.emptyDesc': '当前节点尚未记录任何后台执行任务。',
  'tasks.noNode': '请先选择需要管理任务的目标节点',
  'tasks.nodeOffline': '目标节点已断开连接或离线',
  'tasks.createModal.title': '新建后台任务',
  'tasks.createModal.commandLabel': 'Shell 命令',
  'tasks.createModal.commandPlaceholder': '例如: npm run build 或 python3 script.py',
  'tasks.createModal.cwdLabel': '工作目录 (CWD，可选)',
  'tasks.createModal.cwdPlaceholder': '留空默认为 Agent 运行主目录',
  'tasks.createModal.timeoutLabel': '超时时间 (秒，可选)',
  'tasks.createModal.timeoutPlaceholder': '留空表示无限制',
  'tasks.createModal.submit': '启动任务',
  'tasks.createModal.cancel': '取消',
  'tasks.logsModal.title': '任务执行日志',
  'tasks.logsModal.autoScroll': '自动滚屏',
  'tasks.logsModal.copy': '复制日志',
  'tasks.logsModal.close': '关闭',
```
And matching English translations in `frontend/src/i18n/locales/en.ts`.

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/frontendTaskI18n.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add frontend/src/components/terminal/types/task.ts frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts tests/frontendTaskI18n.test.ts
git commit -m "feat(frontend): define task types and i18n translations for task management"
```

---

### Task 3: 任务实时日志弹窗组件 (TaskLogModal)

**Files:**
- Create: `frontend/src/components/terminal/components/TaskLogModal.tsx`

**Interfaces:**
- Consumes: `TaskSummary`, `TaskStatus`, `apiFetch`
- Props:
  ```typescript
  export interface TaskLogModalProps {
    isOpen: boolean;
    onClose: () => void;
    task: TaskSummary | null;
    activeHostId: string;
    adminKey?: string;
    onKillTask?: (taskId: string) => Promise<void>;
  }
  ```

- [x] **Step 1: Implement `TaskLogModal.tsx`**

Features:
1. Modal with terminal-like dark background (`#0c1017`).
2. Displays Task ID, status badge, Command, CWD, exit code in header.
3. Automatically fetches log from `/api/terminal/exec/:hostId/:taskId?offset=0`.
4. If task is running, automatically polls `/api/terminal/exec/:hostId/:taskId?offset=${offset}` every 1.5 seconds.
5. Keeps auto-scrolling to bottom if `autoScroll` is enabled.
6. Copy button with success toast / badge.
7. Kill button if `task.status === 'running'`.

- [x] **Step 2: Verify frontend builds without type errors**

Run: `npm run build:frontend`
Expected: PASS with 0 errors.

- [x] **Step 3: Commit**

```bash
git add frontend/src/components/terminal/components/TaskLogModal.tsx
git commit -m "feat(frontend): create TaskLogModal for live output streaming and task termination"
```

---

### Task 4: 新建任务弹窗组件 (CreateTaskModal)

**Files:**
- Create: `frontend/src/components/terminal/components/CreateTaskModal.tsx`

**Interfaces:**
- Consumes: `CreateTaskInput`
- Props:
  ```typescript
  export interface CreateTaskModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (input: CreateTaskInput) => Promise<void>;
    isLoading: boolean;
  }
  ```

- [x] **Step 1: Implement `CreateTaskModal.tsx`**

Features:
1. Command input (textarea for shell command, required).
2. Working directory input (optional string).
3. Timeout in seconds (optional number).
4. Validation: command cannot be empty.
5. Submit button with spinner loading state.

- [x] **Step 2: Verify frontend builds without type errors**

Run: `npm run build:frontend`
Expected: PASS with 0 errors.

- [x] **Step 3: Commit**

```bash
git add frontend/src/components/terminal/components/CreateTaskModal.tsx
git commit -m "feat(frontend): create CreateTaskModal for starting background tasks"
```

---

### Task 5: 任务管理主视图组件 (TerminalTaskView)

**Files:**
- Create: `frontend/src/components/terminal/TerminalTaskView.tsx`

**Interfaces:**
- Props:
  ```typescript
  export interface TerminalTaskHandle {
    refresh: () => void;
  }

  export interface TerminalTaskViewProps {
    adminKey?: string;
    activeHostId?: string;
    isConnected?: boolean;
    onRequestAddNode?: () => void;
  }
  ```

- [x] **Step 1: Implement `TerminalTaskView.tsx`**

Features:
1. Stat Cards: Total tasks, Running (with pulsing indicator), Completed, Failed/Timeout.
2. Filter bar: Search input for Task ID or Command, Status dropdown pills (`all`, `running`, `completed`, `failed`, `killed`).
3. Action buttons: Refresh, New Task.
4. Tasks Table:
   - Task ID (clickable to copy, truncated with monospace).
   - Command (styled as inline code block with hover tooltip).
   - Status badge with corresponding colors (`emerald` for completed, `amber` with pulse for running, `rose` for failed, `slate` for killed).
   - Start Time (localized human-friendly) & Duration.
   - Exit code (badge or dash).
   - Action buttons: "查看日志" (opens `TaskLogModal`), "终止" (if running, with confirm).
5. Polling:
   - When active and there is a `running` task, polls `fetchTasks(true)` every 3000ms.
   - Cleans up timers on unmount.
6. Empty states:
   - No node selected (`TerminalEmptyState`).
   - Node offline (`TerminalEmptyState`).
   - No tasks found.

- [x] **Step 2: Verify frontend builds without type errors**

Run: `npm run build:frontend`
Expected: PASS with 0 errors.

- [x] **Step 3: Commit**

```bash
git add frontend/src/components/terminal/TerminalTaskView.tsx
git commit -m "feat(frontend): implement TerminalTaskView with stat cards, search, filtering and task actions"
```

---

### Task 6: 顶栏 SubTab 扩展与全局服务器时区徽章集成

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/frontendTaskSubTab.test.ts`

**Interfaces:**
- Extends: `TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks'`
- Integrates: `TerminalTaskView`, `Activity` icon, Server Timezone Badge

- [x] **Step 1: Write failing subtab & timezone test**

```typescript
// tests/frontendTaskSubTab.test.ts
import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView SubTab Integration with Tasks & Timezone', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('declares TerminalSubTab union including tasks', () => {
    expect(content).toMatch(/type\s+TerminalSubTab\s*=\s*['"]interactive['"]\s*\|\s*['"]files['"]\s*\|\s*['"]cron['"]\s*\|\s*['"]tasks['"]/);
  });

  it('imports TerminalTaskView and Activity icon', () => {
    expect(content).toContain('TerminalTaskView');
    expect(content).toMatch(/import\s*\{[^}]*Activity[^}]*\}\s*from\s*['"]lucide-react['"]/);
  });

  it('renders tasks SubTab button', () => {
    expect(content).toContain("handleSubTabChange('tasks')");
    expect(content).toMatch(/subTab\s*===\s*['"]tasks['"]/);
  });

  it('renders server timezone badge in header', () => {
    expect(content).toContain('serverTimezone');
  });

  it('renders TerminalTaskView in workspace', () => {
    expect(content).toContain('<TerminalTaskView');
    expect(content).toContain("subTab === 'tasks'");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendTaskSubTab.test.ts`
Expected: FAIL.

- [x] **Step 3: Update `UnifiedTerminalView.tsx`**

1. Update `TerminalSubTab` type:
   ```typescript
   export type TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks';
   ```
2. Import `Activity` from `lucide-react` and `TerminalTaskView, { TerminalTaskHandle }` from `./terminal/TerminalTaskView`.
3. Add `serverTimezone` state:
   ```typescript
   const [serverTimezone, setServerTimezone] = useState<string>('');
   ```
4. Fetch `/api/terminal/hosts` or `/api/terminal/version` on mount to populate `serverTimezone`.
5. Render Timezone Badge in Header:
   ```tsx
   {serverTimezone && (
     <div
       className="hidden sm:flex items-center space-x-1 px-2 py-1 rounded-lg bg-black/30 border border-white/[0.06] text-slate-300 font-mono text-[11px] shrink-0"
       title={`${t('common.serverTimezone', '服务器时区')}: ${serverTimezone}`}
     >
       <span className="text-xs">🌐</span>
       <span>{serverTimezone}</span>
     </div>
   )}
   ```
6. Add the 4th SubTab button:
   ```tsx
   <button
     type="button"
     onClick={() => handleSubTabChange('tasks')}
     className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
       subTab === 'tasks'
         ? 'bg-indigo-600 text-white shadow-xs'
         : 'text-slate-400 hover:text-slate-200'
     }`}
   >
     <Activity className="w-3.5 h-3.5" />
     <span className="hidden sm:inline">{t('tasks.tabName', '任务管理')}</span>
   </button>
   ```
7. Render `TerminalTaskView` in the workspace:
   ```tsx
   <div className={`flex-1 min-h-0 ${subTab === 'tasks' ? 'flex' : 'hidden'} flex-col`}>
     <TerminalTaskView
       ref={taskRef}
       adminKey={adminKey}
       activeHostId={activeHostId}
       isConnected={connectionStatus.isConnected}
       onRequestAddNode={() => setIsAddNodeModalOpen(true)}
     />
   </div>
   ```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/frontendTaskSubTab.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/UnifiedTerminalView.tsx tests/frontendTaskSubTab.test.ts
git commit -m "feat(frontend): integrate tasks subtab and server timezone badge in UnifiedTerminalView"
```

---

### Task 7: 全面构建回归与端到端测试

**Files:**
- Test: `tests/terminalTaskApi.test.ts`
- Test: `tests/frontendTaskSubTab.test.ts`
- Test: `tests/frontendTaskI18n.test.ts`

- [x] **Step 1: Execute targeted tests**

Run: `npm test -- tests/terminalTaskApi.test.ts tests/frontendTaskSubTab.test.ts tests/frontendTaskI18n.test.ts`
Expected: All tests pass cleanly.

- [x] **Step 2: Build frontend and backend**

Run: `npm run build`
Expected: Full project build completes with 0 errors.

- [x] **Step 3: Run existing regression tests**

Run: `npm test -- tests/frontendUnifiedSubTabs.test.ts tests/terminalHostsApi.test.ts`
Expected: PASS

- [x] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verify full build and tests for agent task visualization and server timezone"
```
