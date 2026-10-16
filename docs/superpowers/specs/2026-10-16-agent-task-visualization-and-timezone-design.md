# Agent 后台任务可视化与服务器时区展示设计规范

**日期**: 2026-10-16  
**状态**: 待评审 (Ready for Review)  

---

## 1. 概述与目标 (Overview & Goals)

本项目旨在增强 WebTerminal 控制台的可观测性与任务运维能力：
1. **Agent 任务可视化 (Task Management)**：在现有的命令行终端 (Interactive)、文件管理 (Files)、定时任务 (Cron) 基础上，新增「任务管理」(Tasks) 标签页。支持查看当前节点执行的后台任务列表、实时运行状态、退出码与耗时统计、实时日志查看 (Follow Log)、中止运行中任务 (Kill)，以及在 Web 端手动启动后台异步任务。
2. **服务器时区展示 (Server Timezone Badge)**：在控制台顶部导航栏全局常驻展示服务端统一时区（例如 `🌐 Asia/Shanghai`），并在任务与调度界面形成统一时间基准认知。

---

## 2. 架构设计与接口约定 (Architecture & APIs)

### 2.1 后端接口扩展与验证

#### 2.1.1 服务器时区下发
在以下通用元数据接口中，统一返回服务端的当前配置时区（`config.timeZone`）：
- `GET /api/terminal/hosts`
  - 返回对象新增 `timezone: string`（例：`"Asia/Shanghai"`）。
- `GET /api/terminal/version`
  - 返回对象新增 `timezone: string`。

#### 2.1.2 任务管理 API（复用并完善现有 Exec 服务）
- `GET /api/terminal/exec/:hostId`
  - 获取指定节点近期执行的任务列表。
  - 响应格式：
    ```json
    {
      "success": true,
      "hostId": "node-01",
      "tasks": [
        {
          "taskId": "task-1729000000-abc123",
          "command": "npm run build",
          "cwd": "/workspace/project",
          "status": "running" | "completed" | "failed" | "timeout" | "killed",
          "startTime": 1729000000000,
          "endTime": 1729000015000,
          "exitCode": 0,
          "signal": null,
          "error": null
        }
      ]
    }
    ```
- `GET /api/terminal/exec/:hostId/:taskId?offset=0`
  - 获取任务当前状态与输出流增量/全量日志。
- `POST /api/terminal/exec/:hostId`
  - 异步启动后台任务。
  - 请求体：
    ```json
    {
      "command": "python3 train.py",
      "cwd": "/home/user/app",
      "timeoutMs": 60000
    }
    ```
  - 响应：`202 Accepted`，返回 `{ success: true, taskId: "..." }`。
- `POST /api/terminal/exec/:hostId/:taskId/kill`
  - 终止任务。
  - 请求体：`{ "signal": "SIGTERM" | "SIGKILL" }`。

---

## 3. 前端界面与交互设计 (Frontend UI & UX)

### 3.1 导航栏与时区徽章 (UnifiedTerminalView)
1. **SubTab 扩展**：
   - 类型由 `'interactive' | 'files' | 'cron'` 扩展为 `'interactive' | 'files' | 'cron' | 'tasks'`。
   - 导航栏增加「任务管理」Tab，Icon 为 `Activity`，支持中英文自适应响应式布局。
2. **全局服务器时区徽章 (Timezone Badge)**：
   - 位于顶部导航栏状态指示区。
   - 胶囊样式：`🌐 Asia/Shanghai`（半透明背景，微边框）。
   - Tooltip 悬浮提示说明为系统调度与任务执行基准时区。

### 3.2 任务管理主视图 (TerminalTaskView)
1. **统计概览卡片 (Stat Cards)**：
   - 总任务数 (Total)
   - 运行中 (Running，带琥珀色呼吸灯动画)
   - 已完成 (Completed，绿色标识)
   - 异常/失败 (Failed/Timeout，红色标识)
2. **过滤与搜索栏**：
   - 关键字搜索：实时模糊匹配 Task ID 与 Command。
   - 状态筛选器：全部、运行中、已完成、已失败、已终止。
   - 操作按钮：手动刷新、新建任务。
3. **任务表格 (Task Table)**：
   - **Task ID**：等宽字体，支持一键快捷复制。
   - **Command**：代码块样式呈现，支持 Tooltip 完整查看。
   - **Status**：状态徽章展示（`running`, `completed`, `failed`, `timeout`, `killed`）。
   - **Start Time & Duration**：显示启动时间戳（格式化为本地可读时间），运行中显示动态耗时。
   - **Exit Code**：进程退出代码（`0`, `1`, `-`）。
   - **Actions**：
     - `查看日志`：弹出 TaskLogModal。
     - `终止任务`（仅 running 状态可用）：触发终止信号，二次确认后终止进程树。

### 3.3 实时日志弹窗 (TaskLogModal)
- 黑客风格终端面板，等宽字体，输出区分 stdout 与 stderr。
- **Follow Log 机制**：任务处于 running 状态时，每 1.5 秒轮询增量日志 (`offset`) 并平滑自动滚屏到底部。
- **快捷控制**：支持一键开启/暂停自动滚动、一键复制日志文本、直接在弹窗内终止当前运行任务。

### 3.4 新建任务弹窗 (CreateTaskModal)
- 表单项：
  - **Shell 命令**（必填，Textarea 多行或 Input 单行）。
  - **工作目录 CWD**（选填，支持输入绝对路径或 `~`）。
  - **超时时间 Timeout (秒)**（选填，默认 0 表示不超时）。
- 提交后调用 `POST /api/terminal/exec/:hostId`，自动拉取新任务并直接打开日志视窗。

---

## 4. 边界处理与容错机制 (Edge Cases & Resilience)

1. **节点离线 (Node Offline)**：
   - 当选中的节点处于离线或断连状态时，展示统一的 Empty State，禁用新建任务与终止操作，防止悬挂请求。
2. **性能与轮询控制**：
   - 仅当当前 SubTab 为 `tasks` 且存在 `running` 状态任务时启用定时拉取；切出 Tab 或组件卸载时立即清除计时器。
3. **大日志处理**：
   - 前端限制日志展示行数或字节数（最大保留 500KB 文本），避免浏览器 DOM 内存泄漏。

---

## 5. 国际化 (i18n)

在 `frontend/src/i18n/locales/zh.ts` 与 `en.ts` 中补充词条：
- 任务管理 Tab、标题与副标题；
- 状态名称（运行中、已完成、已失败、已超时、已终止）；
- 表头、操作项（查看日志、终止任务、新建任务、复制 ID 等）；
- 弹窗表单提示、空状态与确认对话框文案；
- 顶部服务器时区徽章提示文案。

---

## 6. 测试与验证计划 (Testing & Verification)

1. **后端 API 测试 (`tests/terminalTaskApi.test.ts`)**：
   - 测试 `GET /api/terminal/hosts` 和 `GET /api/terminal/version` 包含 `timezone` 字段。
   - 测试 `GET /api/terminal/exec/:hostId` 列表返回及过滤逻辑。
   - 测试 `POST /api/terminal/exec/:hostId` 创建后台任务与参数校验。
   - 测试 `POST /api/terminal/exec/:hostId/:taskId/kill` 发送终止信号。
2. **前端与编译验证**：
   - 执行 `npm run build:frontend`，确保所有组件、类型、i18n 引用零报错。
   - 执行 `npm run build:backend`，确保服务端编译正常。
   - 执行 `npm test -- tests/terminalTaskApi.test.ts` 与相关测试套件验证。
