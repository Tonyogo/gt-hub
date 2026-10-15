# Web 端定时任务（Cron）管理页面实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 gt-hub Web 控制台中新增【定时任务】（Cron）独立管理页面（作为顶层 SubTab），提供可视化任务列表监控、双模（直接命令与 Hub 脚本）创建/编辑弹窗、暗黑终端风格执行日志查看弹窗及完整的中英文国际化支持。

**Architecture:** 
在 `frontend/src/components/UnifiedTerminalView.tsx` 中扩展 `TerminalSubTab = 'interactive' | 'files' | 'cron'`，并新增第三个 Tab 胶囊切换按钮；开发主组件 `TerminalCronView.tsx` 与两个模态框组件 `CronJobModal.tsx`（新增/编辑任务，含快捷 Cron 胶囊、下次运行时间预演与 Hub 脚本联动下拉）和 `CronLogModal.tsx`（暗黑终端日志查看器，支持一键复制与刷新）；对接现有 `/api/terminal/cron/:hostId` REST 接口；在 `zh.ts` / `en.ts` ���配置完整的 i18n 字典条目。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React (`lucide-react`), Vite.

**Spec:** `docs/superpowers/specs/2026-10-15-web-cron-manager-design.md`

## Global Constraints

- 前端严禁使用全局 `alert()`，所有用户操作与错误提示统一使用优雅轻量 Toast 弹窗（参考 `TerminalFileManagerView` 模式）。
- HTTP 请求统一使用 `apiFetch` 工具方法（`frontend/src/utils/apiClient.ts`），以便 401 自动触发登出拦截。
- 遵循现有的设计风格系统：暗黑风格（Tailwind CSS `bg-[var(--bg-canvas)]`、`text-[var(--text-primary)]`、`border-[var(--border-subtle)]`），与终端及文件管理界面无缝融合。
- 所有用户可见文本必须支持中英文国际化，在 `frontend/src/i18n/locales/zh.ts` 与 `en.ts` 中定义对应条目。
- 页面空状态与无节点状态必须具备友好引导（提示接入节点或新建任务）。

## Review Focus

- **无节点选择或节点离线时的处理**：当 `activeHostId` 为空或节点断开连接时，界面必须给出清晰友好的提示，禁用“新建任务”与“立即运行”按钮，避免发起无效网络请求。
- **非法 Cron 格式前端拦截**：在 `CronJobModal` 提交时，如果 Cron 表达式不满足 5 字段标准或字段包含非法字符��表单应就地阻止提交并高亮提示，避免发送到后端报错。
- **Hub 脚本列表联动容错**：当选择“Hub 托管脚本”模式时，若后端 `/api/admin/scripts` 暂时为空或拉取失败，应提供友好提示并降级引导用户使用“直接命令”或先前往脚本库创建。
- **立即运行与日志查看无缝衔接**：在列表点击“立即运行”后，状态应变为 loading，轻提示成功触发，用户点击“查看日志”能立刻在 `CronLogModal` 中查看执行反馈与退出码。
- **暗黑终端日志弹窗长文本滚动与一键复制**：日志文本过长时必须支持垂直滚动且不破坏弹窗尺寸；一键复制按钮需具备已复制（Copied!）成功反馈状态。

---

### Task 1: 国际化词条字典扩展与基础类型定义 (i18n & Types)

**Files:**
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Create: `frontend/src/components/terminal/types/cron.ts`
- Test: `tests/frontendCronI18n.test.ts`

**Interfaces:**
- Produces:
  - `CronJobItem`, `CronExecutionRecord`, `CronJobSummary` in `frontend/src/components/terminal/types/cron.ts`
  - `cron` 命名空间下的完整词条（包含 `title`, `emptyTitle`, `emptyDesc`, `addJob`, `editJob`, `runNow`, `pause`, `resume`, `delete`, `logs`, `presets` 等）

- [x] **Step 1: 编写 i18n 词条完整性测试**

编写 `tests/frontendCronI18n.test.ts`：
验证 `zh` 和 `en` 均包含全部必需的 `cron.*` 键值。

```typescript
// tests/frontendCronI18n.test.ts
import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('Frontend Cron i18n Dictionary', () => {
  const requiredKeys = [
    'cron.title',
    'cron.tabName',
    'cron.addJob',
    'cron.editJob',
    'cron.deleteJob',
    'cron.deleteConfirm',
    'cron.runNow',
    'cron.runSuccess',
    'cron.pause',
    'cron.resume',
    'cron.logs',
    'cron.nextRun',
    'cron.lastStatus',
    'cron.duration',
    'cron.emptyTitle',
    'cron.emptyDesc',
    'cron.sourceCommand',
    'cron.sourceScript',
    'cron.modal.nameLabel',
    'cron.modal.cronLabel',
    'cron.modal.presetLabel',
    'cron.modal.concurrencyLabel',
    'cron.modal.timeoutLabel',
  ];

  it('contains all required cron keys in both zh and en dictionaries', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
```

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/frontendCronI18n.test.ts --detectOpenHandles --forceExit`
预期：FAIL（键值未定义）

- [x] **Step 3: 实现前端类型与中英文字典**

1. 创建 `frontend/src/components/terminal/types/cron.ts`：
   定义与后端对齐的 `CronJobConfig`, `CronExecutionRecord`, `CronJobSummary` 接口。
2. 在 `frontend/src/i18n/locales/en.ts` 与 `zh.ts` 中添加完整的中英文 `cron` 条目。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/frontendCronI18n.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts frontend/src/components/terminal/types/cron.ts tests/frontendCronI18n.test.ts
git commit -m "feat(frontend): add cron types and i18n translation dictionary"
```

---

### Task 2: 定时任务编辑弹窗与暗黑终端日志弹窗 (Modal Components)

**Files:**
- Create: `frontend/src/components/terminal/components/CronJobModal.tsx`
- Create: `frontend/src/components/terminal/components/CronLogModal.tsx`
- Test: `tests/frontendCronModals.test.ts`

**Interfaces:**
- Produces:
  - `export const CronJobModal: React.FC<CronJobModalProps>`
  - `export const CronLogModal: React.FC<CronLogModalProps>`

- [x] **Step 1: 编写组件结构与无 alert 规范测试**

编写 `tests/frontendCronModals.test.ts`：
1. 检查 `CronJobModal.tsx` 和 `CronLogModal.tsx` 源码，确保无原生 `alert()` 调用，均支持传入 `onClose` 和回调节流。
2. 检查 `CronJobModal` 包含快捷 Cron 预设（`* * * * *`, `*/5 * * * *`, `0 * * * *`, `0 2 * * *`, `0 9 * * 1-5`）。
3. 检查 `CronLogModal` 包含复制（`navigator.clipboard.writeText`）与刷新逻辑。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/frontendCronModals.test.ts --detectOpenHandles --forceExit`
预期：FAIL（文件未创建）

- [x] **Step 3: 实现两个模态框组件**

1. `CronJobModal.tsx`：
   - 包含任务名称、5 字段 Cron 表达式（带预设胶囊按钮，点击自动填入）；
   - 模式切换：`直接命令` vs `Hub 脚本`（调用 `/api/admin/scripts` 获得下拉选项）；
   - 高级配置折叠面板：`concurrency`（forbid/allow）、`timeoutMs`、`cwd`；
   - 表单验证：检查非空与简单 5 字段 Cron 语法（`^(\S+\s+){4}\S+$`）。
2. `CronLogModal.tsx`：
   - 暗黑终端窗口（黑色底色、等宽字体、绿色成功徽章/红色退出码徽章）；
   - 耗时展示与格式化触发时间；
   - 带有“复制日志”与“刷新”按钮。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/frontendCronModals.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add frontend/src/components/terminal/components/CronJobModal.tsx frontend/src/components/terminal/components/CronLogModal.tsx tests/frontendCronModals.test.ts
git commit -m "feat(frontend): implement CronJobModal and CronLogModal components"
```

---

### Task 3: 定时任务主管理视图组件 (TerminalCronView)

**Files:**
- Create: `frontend/src/components/terminal/TerminalCronView.tsx`
- Test: `tests/frontendTerminalCronView.test.ts`

**Interfaces:**
- Produces:
  - `export const TerminalCronView: React.FC<TerminalCronViewProps>`
    - `activeHostId?: string`
    - `adminKey?: string`
    - `isConnected?: boolean`

- [x] **Step 1: 编写主视图行为与 API 交互测试**

编写 `tests/frontendTerminalCronView.test.ts`：
1. 检查源码确保使用 `apiFetch` 访问 `/api/terminal/cron/`。
2. 检查支持显示任务列表（Name, Cron, Next Run, Last Status, Duration）。
3. 检查支持一键“立即运行”、“暂停/恢复”、“查看日志”与“删除”。
4. 检查具备 Toast 轻提示系统，无原生 `alert()`。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/frontendTerminalCronView.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 实现 `TerminalCronView.tsx`**

1. 状态管理：`jobs: CronJobSummary[]`、`isLoading`、`selectedJobForLogs`、`isJobModalOpen`、`editingJob`、`toast`。
2. API 对接：
   - 获取列表：`apiFetch('/api/terminal/cron/' + activeHostId)`
   - 新增/编辑任务：`apiFetch(..., { method: 'POST' | 'PATCH' })`
   - 手动运行：`apiFetch('/api/terminal/cron/' + activeHostId + '/' + jobId + '/run', { method: 'POST' })`
   - 暂停/恢复：`apiFetch('/api/terminal/cron/' + activeHostId + '/' + jobId, { method: 'PATCH', body: JSON.stringify({ status }) })`
   - 删除：`apiFetch('/api/terminal/cron/' + activeHostId + '/' + jobId, { method: 'DELETE' })`
3. 渲染结构：
   - 顶栏：当前节点名称、任务总数统计、刷新按钮、新建任务按钮。
   - 列表/表格：卡片式或响应式表格，包含状态指示灯、任务详情、下次运行倒计时、操作按钮。
   - 挂载 `CronJobModal` 与 `CronLogModal`，以及右上角浮动 Toast。

- [x] **Step 4: 运行测试验证通过**

运行：`npx jest tests/frontendTerminalCronView.test.ts --detectOpenHandles --forceExit`
预期：PASS

- [x] **Step 5: 提交任务代码**

```bash
git add frontend/src/components/terminal/TerminalCronView.tsx tests/frontendTerminalCronView.test.ts
git commit -m "feat(frontend): implement TerminalCronView component with job orchestration and toast feedback"
```

---

### Task 4: 集成到主控制台 (UnifiedTerminalView) 与全量构建验证

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/frontendUnifiedSubTabs.test.ts`

**Interfaces:**
- Produces:
  - `export type TerminalSubTab = 'interactive' | 'files' | 'cron';`
  - 顶栏 SubTab 胶囊区域展示时钟图标【定时任务】按钮。
  - 工作区根据 `subTab === 'cron'` 渲染 `<TerminalCronView />`。

- [x] **Step 1: 编写控制台 Tab 切换与渲染测试**

编写 `tests/frontendUnifiedSubTabs.test.ts`：
验证 `UnifiedTerminalView.tsx` 中包含 `'cron'` 子标签页，并在其 Tab 区域渲染时钟图标及对应文本。

- [x] **Step 2: 运行测试确认失败**

运行：`npx jest tests/frontendUnifiedSubTabs.test.ts --detectOpenHandles --forceExit`
预期：FAIL

- [x] **Step 3: 修改 `UnifiedTerminalView.tsx`**

1. 将 `TerminalSubTab` 扩展为 `'interactive' | 'files' | 'cron'`。
2. 引入 `Clock` 图标（来自 `lucide-react`）与 `TerminalCronView`。
3. 在 SubTab 切换区域增加【定时任务】按钮。
4. 在主视图区域添加条件分支：`subTab === 'cron' && <TerminalCronView ... />`。

- [x] **Step 4: 运行测试并通过前端构建**

运行：
1. `npx jest tests/frontendUnifiedSubTabs.test.ts --detectOpenHandles --forceExit`
2. `npm run build:frontend`
预期：PASS，TypeScript 类型检查与 Vite 打包 0 错误。

- [x] **Step 5: 提交任务代码**

```bash
git add frontend/src/components/UnifiedTerminalView.tsx tests/frontendUnifiedSubTabs.test.ts
git commit -m "feat(frontend): integrate cron subtab into UnifiedTerminalView and verify build"
```
