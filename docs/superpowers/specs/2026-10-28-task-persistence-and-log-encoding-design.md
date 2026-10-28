# 后台任务持久化恢复与执行日志乱码修复设计文档

- **日期**：2026-10-28
- **状态**：已确认

## 1. 背景与问题分析

当前 `gt-hub` 的后台任务管理模块（`TaskManager`）与日志查看器（`TaskLogModal` / `CronLogModal`）存在以下两个核心痛点：

1. **Agent 重启后历史任务与日志全部丢失**：
   - `src/agent/tasks/taskManager.ts` 中的 `TaskManager` 将所有任务记录保存在纯内存 `Map<string, TaskRecord>` 中，没有任何磁盘持久化机制。一旦 `gt agent` 守护进程重启或升级，所有任务列表与执行日志立刻清空。
2. **执行日志存在部分乱码现象**：
   - **ANSI 控制码乱码**：`TaskManager` 启动子进程时注入了 `TERM: 'xterm-256color'` 与 `COLORTERM: 'truecolor'`，使命令行工具输出大量 ANSI 颜色序列（如 `\x1b[32m`）、私有光标控制序列（如 `\x1b[?25l`、`\x1b[2K`）以及同行进度条回车覆写（`\r`）。而前端 `TaskLogModal` 和 `CronLogModal` 使用普通 `<div>` 直接渲染原始文本，导致不可见的 `ESC`（`\x1b`）渲染为方块乱码（``），且颜色控制参数直接暴露在正文中。
   - **UTF-8 多字节字符截断乱码**：在按字节偏移 `offset` 增量读取日志或按 `MAX_BUFFER_SIZE` 裁剪缓冲区时，若切片边界恰好落在 3 字节中文字符或 4 字节 Emoji 的中间字节，会产生 `U+FFFD`（``）替换字符乱码。
   - **Locale 回退不当**：当宿主机未设置 `LANG` 时，代码硬编码回退至 `en_US.UTF-8`；在仅安装了 `C.UTF-8` 的精简 Linux 容器中，会导致子进程退化为 7-bit ASCII 编码。

---

## 2. 架构设计

### 2.1 任务与日志磁盘持久化（`src/agent/tasks/taskManager.ts`）

1. **存储目录结构（`~/.gt/tasks/`）**：
   - 支持在 `new TaskManager(options?: { storageDir?: string })` 中指定存储目录，默认路径为 `path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'tasks')`。
   - **元数据索引文件**：`<storageDir>/tasks.json`
     - 存储任务元数据列表（`taskId`, `command`, `cwd`, `status`, `exitCode`, `startTime`, `endTime`, `pid`, `totalBytes`）。
     - 通过原子写入（先写 `tasks.json.tmp` 再 `fs.renameSync`）确保持久化安全。
   - **独立任务日志文件**：`<storageDir>/logs/<taskId>.log`
     - 任务产生输出时，除更新内存缓冲区外，同步追加写入对应的 `<taskId>.log`。
     - 当单个日志文件超过 `MAX_BUFFER_SIZE`（5MB）时，自动裁剪保留尾部最新数据。
     - 当 `pruneOldTasks()` 淘汰超过 24 小时或超出 `MAX_TASKS`（100 条）的任务时，同步删除磁盘上的 `<taskId>.log` 文件并更新 `tasks.json`。

2. **跨重启恢复与运行中进程跟踪（`loadFromDisk()`）**：
   - `TaskManager` 实例化时调用 `loadFromDisk()` 读取 `tasks.json`：
     - 将历史任务恢复至 `this.tasks`。当内存 `chunks` 为空且请求 `getTask(taskId, offset)` 时，直接从 `<storageDir>/logs/<taskId>.log` 按字节偏移读取。
     - 对恢复时状态仍为 `'running'` 的任务：
       - 检查其 `pid` 是否存活（`isPidAlive(pid)`，调用 `process.kill(pid, 0)`）：
       - 若进程仍存活：保持 `status = 'running'`，启动后台监控定时器（每 1.5s 检查 `pid` 状态并同步 `.log` 文件字节数），待进程退出后将状态更新为 `'completed'`、`endTime = Date.now()` 并落盘。
       - 若进程已退出：立即将状态收敛为 `'completed'`（若 `exitCode === null` 则置为 `0`），记录 `endTime` 并保存 `tasks.json`。

### 2.2 UTF-8 字节边界对齐与 Locale 探测（`src/agent/tasks/taskManager.ts`）

1. **UTF-8 边界安全切片（`sliceBufferUtf8Safe(buf: Buffer, startOffset: number): string`）**：
   - 在从内存 Buffer 或磁盘 `.log` 文件按 `offset` 切片时：
     - 若 `startOffset > 0` 且 `buf[startOffset]` 是 UTF-8 多字节序列的后续字节（`(byte & 0b11000000) === 0b10000000`），向前或向后对齐到合法的 UTF-8 字符起始字节，杜绝半个汉字解码出 `�`（``）。
   - 在缓冲区超限裁剪（`slice(-MAX_BUFFER_SIZE)`）时，若首字符为孤立的低位代理项（Low Surrogate `0xDC00..0xDFFF`）或 `�`，自动跳过首字符。
2. **Locale 智能回退（`resolveUtf8Locale(envLang?: string): string`）**：
   - 若传入或环境中的 `LANG` / `LC_ALL` 已包含 `UTF-8` 或 `utf8`（不区分大小写），直接沿用。
   - 否则在 Linux 平台默认回退为 `C.UTF-8`（POSIX 标准内置 UTF-8 Locale），在 macOS / 其他平台回退为 `en_US.UTF-8`，并同时设置 `LC_CTYPE` 为相同 UTF-8 值。

### 2.3 前端 ANSI 控制码清洗与彩色日志渲染（`frontend/src/utils/ansiLogFormatter.ts`）

1. **新增工具模块 `frontend/src/utils/ansiLogFormatter.ts`**：
   - **`normalizeTerminalLogText(raw: string): string`**：
     - 将 `\r\n` 统一归一化处理，对同行内的孤立回车 `\r`（进度条覆写，如 `10%\r20%\r100%\n`）模拟终端同行覆写行为，仅保留最后一次覆写后的行内容；处理退格符 `\b`。
     - 剥除所有非 SGR 颜色类的终端控制序列：CSI 光标/屏幕控制序列（`\x1b\[[0-9;?]*[A-LN-Za-ln-z]`）、OSC 序列（`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`）、单字符转义序列及残留的裸 `\x1b` / `\x00-\x08` / `\x0B-\x1F` 控制字符。
   - **`stripAnsiCodes(raw: string): string`**：
     - 先执行 `normalizeTerminalLogText(raw)`，再剥除所有 `\x1b\[[0-9;]*m` SGR 颜色序列，生成纯净文本，用于「复制日志」功能。
   - **`parseAnsiToSegments(raw: string): AnsiLogSegment[]`**：
     - 输入原始日志文本，先执行 `normalizeTerminalLogText`，再解析 `\x1b\[([0-9;]*)m` SGR 颜色与加粗指令（支持 `0` 重置、`1` 加粗、`30-37` 标准前景色、`90-97` 高亮前景色、`38;5;n` / `38;2;r;g;b` 基础映射或安全忽略），返回 `{ text: string; colorClass?: string; bold?: boolean }[]`。
2. **集成到 `TaskLogModal.tsx` 与 `CronLogModal.tsx`**：
   - 在 `TaskLogModal.tsx` 和 `CronLogModal.tsx` 中使用 `parseAnsiToSegments` 渲染彩色日志片段；
   - 点击「复制日志」时调用 `stripAnsiCodes` 复制不含任何转义码的干净文本。

---

## 3. 测试与验证计划

1. **单元测试（`tests/taskPersistenceAndAnsiLogs.test.ts`）**：
   - 验证 `TaskManager` 将任务元数据写入 `tasks.json` 并将日志写入 `logs/<taskId>.log`。
   - 验证模拟 Agent 重启（使用同一 `storageDir` 创建新的 `TaskManager` 实例）后，`listTasks()` 和 `getTask(taskId, offset)` 能完整恢复历史任务与增量日志，且对运行中/已退出的 `pid` 正确更新状态。
   - 验证多字节中文与 Emoji 在任意字节 `offset` 切片下均不会产生 `�`（``）乱码。
   - 验证 `ansiLogFormatter.ts` 对进度条 `\r` 覆写、`\x1b[?25l` / `\x1b[2K` 乱码控制符的清理，以及 `\x1b[32m` / `\x1b[1;31m` 等 SGR 颜色片段的解析。
2. **回归测试**：
   - 运行既有 `tests/terminalTaskManager.test.ts`、`tests/terminalTaskApi.test.ts` 及前端构建 `npm run build`，确保零回归报错。
