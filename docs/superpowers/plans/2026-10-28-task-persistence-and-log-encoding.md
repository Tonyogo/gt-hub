# Task Persistence Across Agent Restarts & ANSI Log Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist background tasks and their output logs to `~/.gt/tasks/` so tasks and logs survive `gt agent` restarts, and eliminate garbled task/cron log rendering by aligning UTF-8 byte slices and rendering ANSI color/control sequences cleanly in the frontend.

**Architecture:**
1. Extend `TaskManager` (`src/agent/tasks/taskManager.ts`) with optional disk persistence (`storageDir`, enabled for the singleton `taskManager` at `~/.gt/tasks` and configurable in `new TaskManager({ storageDir })` while defaulting to an isolated temp/opt-in path when `new TaskManager()` is called without arguments in unit tests if needed, or persisted to `~/.gt/tasks` with `loadFromDisk()`). Store metadata in `<storageDir>/tasks.json` and append task output to `<storageDir>/logs/<taskId>.log`. Add `sliceBufferUtf8Safe` and `resolveUtf8Locale` to prevent `U+FFFD` (``) multi-byte truncation and ASCII locale fallback.
2. Create `frontend/src/utils/ansiLogFormatter.ts` to handle carriage-return (`\r`) progress overwrite, strip non-printable terminal control sequences (`\x1b[?25l`, `\x1b[2K`, OSC, bare `\x1b`), strip ANSI codes for clipboard copy (`stripAnsiCodes`), and parse SGR color/bold codes into styled segments (`parseAnsiToSegments`) consumed by `TaskLogModal.tsx` and `CronLogModal.tsx`.

**Tech Stack:** Node.js (`fs`, `path`, `os`, `child_process`), TypeScript, React 18, Tailwind CSS, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-task-persistence-and-log-encoding-design.md`

## Global Constraints

- Backward compatibility: `tests/terminalTaskManager.test.ts` calls `new TaskManager()` in `beforeEach` and expects a clean task list (`expect(listRes.tasks.length).toBe(2)`). Therefore:
  - `new TaskManager(options?: { storageDir?: string; persist?: boolean })`: when `options?.storageDir` is provided OR `options?.persist === true`, load and persist to `options.storageDir || path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'tasks')`.
  - The exported singleton `export const taskManager = new TaskManager({ persist: true });` enables disk persistence at `~/.gt/tasks` automatically for the Agent daemon!
- UTF-8 byte offset slicing in `getTask(taskId, offset)` must never split a multi-byte UTF-8 sequence and must never produce `�` (``).
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

- Calling `getTask(taskId, offset)` where `offset` lands on byte 1 or byte 2 of a 3-byte Chinese character (e.g., `'中文测试'`) or a 4-byte emoji must align to the character boundary so `output` contains zero `�` characters.
- When `TaskManager` restarts (`new TaskManager({ storageDir })` pointing to an existing directory), `listTasks()` must return previously saved tasks and `getTask(taskId, 0)` must read the full persisted log from `<storageDir>/logs/<taskId>.log` even though in-memory `chunks` is empty.
- When a persisted task had `status: 'running'` before restart and its `pid` is no longer alive (`process.kill(pid, 0)` throws), `loadFromDisk()` must transition its status to `'completed'` (with `exitCode: 0` if `null`) and set `endTime`.
- Progress bar output containing carriage returns (`"Downloading 10%\rDownloading 50%\rDownloading 100%\n"`) must normalize to `"Downloading 100%\n"`, and private CSI/OSC sequences (`"\x1b[?25l\x1b[2K\x1b[32m✔ Build passed\x1b[0m\x1b[?25h"`) must strip the cursor/erase codes and produce a green segment (`colorClass: 'text-emerald-400'`) with text `"✔ Build passed"`.
- Clicking "Copy Logs" in `TaskLogModal` or `CronLogModal` must copy `stripAnsiCodes(logText)` so no raw `\x1b[...` escape codes pollute the user's clipboard.

---

### Task 1: `TaskManager` Disk Persistence, Cross-Restart Recovery & UTF-8 Boundary Alignment

**Files:**
- Modify: `src/agent/tasks/taskManager.ts`
- Test: `tests/taskPersistenceAndUtf8.test.ts`

**Interfaces:**
- Produces (in `src/agent/tasks/taskManager.ts`):
  - `sliceBufferUtf8Safe(buf: Buffer, startOffset: number): string` — advances `startOffset` past any UTF-8 continuation bytes (`(buf[i] & 0xc0) === 0x80`) so `buf.subarray(alignedStart).toString('utf-8')` never emits `�` at the boundary.
  - `resolveUtf8Locale(env?: Record<string, any>): string` — returns existing `env?.LANG` or `process.env.LANG` if it includes `'utf-8'` or `'utf8'` (case-insensitive); otherwise returns `'C.UTF-8'` on Linux and `'en_US.UTF-8'` on other platforms.
  - `TaskManagerOptions { storageDir?: string; persist?: boolean }`
  - `new TaskManager(options?: TaskManagerOptions)`:
    - When `options?.storageDir` or `options?.persist` is truthy, sets `this.storageDir` (defaulting to `path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'tasks')`), ensures `<storageDir>/logs` exists, and calls `this.loadFromDisk()`.
    - Persists task metadata to `<storageDir>/tasks.json` on task start, completion/error/timeout/kill, and pruning.
    - Appends decoded task output to `<storageDir>/logs/<taskId>.log`.
    - In `getTask(taskId, offset)`: if in-memory `task.chunks` is empty and a log file exists at `<storageDir>/logs/<taskId>.log`, reads the log file buffer, updates `totalBytes = fileBuf.length`, and slices from `numOffset` using `sliceBufferUtf8Safe`.
    - Exports singleton `export const taskManager = new TaskManager({ persist: true });`.

- [x] **Step 1: Write the failing test in `tests/taskPersistenceAndUtf8.test.ts`**

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  TaskManager,
  sliceBufferUtf8Safe,
  resolveUtf8Locale,
} from '../src/agent/tasks/taskManager';

describe('TaskManager Disk Persistence & UTF-8 Safe Slicing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `gt-task-persist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('sliceBufferUtf8Safe aligns mid-character byte offsets for Chinese and Emoji without U+FFFD', () => {
    const sample = '你好世界🚀测试日志';
    const buf = Buffer.from(sample, 'utf-8');

    for (let offset = 0; offset <= buf.length; offset++) {
      const sliced = sliceBufferUtf8Safe(buf, offset);
      expect(sliced).not.toContain('�');
      expect(sample.endsWith(sliced)).toBe(true);
    }
  });

  test('resolveUtf8Locale preserves existing UTF-8 LANG or falls back to C.UTF-8 on Linux', () => {
    expect(resolveUtf8Locale({ LANG: 'zh_CN.UTF-8' })).toBe('zh_CN.UTF-8');
    const fallback = resolveUtf8Locale({ LANG: 'POSIX' });
    expect(fallback.toLowerCase()).toContain('utf-8');
  });

  test('persists task metadata and logs to disk and recovers them across TaskManager restart', async () => {
    const tm1 = new TaskManager({ storageDir: tempDir });
    const startRes = tm1.startTask({
      taskId: 'persist-task-1',
      command: 'echo "持久化日志第一行" && echo "第二行告警" >&2',
    });
    expect(startRes.success).toBe(true);

    // Wait for task completion
    let poll1: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 80));
      poll1 = tm1.getTask('persist-task-1', 0);
      if (poll1.status === 'completed' || poll1.status === 'failed') break;
    }
    expect(poll1.status).toBe('completed');
    expect(poll1.output).toContain('持久化日志第一行');
    expect(poll1.output).toContain('第二行告警');

    // Verify files exist on disk
    expect(fs.existsSync(path.join(tempDir, 'tasks.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'logs', 'persist-task-1.log'))).toBe(true);

    // Simulate Agent restart by creating a brand new TaskManager instance on the same storageDir
    const tm2 = new TaskManager({ storageDir: tempDir });
    const listRes = tm2.listTasks(10);
    expect(listRes.success).toBe(true);
    expect(listRes.tasks.length).toBe(1);
    expect(listRes.tasks[0].taskId).toBe('persist-task-1');
    expect(listRes.tasks[0].status).toBe('completed');

    // Poll full and partial offset from disk after restart
    const recoveredFull = tm2.getTask('persist-task-1', 0);
    expect(recoveredFull.success).toBe(true);
    expect(recoveredFull.output).toContain('持久化日志第一行');
    expect(recoveredFull.output).toContain('第二行告警');

    // Poll mid-character offset (byte 1 of a 3-byte Chinese character)
    const recoveredMid = tm2.getTask('persist-task-1', 1);
    expect(recoveredMid.output).not.toContain('�');
    expect(recoveredMid.output).toContain('久化日志第一行');
  });

  test('reconciles stale running task to completed on restart when PID is no longer alive', () => {
    const logDir = path.join(tempDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'stale-running-1.log');
    fs.writeFileSync(logPath, 'partial output before agent restart\n', 'utf-8');

    const fakeTasksJson = [
      {
        taskId: 'stale-running-1',
        command: 'echo "done"',
        cwd: tempDir,
        status: 'running',
        exitCode: null,
        startTime: Date.now() - 5000,
        endTime: null,
        pid: 99999999, // non-existent PID
        totalBytes: Buffer.byteLength('partial output before agent restart\n'),
      },
    ];
    fs.writeFileSync(path.join(tempDir, 'tasks.json'), JSON.stringify(fakeTasksJson, null, 2), 'utf-8');

    const tm = new TaskManager({ storageDir: tempDir });
    const taskRes = tm.getTask('stale-running-1', 0);
    expect(taskRes.success).toBe(true);
    expect(taskRes.status).toBe('completed');
    expect(taskRes.output).toContain('partial output before agent restart');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/taskPersistenceAndUtf8.test.ts`
Expected: FAIL (`sliceBufferUtf8Safe is not a function`)

- [x] **Step 3: Implement `sliceBufferUtf8Safe`, `resolveUtf8Locale`, and disk persistence in `src/agent/tasks/taskManager.ts`**

1. Export `sliceBufferUtf8Safe(buf: Buffer, startOffset: number): string`:
   - Clamp `let idx = Math.max(0, Math.min(startOffset, buf.length));`
   - While `idx < buf.length && (buf[idx] & 0b11000000) === 0b10000000`, increment `idx++` to skip UTF-8 continuation bytes.
   - Return `buf.subarray(idx).toString('utf-8')`.
2. Export `resolveUtf8Locale(env?: Record<string, any>): string`:
   - Check `const candidate = env?.LANG || env?.LC_ALL || process.env.LANG || process.env.LC_ALL || '';`
   - If `/utf-?8/i.test(candidate)` return `candidate`.
   - Return `os.platform() === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8'`.
3. Add `pid?: number | null` to `TaskRecord` and `storageDir: string | null` to `TaskManager`:
   - Constructor `constructor(options?: { storageDir?: string; persist?: boolean })`:
     - If `options?.storageDir || options?.persist`, set `this.storageDir = options.storageDir || path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'tasks')` and call `this.loadFromDisk()`. Otherwise `this.storageDir = null`.
   - Implement `private getLogFilePath(taskId: string): string | null`, `private saveToDisk(): void`, `private appendToLogFile(taskId: string, text: string): void`, and `private loadFromDisk(): void`.
   - In `getTask(taskId, offset)`:
     - When `task.chunks.length > 0`, use `sliceBufferUtf8Safe(Buffer.from(chunk.text, 'utf-8'), numOffset - chunk.startOffset)` for the boundary chunk.
     - When `task.chunks.length === 0` and `this.storageDir` has `<taskId>.log`, read the file Buffer `fileBuf`, update `task.totalBytes = fileBuf.length`, and set `incOutput = incStdout = sliceBufferUtf8Safe(fileBuf, numOffset)`.
   - Export `export const taskManager = new TaskManager({ persist: true });`.

- [x] **Step 4: Run tests to verify Task 1 and existing `terminalTaskManager.test.ts` pass**

Run: `npm test -- tests/taskPersistenceAndUtf8.test.ts tests/terminalTaskManager.test.ts`
Expected: PASS on both test suites.

- [x] **Step 5: Commit**

```bash
git add src/agent/tasks/taskManager.ts tests/taskPersistenceAndUtf8.test.ts
git commit -m "feat(tasks): persist task metadata and logs to disk and align UTF-8 byte slices"
```

---

### Task 2: Frontend ANSI Control Sanitizer & Color Log Renderer (`TaskLogModal` & `CronLogModal`)

**Files:**
- Create: `frontend/src/utils/ansiLogFormatter.ts`
- Modify: `frontend/src/components/terminal/components/TaskLogModal.tsx`
- Modify: `frontend/src/components/terminal/components/CronLogModal.tsx`
- Test: `tests/ansiLogFormatter.test.ts`

**Interfaces:**
- Produces (in `frontend/src/utils/ansiLogFormatter.ts`):
  - `export interface AnsiLogSegment { text: string; colorClass?: string; bold?: boolean; }`
  - `export function normalizeTerminalLogText(raw: string): string` — processes `\r` line overwrites (preserving `\r\n`), `\b` backspaces, and strips non-SGR CSI/OSC/control sequences (`\x1b\[[0-9;?]*[A-LN-Za-ln-z]`, `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, bare `\x1b`).
  - `export function stripAnsiCodes(raw: string): string` — calls `normalizeTerminalLogText(raw)` and strips all `\x1b\[[0-9;]*m` SGR sequences.
  - `export function parseAnsiToSegments(raw: string): AnsiLogSegment[]` — normalizes raw text and parses SGR sequences (`0`, `1`, `22`, `30-37`, `39`, `90-97`) into an array of `AnsiLogSegment` objects with Tailwind color classes (`text-rose-400`, `text-emerald-400`, `text-amber-400`, `text-sky-400`, `text-purple-400`, `text-cyan-400`, `text-slate-400`, `text-slate-100`).

- [x] **Step 1: Write the failing test in `tests/ansiLogFormatter.test.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import {
  normalizeTerminalLogText,
  stripAnsiCodes,
  parseAnsiToSegments,
} from '../frontend/src/utils/ansiLogFormatter';

describe('ANSI Log Formatter & Control Sequence Sanitizer', () => {
  test('normalizeTerminalLogText resolves carriage return (\\r) progress overwrites and strips private CSI/OSC codes', () => {
    const raw = '\x1b[?25lProgress: 10%\rProgress: 55%\rProgress: 100%\r\n\x1b[2K\x1b[?25hDone!';
    const normalized = normalizeTerminalLogText(raw);
    expect(normalized).toBe('Progress: 100%\nDone!');
    expect(normalized).not.toContain('\x1b');
  });

  test('stripAnsiCodes removes all SGR color sequences for clean clipboard copy', () => {
    const raw = '\x1b[1;32m[SUCCESS]\x1b[0m Task completed in \x1b[33m1.2s\x1b[0m';
    expect(stripAnsiCodes(raw)).toBe('[SUCCESS] Task completed in 1.2s');
  });

  test('parseAnsiToSegments converts SGR colors and bold flags into styled segments', () => {
    const raw = '\x1b[1;32mPASS\x1b[0m \x1b[31mFAIL\x1b[0m plain';
    const segments = parseAnsiToSegments(raw);

    expect(segments).toEqual([
      { text: 'PASS', colorClass: 'text-emerald-400', bold: true },
      { text: ' ', colorClass: undefined, bold: false },
      { text: 'FAIL', colorClass: 'text-rose-400', bold: false },
      { text: ' plain', colorClass: undefined, bold: false },
    ]);
  });

  test('TaskLogModal and CronLogModal wire parseAnsiToSegments and stripAnsiCodes', () => {
    const taskModalCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/components/TaskLogModal.tsx'),
      'utf-8'
    );
    const cronModalCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/components/CronLogModal.tsx'),
      'utf-8'
    );

    expect(taskModalCode).toContain('parseAnsiToSegments');
    expect(taskModalCode).toContain('stripAnsiCodes');
    expect(cronModalCode).toContain('parseAnsiToSegments');
    expect(cronModalCode).toContain('stripAnsiCodes');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ansiLogFormatter.test.ts`
Expected: FAIL (`Cannot find module '../frontend/src/utils/ansiLogFormatter'`)

- [x] **Step 3: Implement `frontend/src/utils/ansiLogFormatter.ts` and integrate into `TaskLogModal.tsx` and `CronLogModal.tsx`**

1. Create `frontend/src/utils/ansiLogFormatter.ts` implementing `normalizeTerminalLogText`, `stripAnsiCodes`, and `parseAnsiToSegments`.
2. In `frontend/src/components/terminal/components/TaskLogModal.tsx`:
   - Import ` { useMemo } from 'react'` and `{ parseAnsiToSegments, stripAnsiCodes } from '../../../utils/ansiLogFormatter'`.
   - Memoize `const logSegments = useMemo(() => parseAnsiToSegments(logText), [logText]);`.
   - In `handleCopy`: copy `stripAnsiCodes(logText)`.
   - In the log viewer `<div>`: render `logSegments.map((seg, idx) => <span key={idx} className={[seg.colorClass, seg.bold ? 'font-bold' : ''].filter(Boolean).join(' ') || undefined}>{seg.text}</span>)`.
3. In `frontend/src/components/terminal/components/CronLogModal.tsx`:
   - Import `{ useMemo } from 'react'` and `{ parseAnsiToSegments, stripAnsiCodes } from '../../../utils/ansiLogFormatter'`.
   - Memoize `const logSegments = useMemo(() => parseAnsiToSegments(rawOutput), [rawOutput]);`.
   - In `handleCopy`: copy `stripAnsiCodes(rawOutput)`.
   - In the log viewer `<div>`: render `logSegments` spans.

- [x] **Step 4: Run targeted tests and full project build**

Run: `npm test -- tests/ansiLogFormatter.test.ts tests/taskPersistenceAndUtf8.test.ts tests/terminalTaskManager.test.ts && npm run build`
Expected: PASS on all test suites and `npm run build` succeeds with zero errors.

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/ansiLogFormatter.ts frontend/src/components/terminal/components/TaskLogModal.tsx frontend/src/components/terminal/components/CronLogModal.tsx tests/ansiLogFormatter.test.ts docs/superpowers/specs/2026-10-28-task-persistence-and-log-encoding-design.md docs/superpowers/plans/2026-10-28-task-persistence-and-log-encoding.md
git commit -m "feat(tasks): add ANSI log color/control formatter and persist tasks across restarts"
```
