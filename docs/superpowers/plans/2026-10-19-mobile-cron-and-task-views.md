# 移动端定时任务与任务管理显示优化实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 `gt-hub` Web 控制台中的定时任务（Cron）与任务管理（Tasks）在移动端设备（手机窄屏 < 640px）上的显示与交互体验，将其从横向表格重构为触控友好的卡片流，精简工具栏与统计卡片，并将表单与日志弹窗适配为移动端贴底抽屉（Bottom Sheet）。

**Architecture:** 采用响应式双模式渲染（Responsive Adaptive View）。在 `TerminalCronView` 和 `TerminalTaskView` 中，基于 Tailwind `sm:` 断点分别在桌面端渲染现有表格、在移动端渲染信息卡片流；把统计指标在小屏无缝合入状态筛选 Pill；将 4 个 Modal 组件重构为自适应容器（桌面端居中 Modal，移动端带手柄条与滑入动画的贴底 Bottom Sheet）。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React, Jest.

## Global Constraints

- **桌面端体验向后兼容**：`sm:` (>= 640px) 视口下��须完整保留原有的表格、列数据、统计大卡片和居中 Modal 行为，不可破坏现有桌面端用户的任何操作流程与视觉布局。
- **触控点击区域标准**：所有在移动端可点击的按钮与卡片交互元素必须具有至少 `min-h-[36px]` 的触控尺寸，留白充裕以防误触。
- **内存与性能保护**：维持现有的 500KB 日志内存保护和增量滚动机制，不可在小屏渲染海量不可见 DOM。
- **底部安全区适配**：Bottom Sheet 必须包含 `pb-[max(1rem,env(safe-area-inset-bottom))]`，防止全面屏 Home 手势指示条遮挡按钮。
- **测试标准**：遵循 Jest `--detectOpenHandles --forceExit` 要求，所有测试运行必须通过。

---

### Task 1: 编写针对移动端 Cron & Tasks 响应式规范的自动化测试

**Files:**
- Create: `tests/frontendMobileCronAndTaskViews.test.ts`

**Interfaces:**
- Consumes: `frontend/src/components/terminal/TerminalCronView.tsx`, `frontend/src/components/terminal/TerminalTaskView.tsx`, `frontend/src/components/terminal/components/CronJobModal.tsx`, `frontend/src/components/terminal/components/CronLogModal.tsx`, `frontend/src/components/terminal/components/CreateTaskModal.tsx`, `frontend/src/components/terminal/components/TaskLogModal.tsx`
- Produces: 自动化测试套件，验证文件内容包含移动端卡片布局（`sm:hidden` / `hidden sm:block`）、Bottom Sheet 样式类、以及紧凑状态徽章。

- [x] **Step 1: 编写测试文件**

```typescript
// tests/frontendMobileCronAndTaskViews.test.ts
import * as fs from 'fs';
import * as path from 'path';

describe('Frontend Mobile Optimization for Cron & Tasks', () => {
  const cronViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
  const taskViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalTaskView.tsx');
  const cronJobModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronJobModal.tsx');
  const cronLogModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronLogModal.tsx');
  const createTaskModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CreateTaskModal.tsx');
  const taskLogModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/TaskLogModal.tsx');

  let cronViewContent: string;
  let taskViewContent: string;
  let cronJobModalContent: string;
  let cronLogModalContent: string;
  let createTaskModalContent: string;
  let taskLogModalContent: string;

  beforeAll(() => {
    cronViewContent = fs.readFileSync(cronViewPath, 'utf-8');
    taskViewContent = fs.readFileSync(taskViewPath, 'utf-8');
    cronJobModalContent = fs.readFileSync(cronJobModalPath, 'utf-8');
    cronLogModalContent = fs.readFileSync(cronLogModalPath, 'utf-8');
    createTaskModalContent = fs.readFileSync(createTaskModalPath, 'utf-8');
    taskLogModalContent = fs.readFileSync(taskLogModalPath, 'utf-8');
  });

  describe('TerminalCronView Mobile Adaptations', () => {
    it('contains dual-mode rendering with sm:hidden card list and hidden sm:block table', () => {
      expect(cronViewContent).toMatch(/sm:hidden/);
      expect(cronViewContent).toMatch(/hidden sm:block|hidden sm:table/);
    });

    it('retains all essential actions on mobile cards (run, toggle status, logs, edit, delete)', () => {
      expect(cronViewContent).toContain('handleRunNow');
      expect(cronViewContent).toContain('handleToggleStatus');
      expect(cronViewContent).toContain('setSelectedJobForLogs');
      expect(cronViewContent).toContain('setEditingJob');
      expect(cronViewContent).toContain('handleDeleteJob');
    });
  });

  describe('TerminalTaskView Mobile Adaptations', () => {
    it('contains dual-mode rendering with sm:hidden card list and hidden sm:block table', () => {
      expect(taskViewContent).toMatch(/sm:hidden/);
      expect(taskViewContent).toMatch(/hidden sm:block|hidden sm:table/);
    });

    it('compacts stat cards on mobile to preserve vertical space', () => {
      // The 4-grid stats should be hidden on small screens: hidden sm:grid
      expect(taskViewContent).toMatch(/hidden sm:grid/);
    });
  });

  describe('Responsive Modals as Bottom Sheets', () => {
    it('implements bottom sheet positioning on CronJobModal', () => {
      expect(cronJobModalContent).toMatch(/items-end sm:items-center/);
      expect(cronJobModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on CronLogModal', () => {
      expect(cronLogModalContent).toMatch(/items-end sm:items-center/);
      expect(cronLogModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on CreateTaskModal', () => {
      expect(createTaskModalContent).toMatch(/items-end sm:items-center/);
      expect(createTaskModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on TaskLogModal', () => {
      expect(taskLogModalContent).toMatch(/items-end sm:items-center/);
      expect(taskLogModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });
  });
});
```

- [x] **Step 2: 运行测试以验证它失败**

运行: `npm test -- tests/frontendMobileCronAndTaskViews.test.ts`
预期: 失败（FAIL，因为目标组件尚未添加 `sm:hidden`、`hidden sm:grid` 等移动端优化类）

- [x] **Step 3: 提交初始测试文件**

```bash
git add tests/frontendMobileCronAndTaskViews.test.ts
git commit -m "test: add test suite for mobile cron and task views"
```

---

### Task 2: 优化 `TerminalCronView` 移动端布局（顶部工具栏自适应 + 卡片流列表）

**Files:**
- Modify: `frontend/src/components/terminal/TerminalCronView.tsx:338-696`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`

**Interfaces:**
- Consumes: `jobs: CronJobSummary[]`, `runningJobIds: Set<string>`, `deleteConfirmJobId: string | null`
- Produces: 响应式定时任务视图：在 `< sm` 下呈现卡片列表，在 `>= sm` 下呈现原有的数据表格。

- [x] **Step 1: 修改顶部工具栏以自适���窄屏**
修改 `TerminalCronView.tsx` 中的 Toolbar，让搜索框在小屏下宽度自适应（如 `w-24 focus:w-36 sm:w-48 transition-all`），防止 360px 屏幕折行。

- [x] **Step 2: 在过滤列表渲染区增加移动端卡片流**
在表格容器前增加移动端专用的卡片列表（`div className="sm:hidden space-y-3"`），同时把现有的 `div className="overflow-x-auto rounded-2xl border ..."` 改为 `div className="hidden sm:block overflow-x-auto rounded-2xl border ..."`。
移动端卡片包含：
1. 头部：状态呼吸点 + 任务名称 + 状态徽标（运行中/暂停/成功/失败/跳过）。
2. 内容：执行来源（`hub:xxx` 或命令） + Cron 表达式 + 下次触发倒计时 + 耗时。
3. 底部操作栏：立即执行、暂停/恢复、日志、编辑、删除（带删除确认切换）。

- [x] **Step 3: 运行测试验证**

运行: `npm test -- tests/frontendTerminalCronView.test.ts tests/frontendMobileCronAndTaskViews.test.ts`
预期: Cron 相关断言通过

- [x] **Step 4: 提交变更**

```bash
git add frontend/src/components/terminal/TerminalCronView.tsx
git commit -m "feat(cron): add responsive mobile card list and compact toolbar to TerminalCronView"
```

---

### Task 3: 优化 `TerminalTaskView` 移动端布局（统计卡片精简 + 卡片流���表）

**Files:**
- Modify: `frontend/src/components/terminal/TerminalTaskView.tsx:315-680`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`

**Interfaces:**
- Consumes: `tasks: TaskSummary[]`, `statusFilter`, `searchQuery`
- Produces: 响应式任务管理视图：手机端隐藏原有的 2x2 统计卡片（`hidden sm:grid`），通过状态 Pill 显示数量；在 `< sm` 下呈现任务卡片列表，在 `>= sm` 下呈现数据表格。

- [x] **Step 1: 将统计卡片网格调整为仅在桌面端显示**
在 `TerminalTaskView.tsx` 中，将 `<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">` 调整为 `<div className="hidden sm:grid sm:grid-cols-4 gap-3 shrink-0">`。这样在移动端省去大量垂直空间，统计数字在下方的状态筛选 Pill 中已有完整呈现。

- [x] **Step 2: 调整搜索框自适应宽度**
将 `w-36 sm:w-56` 调整为 `w-24 focus:w-36 sm:w-56 transition-all`，保证在小屏下与刷新按钮、新建任务按钮单行并列。

- [x] **Step 3: 在任务列表渲染区增加移动端卡片流**
在现有表格外部增加 `hidden sm:block`，并在其同级增加移动端卡片流 `div className="sm:hidden space-y-3"`。
每个任务卡片包含：
1. 头部：短 Task ID（带复制按钮）+ 状态徽章（运行中带有呼吸动画）+ 退出码 Badge。
2. 命令展示：等宽背景框，支持截断，点击整个卡片直接打开该任务的实时日志 Modal。
3. 时间与耗时：启动时间与持续耗时。
4. 操作栏：查看日志按钮 + 终止运行按钮（仅运行中任务显示，保留 `window.confirm`）。

- [x] **Step 4: 运行测试验证**

运行: `npm test -- tests/frontendTaskSubTab.test.ts tests/frontendMobileCronAndTaskViews.test.ts`
预期: Task 相关断言通过

- [x] **Step 5: 提交变更**

```bash
git add frontend/src/components/terminal/TerminalTaskView.tsx
git commit -m "feat(tasks): compact stat cards and add responsive card view to TerminalTaskView"
```

---

### Task 4: 将 `CronJobModal` 与 `CronLogModal` 重构为自适应 Bottom Sheet

**Files:**
- Modify: `frontend/src/components/terminal/components/CronJobModal.tsx:198-250`
- Modify: `frontend/src/components/terminal/components/CronLogModal.tsx:110-180`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`, `tests/frontendCronModals.test.ts`

**Interfaces:**
- Consumes: 现有 Modal 的 Props 与业务逻辑
- Produces: 响应式弹窗容器：桌面端居中 Modal，移动端贴底 Bottom Sheet。

- [x] **Step 1: 改造 `CronJobModal.tsx` 容器与手柄**
1. 外层容器：`items-end sm:items-center justify-center p-0 sm:p-4`。
2. 卡片主体：`w-full max-h-[90vh] sm:max-h-[85vh] rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl border-t sm:border border-white/10 flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-0`。
3. 顶部手柄条：在移动端显示一条 `sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto my-2`。
4. 预设快捷标签支持横向顺畅滑动（`overflow-x-auto scrollbar-none`）。

- [x] **Step 2: 改造 `CronLogModal.tsx` 容器与手柄**
1. 同样调整为 `items-end sm:items-center justify-center p-0 sm:p-4`。
2. 卡片主体贴底并增加顶部手柄条与底部安全区。
3. 日志窗口在小屏自适应占满垂直可用高度。

- [x] **Step 3: 运行测试验证**

运行: `npm test -- tests/frontendCronModals.test.ts tests/frontendMobileCronAndTaskViews.test.ts`
预期: 全部通过

- [x] **Step 4: 提交变更**

```bash
git add frontend/src/components/terminal/components/CronJobModal.tsx frontend/src/components/terminal/components/CronLogModal.tsx
git commit -m "feat(cron): adapt CronJobModal and CronLogModal to responsive bottom sheets"
```

---

### Task 5: 将 `CreateTaskModal` 与 `TaskLogModal` 重构为自适应 Bottom Sheet

**Files:**
- Modify: `frontend/src/components/terminal/components/CreateTaskModal.tsx:68-120`
- Modify: `frontend/src/components/terminal/components/TaskLogModal.tsx:160-240`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`

**Interfaces:**
- Consumes: 现有 Modal 的 Props 与业务逻辑
- Produces: 响应式任务弹窗容器：桌面端居中 Modal，移动端贴底 Bottom Sheet。

- [x] **Step 1: 改造 `CreateTaskModal.tsx`**
1. 外层容器调整为 `items-end sm:items-center justify-center p-0 sm:p-4`。
2. 移动端圆角 `rounded-t-2xl sm:rounded-2xl rounded-b-none sm:rounded-b-2xl`，添加手柄条及安全区 padding。

- [x] **Step 2: 改造 `TaskLogModal.tsx`**
1. 外层容器调整为 `items-end sm:items-center justify-center p-0 sm:p-4`。
2. 卡片主体贴底，添加手柄条及安全区 padding。
3. 调整工具按钮触控大小（>= 36px），小屏下日志终端区域高度响应式拉伸。

- [x] **Step 3: 运行测试验证**

运行: `npm test -- tests/frontendMobileCronAndTaskViews.test.ts`
预期: 全部通过

- [x] **Step 4: 提交变更**

```bash
git add frontend/src/components/terminal/components/CreateTaskModal.tsx frontend/src/components/terminal/components/TaskLogModal.tsx
git commit -m "feat(tasks): adapt CreateTaskModal and TaskLogModal to responsive bottom sheets"
```

---

### Task 6: 全局构建、全量测试验证与收尾

**Files:**
- Test: 全量前端编译及 Jest 测试套件

**Interfaces:**
- Consumes: 全部前端源码与测试
- Produces: 稳定可发布的无报错构建产物。

- [x] **Step 1: 执行全量前端编译**

运行: `npm run build:frontend`
预期: Vite 打包成功，无 TypeScript 类型错误与 CSS 语法告警。

- [x] **Step 2: 执行全量测试**

运行: `npm test`
预期: 所有测试套件全部通过（PASS）。

- [x] **Step 3: 检查 Git 工作区状态并提交最终结果**

```bash
git status
```
确保工作区干净，无残留无用文件。
