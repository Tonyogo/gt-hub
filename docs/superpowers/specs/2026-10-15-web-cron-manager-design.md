# Web 端定时任务（Cron）管理页面设计规范 (Design Spec)

- **Date:** 2026-10-15
- **Author:** AI Assistant & yatao
- **Status:** Approved Draft

---

## 1. 目标与背景 (Goals & Background)

在之前的阶段中，`gt-hub` 已经在后端与 Agent 边缘端完整实现了分布式 Cron 调度引擎（包括本地持久化、防重叠并发保护、离线自愈）以及完整的 RESTful API 和 CLI 命令行工具（`gt cron`）。

目前用户在 Web 控制台（`UnifiedTerminalView`）中仅能使用“命令行终端”和“文件管理”。本规范的目标是：
1. **控制台体验一体化**：在 Web 控制台新增顶层子标签页【定时任务】（Cron），与终端和文件管理平级。
2. **可视化任务编排与监控**：支持可视化列表查看任务状态、Cron 表达式、下次触发倒计时、最近运行结果与耗时。
3. **双模创建/编辑**：支持直接输入 Shell 命令（含工作目录、超时）或关联选择 Hub 托管脚本（自动拉取已有脚本库），并提供常用 Cron 频率快捷填充与下次执行时间实时预览。
4. **即时调试与��端日志查看**：支持一键手动触发（Run）、暂停/恢复、删除，以及通过弹窗式暗黑终端日志查看器实时查看执行输出。
5. **双语国际化 (i18n)**：全量支持中文与英文无缝切换。

---

## 2. 架构设计与组件层级 (Architecture & Component Hierarchy)

### 2.1 组件树架构

```
UnifiedTerminalView.tsx (顶层主控台)
  ├── Top Window Bar
  │     ├── TerminalHostSelector (节点切换)
  │     └── SubTab Switcher: ['interactive', 'files', 'cron']
  └── Main Content Area
        ├── subTab === 'interactive' -> WebTerminalView
        ├── subTab === 'files'       -> TerminalFileManagerView
        └── subTab === 'cron'        -> TerminalCronView (新增独立主视图)
              ├── CronToolbar: 刷新、新建任务按钮、任务统计计数
              ├── CronJobList: 任务表格 / 卡片列表
              │     ├── 状态徽章 (Active / Paused / Running / Skipped / Failed)
              │     ├── 任务详情 (名称、Cron、脚本来源、参数、下次运行倒计时)
              │     └── 快捷操作列 (立即运行、暂停/恢复、查看日志、删除)
              ├── CronJobModal (创建 / 编辑任务弹窗)
              │     ├── 基础信息：任务名、Cron 表达式（带快捷预设胶囊 & 预览计算）
              │     ├── 来源选择：[直接命令] vs [Hub 托管脚本]
              │     └── 高级选项：并发重叠策略（forbid/allow）、超时时间
              └── CronLogModal (暗黑终端日志查看弹窗)
                    ├── 执行元数据：状态、退出码、耗时、启动时间
                    └── 输出内容区：带高亮与一键复制功能的 stdout/stderr 查看器
```

### 2.2 文件组织规划

- `frontend/src/components/terminal/TerminalCronView.tsx`：定时任务主页面组件。
- `frontend/src/components/terminal/components/CronJobModal.tsx`：创建与编辑任务模态框。
- `frontend/src/components/terminal/components/CronLogModal.tsx`：任务执行日志查看模态框。
- `frontend/src/components/UnifiedTerminalView.tsx`：扩展 SubTab 类型定义与顶栏切换入口。
- `frontend/src/i18n/locales/zh.ts` & `frontend/src/i18n/locales/en.ts`：补充完整的中英文字典条目。

---

## 3. 详细设计 (Detailed Design)

### 3.1 主视图设计 (`TerminalCronView.tsx`)

1. **生命周期与数据加载**：
   - 依赖传入的 `activeHostId` 和 `adminKey`。
   - 当 `activeHostId` 变化时，调用 `GET /api/terminal/cron/:activeHostId` 加载任务列表。
   - 提供自动静默轮询（每 10 秒刷新一次，用户切换标签页或失去焦点时暂停，避免无效网络消耗）。
   - 空状态（Empty State）：当节点未配置任何任务时，展示友好引导图标和“新建定时任务”快捷按钮；当节点未选中时展示“请先选择节点”。
2. **列表字段展现**：
   - **状态徽章 (Status Badge)**：
     - `Active`（绿圈闪烁或淡绿背景）
     - `Paused`（灰色）
     - `Running`（蓝色转圈，表示当前周期正在跑）
   - **任务标识**：任务名称（Title/Name）与任务唯一 ID。
   - **调度规则 (Cron & Next Run)**：Cron 表达式字符串（如 `0 2 * * *`）以及格式化的倒计时文本（如 `4 小时后` 或 `in 4 hours`）。
   - **执行来源**：标签区分【Shell 命令】或【Hub 脚本: xxx.sh】。
   - **最近执行结果 (Last Run)**：成功（绿）、失败（红）、跳过（黄），附带耗时（如 `12.4s`）与触发时间。
   - **操作栏 (Actions)**：
     - `立即运行`（Play 图标）：触发 `POST /api/terminal/cron/:hostId/:jobId/run`，显示 loading 并提示已派发。
     - `暂停 / 恢复`（Pause / Play 图标）：切换 `PATCH /api/terminal/cron/:hostId/:jobId`。
     - `查看日志`（FileText 图标）：打开 `CronLogModal`。
     - `删除`（Trash 图标）：带防误触确认。

### 3.2 创建与编辑弹窗 (`CronJobModal.tsx`)

1. **Cron 快捷预设胶囊**：
   - 提供一键快捷填充按钮：
     - `每 1 分钟` (`* * * * *`)
     - `每 5 分钟` (`*/5 * * * *`)
     - `每小时` (`0 * * * *`)
     - `每天凌晨 2 点` (`0 2 * * *`)
     - `工作日 9 点` (`0 9 * * 1-5`)
   - 用户点击后自动填入输入框，同时支持任意自定义 5 字段 Cron 输入。
2. **来源双模切换**：
   - **直接命令 (Command)**：
     - 命令多行文本框（Monospace 字体，支持换行）。
     - 工作目录（CWD，默认节点主目录）。
   - **Hub 托管脚本 (Hub Script)**：
     - 自动调用 `GET /api/admin/scripts` 获取 Hub 已保存的脚本列表，下拉单选。
     - 脚本入参（Args，可选文本输入）。
3. **高级折叠选项**：
   - 并发重叠策略（默认 `forbid` 禁止重叠，可选 `allow` 允许并发）。
   - 超时控制（单位：秒或毫秒，默认不超时）。

### 3.3 终端风格日志查看弹窗 (`CronLogModal.tsx`)

1. **头部信息**：
   - 任务名与执行 ID（`executionId`）。
   - 退出码徽章（Exit Code: `0` 绿色，非 0 红色）。
   - 执行状态（Completed / Failed / Skipped / Timeout）与总耗时。
2. **终端输出视窗**：
   - 黑色背景终端风格（`bg-slate-950 font-mono text-xs text-slate-200`），自适应垂直滚动。
   - 若状态为 `skipped`，显示跳过原因提示（例如：前一次任务尚未结束，因重叠策略自动跳过）。
3. **辅助功能**：
   - 一键复制完整日志（带已复制提示）。
   - 重新刷新日志按钮。

---

## 4. API 契约与对接规范 (API Contract)

前端将直接复用第一阶段已实现的后端接口（由 `x-admin-key` 保护）：

| 方法 | 路径 | 作用 | 请求参数 / Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/terminal/cron/:hostId` | 获取节点任务列表 | 无 |
| `POST` | `/api/terminal/cron/:hostId` | 新建定时任务 | `{ name, cron, source, command?, scriptName?, scriptArgs?, cwd?, timeoutMs?, concurrency }` |
| `PATCH` | `/api/terminal/cron/:hostId/:jobId` | 暂停/恢复/编辑 | `{ status: 'active' \| 'paused', ... }` |
| `DELETE` | `/api/terminal/cron/:hostId/:jobId` | 删除任务 | 无 |
| `POST` | `/api/terminal/cron/:hostId/:jobId/run` | 立即手动触发一次 | 无 |
| `GET` | `/api/terminal/cron/:hostId/:jobId/logs` | 获取执行日志详情 | 无 |
| `GET` | `/api/admin/scripts` | 读取 Hub 脚本库列表 | 无（复用现有 ScriptService 接口） |

---

## 5. 异常处理与边界防御 (Resilience & Edge Cases)

1. **节点离线与未就绪**：
   - 若 `activeHostId` 为空或目标节点离线，视图显示“节点离线或未连接”，禁用新建与运行按钮，但仍可查看已缓存的配置数据。
2. **非法 Cron 表达式防御**：
   - 表单提交前在前端做基本的 5 字段空格与正则校验，若格式错误给出红色提示文字，不发起无效请求。
3. **网络与接口失败容错**：
   - 任何 API 异常均弹出友好的错误轻提示（Toast），不破坏现有页面交互。

---

## 6. 测试与验证策略 (Testing Strategy)

1. **组件渲染与交互测试 (`tests/frontendTerminalCronView.test.tsx`)**：
   - 测试无节点、空任务列表、以及展示已有任务列表时的状态渲染。
   - 测试点击“立即运行”、“暂停/恢复”时发起的 API 请求。
   - 测试打开与关闭 `CronJobModal` 及 `CronLogModal`。
2. **构建与类型验证**：
   - 运行前端编译构建：`npm run build:frontend`，确保 TypeScript 类型与 Vite 打包 0 错误。
