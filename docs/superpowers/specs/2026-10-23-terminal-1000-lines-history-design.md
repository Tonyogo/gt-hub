# 终端历史统一限制 1000 行性能优化设计文档

- **日期**：2026-10-23
- **状态**：已确认

## 1. 背景与目标

当前 `gt-hub` 终端在不同层级的历史缓冲策略存在差异且上限偏大：
1. **前端 `WebTerminalView.tsx`**：`xterm.js` 的 `scrollback` 默认在桌面端为 `8000` 行、移动端为 `3000` 行；在高频输出、窗口尺寸重排（reflow）以及文本选择计算时，较大的行缓冲会增加主线程 CPU 与内存开销。
2. **后端 Hub 与 Agent `TerminalHistoryBuffer`**：仅按 `1MB` 字节上限裁剪，未限制行数；在短行输出场景下，`1MB` 可能累积上万行历史数据，导致重连或切换节点时一次性回放大量历史流，阻塞前端解析与渲染。
3. **前端后台缓冲队列 `BackgroundBufferQueue`**：仅按 `2MB` 字节上限裁剪，当用户停留在其他子标签页（如任务、文件管理、日志）且终端持续输出时，切回终端标签页会一次性刷入过多历史行。

**优化目标**：
全链路统一将终端历史上限收敛为 **最多保留最近 1000 行**，同时保留原有的字节上限兜底（防止单行超长无换行数据撑爆内存）以及 Alternate Screen（`\x1b[?1049h` ... `\x1b[?1049l`）全屏 TUI 帧隔离机制，全面提升终端实时响应、标签页切换与重连回放性能。

---

## 2. 方案选型

采用 **实时增量行计数 + 字节/行数双重上限** 方案：
- 在数据推入（`push`）阶段增量统计换行符 `\n`（`0x0a`）数量，维护每个分块的行数数组与总行数。
- 超出 `maxLines`（默认 `1000`）时，直接从头部 chunk 整块弹出（$O(1)$）或在首个跨越边界的 chunk 内按第 `excessLines` 个 `\n` 切片。
- `getBuffer()` / `drain()` 读取时无需重复全量扫描，兼顾写入与读取的高性能。

---

## 3. 详细设计

### 3.1 后端与 Agent 历史缓存层 (`src/agent/pty/terminalHistoryBuffer.ts`)

1. **常量与构造函数签名**
   ```ts
   export const DEFAULT_MAX_HISTORY_BYTES = 1 * 1024 * 1024; // 1MB 字节安全上限
   export const DEFAULT_MAX_HISTORY_LINES = 1000;            // 1000 行历史上限

   constructor(
     maxBytes: number = DEFAULT_MAX_HISTORY_BYTES,
     clearOnEd3: boolean = true,
     maxLines: number = DEFAULT_MAX_HISTORY_LINES
   )
   ```
   - 保持向后兼容：`daemon.ts` 与 `RemoteAgentTerminalSession` 现有调用自动继承 `maxLines = 1000`。
   - `this.maxLines = Math.max(1, maxLines)`。

2. **内部状态与增量计数**
   - 新增字段：
     - `private chunkLineCounts: number[] = []`（与 `this.chunks` 一一对应，记录每个 `Buffer` 分块中 `0x0a` 的数量）
     - `private totalLines: number = 0`（普通屏幕缓冲区中的总换行符数）
   - 辅助函数：
     - `countNewlines(buf: Buffer): number`：遍历统计 `buf` 中 `0x0a` 的个数。
     - `findNthNewlineIndex(buf: Buffer, n: number): number`：在 `buf` 中查找第 `n` 个（从 1 开始计数）`0x0a` 的字节下标。

3. **普通缓冲区写入与裁剪 (`pushNormal`)**
   - 当检测到 `clearOnEd3` 且存在 `\x1b[3J` 时：清空 `chunks`、`chunkLineCounts`、`totalBytes`、`totalLines`，仅推入 `\x1b[3J` 起的尾部切片及其换行数。
   - 正常推入时：计算 `buf` 的换行数 `lines`，追加到 `chunks` 和 `chunkLineCounts`，累加 `totalBytes` 与 `totalLines`。
   - **字节上限裁剪（`totalBytes > maxBytes`）**：
     - 若 `head.length <= excessBytes`：弹出 `chunks.shift()` 和 `chunkLineCounts.shift()`，扣减 `totalBytes` 与 `totalLines`。
     - 若 `head.length > excessBytes`：截取 `this.chunks[0] = head.subarray(excessBytes)`，重新统计新 `this.chunks[0]` 的换行数并更新 `chunkLineCounts[0]` 与 `totalLines`。
   - **行数上限裁剪（`totalLines > maxLines`）**：
     - 循环处理直到 `totalLines <= maxLines` 或 `chunks.length === 0`：
       - 计算超出换行数 `excessLines = this.totalLines - this.maxLines`。
       - 若队首分块的换行数 `this.chunkLineCounts[0] === 0`：
         - 说明该分块只是被拆散的旧行前半截（尚未到达第一个换行符），直接整块弹出：`this.totalBytes -= head.length`，`this.chunkLineCounts.shift()`，`this.chunks.shift()`。
       - 若 `this.chunkLineCounts[0] <= excessLines`：
         - 在 `head` 中定位最后一个（即第 `this.chunkLineCounts[0]` 个）`0x0a` 的下标 `idx`。
         - 若 `idx === head.length - 1`（分块恰好以 `\n` 结尾）：直接整块弹出，扣减 `totalBytes` 与 `totalLines`。
         - 若 `idx < head.length - 1`（分块末尾带有下一行的前缀，且此时 `this.chunkLineCounts[0] === excessLines`）：不能把下一行的前缀一起丢掉，因此将 `this.chunks[0]` 切片为 `head.subarray(idx + 1)`，将 `this.chunkLineCounts[0]` 置为 `0`，并扣减被截掉部分的字节数与换行数。
       - 若 `this.chunkLineCounts[0] > excessLines`：
         - 在 `head` 中定位第 `excessLines` 个 `0x0a` 的下标 `idx = findNthNewlineIndex(head, excessLines)`。
         - 将队首分块切片为 `head.subarray(idx + 1)`（若切片长度为 0 则直接 `shift()` 移除该空分块）。
         - 更新 `this.totalBytes`、`this.chunkLineCounts[0] -= excessLines`、`this.totalLines -= excessLines`。
   - **`clear()` 与 `\x1bc` RIS 重置**：
     - 同步重置 `this.chunkLineCounts = []` 和 `this.totalLines = 0`。

4. **UTF-8 编码安全性**
   - 在 UTF-8 编码规范中，ASCII 换行符 `0x0a` 绝不会出现在任何多字节字符的后续字节（`0x80..0xFF`）中。因此按 `0x0a` 下标 `idx + 1` 对 `Buffer` 进行 `subarray` 切片，天然对齐在完整的 UTF-8 字符边界上，不会产生乱码。

### 3.2 前端后台缓冲队列 (`frontend/src/utils/terminalStreamHelper.ts`)

1. **构造函数扩展**
   ```ts
   export class BackgroundBufferQueue {
     private chunks: string[] = [];
     private chunkLineCounts: number[] = [];
     private totalBytes: number = 0;
     private totalLines: number = 0;
     private readonly maxBytes: number;
     private readonly maxLines: number;
     private decoder: TextDecoder = new TextDecoder('utf-8');

     constructor(maxBytes: number = 2 * 1024 * 1024, maxLines: number = 1000) {
       this.maxBytes = Math.max(1, maxBytes);
       this.maxLines = Math.max(1, maxLines);
     }
   ```
2. **写入与裁剪逻辑 (`push` / `drain` / `clear`)**
   - `push` 时统计字符串 `str` 中的 `\n` 数量，同步推入 `chunks` 和 `chunkLineCounts`。
   - 先���行 `totalBytes > maxBytes` 字节上限裁剪（若部分截断 `chunks[0]` 则重算其换行数）。
   - 再执行 `totalLines > maxLines` 行数上限裁剪（与 `TerminalHistoryBuffer` 逻辑一致，超出时按第 `excessLines` 个 `\n` 截断头部旧行）。
   - `drain()` 和 `clear()` 时同步重置 `chunkLineCounts = []` 与 `totalLines = 0`。

### 3.3 前端 `xterm.js` Scrollback 配置 (`frontend/src/components/WebTerminalView.tsx`)

在 `WebTerminalView.tsx` 初始化 `Terminal` 实例处：
```ts
const MAX_SCROLLBACK_LINES = 1000;
const defaultScrollback = MAX_SCROLLBACK_LINES;
const configuredScrollback = typeof localStorage !== 'undefined'
  ? parseInt(localStorage.getItem('terminal_scrollback_lines') || '', 10)
  : NaN;
const scrollback = !isNaN(configuredScrollback) && configuredScrollback > 0
  ? Math.min(configuredScrollback, MAX_SCROLLBACK_LINES)
  : defaultScrollback;
```
- 桌面端与移动端统一默认 `1000` 行，且对 `localStorage` 中的自定义配置以 `1000` 行封顶。

---

## 4. 测试与验证计划

1. **`tests/terminalHistoryBuffer.test.ts`**：
   - 验证默认 `maxLines = 1000`：当连续推入 1500 行文本时，缓冲区仅保留最后 1000 行（第 501 行至第 1500 行），第 1~500 行被淘汰。
   - 验证自定义 `maxLines`（如 `new TerminalHistoryBuffer(1024 * 1024, true, 5)`）在单次多行块、跨分块无换行前缀、以及混合 `\x1bc` / `\x1b[3J` / Alternate Screen 场景下的准确性。
2. **`tests/terminalPerformanceOptimization.test.ts`**：
   - 验证 `BackgroundBufferQueue` 在推入超过 1000 行（或自定义 `maxLines`）时只保留最近 `maxLines` 行。
   - 更新 `WebTerminalView` 的 `scrollback` 集成规范测试，验证统一采用 `1000` 行上限。
3. **回归测试**：
   - 运行 `tests/terminalDeflateAndBufferLimit.test.ts`、`tests/terminalPersistence.test.ts`、`tests/terminalNonFullscreenStability.test.ts`，确保所有既有测试全部通过。
