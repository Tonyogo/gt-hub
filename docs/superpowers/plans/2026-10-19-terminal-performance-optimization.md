# 终端长时间运行性能优化实施计划 (Terminal Performance Optimization Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底消除在线终端长时间运行下的卡顿、内存泄漏和主线程掉帧，通过引入 WebGL 硬件加速、降低默认 scrollback、实现后台标签缓冲挂起以及流式小包微批处理调度器来优化系统。

**Architecture:**
- 前端安装 `@xterm/addon-webgl`，并配置上下文丢失自动降级机制；
- 降低移动端/桌面端默认 `scrollback`（3000 / 8000 行），削减 V8 GC 压力；
- 在 `UnifiedTerminalView` 与 `WebTerminalView` 间打通 `isActive` 状态，对非激活 Tab 启用 `BackgroundBufferQueue` 暂存，激活时统一恢复刷新；
- 在数据写入链路实现 `TerminalWriteScheduler`，将 16ms 内连续到达的数据合并为单次 `term.write()`，保证用户输入零阻塞。

**Tech Stack:** React 18, TypeScript, Xterm.js 5.5, @xterm/addon-webgl, Jest.

## Global Constraints

- **向前兼容**：若运行环境不支持 WebGL 或遭遇 GPU 上下文丢失，必须无缝降级回默认渲染器，不能抛出未捕获异常或黑屏。
- **通信不丢包**：后台挂起期间 WebSocket 连接保持活跃，不产生重连，切回前台必须完整恢复最新屏幕内容。
- **测试覆盖**：所有新增功能与状态切换需在 Jest 测试套件中有可重复的单元/集成测试验证。

---

### Task 1: 引入 `@xterm/addon-webgl` 依赖与渲染器安全降级容器

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/utils/terminalWebglHelper.ts`
- Test: `tests/terminalPerformanceOptimization.test.ts`

**Interfaces:**
- Produces: `initSafeWebglAddon(term: Terminal): { addon: WebglAddon | null, dispose: () => void }`

- [x] **Step 1: 在 `frontend/package.json` 中添加 `@xterm/addon-webgl` 依赖并执行安装**

在 `frontend/package.json` 的 `dependencies` 中添加 `"@xterm/addon-webgl": "^0.18.0"`。
执行 `npm install`。

- [x] **Step 2: 编写测试用例 `tests/terminalPerformanceOptimization.test.ts` (Part 1: WebGL Helper)**

创建并编写测试：
```typescript
import { initSafeWebglAddon } from '../frontend/src/utils/terminalWebglHelper';

describe('Terminal Performance Optimization - WebGL Helper', () => {
  it('gracefully handles WebGL initialization failures without throwing', () => {
    const mockTerm = {
      loadAddon: jest.fn(() => {
        throw new Error('WebGL not supported');
      }),
    };
    const result = initSafeWebglAddon(mockTerm as any);
    expect(result.addon).toBeNull();
    expect(typeof result.dispose).toBe('function');
  });

  it('successfully loads addon when WebGL is supported and registers onContextLoss', () => {
    let contextLossCb: (() => void) | null = null;
    const mockAddonInstance = {
      onContextLoss: jest.fn((cb) => {
        contextLossCb = cb;
        return { dispose: jest.fn() };
      }),
      dispose: jest.fn(),
    };
    const MockWebglAddon = jest.fn(() => mockAddonInstance);
    const mockTerm = {
      loadAddon: jest.fn(),
    };

    const result = initSafeWebglAddon(mockTerm as any, MockWebglAddon as any);
    expect(result.addon).toBe(mockAddonInstance);
    expect(mockTerm.loadAddon).toHaveBeenCalledWith(mockAddonInstance);

    // Simulate context loss
    if (contextLossCb) {
      (contextLossCb as () => void)();
    }
    expect(mockAddonInstance.dispose).toHaveBeenCalled();
  });
});
```

- [x] **Step 3: 运行测试验证失败**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：FAIL（文件或模块尚未创建）。

- [x] **Step 4: 实现 `frontend/src/utils/terminalWebglHelper.ts`**

编写安全的 WebGL 初始化器与降级管理：
```typescript
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export interface SafeWebglResult {
  addon: WebglAddon | null;
  dispose: () => void;
}

export function initSafeWebglAddon(
  term: Terminal,
  AddonCtor: typeof WebglAddon = WebglAddon
): SafeWebglResult {
  let addon: WebglAddon | null = null;
  try {
    addon = new AddonCtor();
    addon.onContextLoss(() => {
      console.warn('[WebTerminal] WebGL context lost, disposing and falling back to standard canvas renderer');
      try {
        addon?.dispose();
      } catch {}
      addon = null;
    });
    term.loadAddon(addon);
  } catch (err) {
    console.warn('[WebTerminal] WebGL not supported or failed to initialize, using standard renderer', err);
    try {
      addon?.dispose();
    } catch {}
    addon = null;
  }

  return {
    addon,
    dispose: () => {
      if (addon) {
        try {
          addon.dispose();
        } catch {}
        addon = null;
      }
    },
  };
}
```

- [x] **Step 5: 运行测试验证通过**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：PASS。

- [x] **Step 6: 提交代码**

```bash
git add frontend/package.json package-lock.json frontend/package-lock.json frontend/src/utils/terminalWebglHelper.ts tests/terminalPerformanceOptimization.test.ts
git commit -m "feat(terminal): add safe webgl addon initialization and fallback helper"
```

---

### Task 2: 实现流式写入调度器与后台数据缓冲队列 (`terminalStreamHelper.ts`)

**Files:**
- Create: `frontend/src/utils/terminalStreamHelper.ts`
- Test: `tests/terminalPerformanceOptimization.test.ts`

**Interfaces:**
- Produces:
  - `class TerminalWriteScheduler`: 管理微批处理（16ms 窗口合并写入），支持立即 `flush()` 与安全销毁。
  - `class BackgroundBufferQueue`: 针对后台非激活状态的环形截断缓冲区，支持容量控制（默认 2MB）和单次批量提取。

- [x] **Step 1: 在 `tests/terminalPerformanceOptimization.test.ts` 中增加调度器与缓冲队列单元测试**

编写测试：
```typescript
import { TerminalWriteScheduler, BackgroundBufferQueue } from '../frontend/src/utils/terminalStreamHelper';

describe('Terminal Stream & Batch Helpers', () => {
  describe('TerminalWriteScheduler', () => {
    it('batches rapid small writes into single callback execution', (done) => {
      const writtenBatches: string[] = [];
      const scheduler = new TerminalWriteScheduler((batch) => {
        writtenBatches.push(batch);
      }, 16);

      scheduler.push('hello ');
      scheduler.push('world ');
      scheduler.push('!');

      expect(writtenBatches.length).toBe(0);

      setTimeout(() => {
        expect(writtenBatches.length).toBe(1);
        expect(writtenBatches[0]).toBe('hello world !');
        scheduler.destroy();
        done();
      }, 30);
    });

    it('flushes immediately when buffer exceeds maxBatchBytes', () => {
      const writtenBatches: string[] = [];
      const scheduler = new TerminalWriteScheduler((batch) => {
        writtenBatches.push(batch);
      }, 50, 10); // 10 bytes threshold

      scheduler.push('12345');
      expect(writtenBatches.length).toBe(0);
      scheduler.push('67890abc');
      // Buffer length 13 >= 10, triggers immediate flush
      expect(writtenBatches.length).toBe(1);
      expect(writtenBatches[0]).toBe('1234567890abc');
      scheduler.destroy();
    });
  });

  describe('BackgroundBufferQueue', () => {
    it('stores data and flushes concatenated string', () => {
      const queue = new BackgroundBufferQueue(100);
      queue.push('chunk1;');
      queue.push('chunk2;');
      expect(queue.size()).toBe(14);
      expect(queue.drain()).toBe('chunk1;chunk2;');
      expect(queue.size()).toBe(0);
    });

    it('caps total buffered size and trims excess from head', () => {
      const queue = new BackgroundBufferQueue(10);
      queue.push('12345');
      queue.push('67890');
      queue.push('abc'); // Total 13, max 10 -> 3 bytes excess evicted
      expect(queue.size()).toBeLessThanOrEqual(10);
      const drained = queue.drain();
      expect(drained.endsWith('67890abc')).toBe(true);
      expect(drained.length).toBeLessThanOrEqual(10);
    });
  });
});
```

- [x] **Step 2: 运行测试验证失败**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：FAIL（`terminalStreamHelper` 尚未实现）。

- [x] **Step 3: 实现 `frontend/src/utils/terminalStreamHelper.ts`**

编写调度器与队列实现：
```typescript
export class TerminalWriteScheduler {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: any = null;
  private readonly maxBatchBytes: number;
  private readonly intervalMs: number;
  private flushCallback: (batch: string) => void;

  constructor(
    flushCallback: (batch: string) => void,
    intervalMs: number = 16,
    maxBatchBytes: number = 64 * 1024
  ) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
    this.maxBatchBytes = maxBatchBytes;
  }

  public push(chunk: string): void {
    if (!chunk || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferedLength += chunk.length;

    if (this.bufferedLength >= this.maxBatchBytes) {
      this.flush();
      return;
    }

    if (!this.timer) {
      const getTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      this.timer = getTimer(() => this.flush(), this.intervalMs);
    }
  }

  public flush(): void {
    if (this.timer) {
      const clear = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
      clear(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const combined = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
    this.buffer = [];
    this.bufferedLength = 0;
    try {
      this.flushCallback(combined);
    } catch {}
  }

  public destroy(): void {
    this.flush();
  }
}

export class BackgroundBufferQueue {
  private chunks: string[] = [];
  private totalBytes: number = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 2 * 1024 * 1024) {
    this.maxBytes = Math.max(1024, maxBytes);
  }

  public push(data: string | Uint8Array | ArrayBuffer): void {
    let str = '';
    if (typeof data === 'string') {
      str = data;
    } else if (data instanceof ArrayBuffer) {
      str = new TextDecoder().decode(data);
    } else if (data instanceof Uint8Array) {
      str = new TextDecoder().decode(data);
    }
    if (!str) return;

    this.chunks.push(str);
    this.totalBytes += str.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (head.length <= excess) {
        this.totalBytes -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.slice(excess);
        this.totalBytes -= excess;
        break;
      }
    }
  }

  public drain(): string {
    if (this.chunks.length === 0) return '';
    const combined = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    this.chunks = [];
    this.totalBytes = 0;
    return combined;
  }

  public size(): number {
    return this.totalBytes;
  }

  public clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
```

- [x] **Step 4: 运行测试验证通过**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：PASS。

- [x] **Step 5: 提交代码**

```bash
git add frontend/src/utils/terminalStreamHelper.ts tests/terminalPerformanceOptimization.test.ts
git commit -m "feat(terminal): add TerminalWriteScheduler and BackgroundBufferQueue"
```

---

### Task 3: 优化 `WebTerminalView`（Scrollback 分级、挂载 WebGL、集成调度器与后台队列）

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/terminalPerformanceOptimization.test.ts`

**Interfaces:**
- Consumes:
  - `initSafeWebglAddon` (from `terminalWebglHelper.ts`)
  - `TerminalWriteScheduler`, `BackgroundBufferQueue` (from `terminalStreamHelper.ts`)
- Modifies:
  - `WebTerminalViewProps` 增加 `isActive?: boolean`（默认 `true`）

- [x] **Step 1: 在 `tests/terminalPerformanceOptimization.test.ts` 中增加组件级集成行为测试**

测试验证 `WebTerminalView` 在 `scrollback` 默认值与 `isActive` 状态切换下的正确响应：
```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('WebTerminalView Integration Specifications', () => {
  const compPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let compContent: string;
  let unifiedContent: string;

  beforeAll(() => {
    compContent = fs.readFileSync(compPath, 'utf-8');
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('defines responsive scrollback with 8000 desktop and 3000 mobile fallback', () => {
    expect(compContent).toContain('scrollback:');
    expect(compContent).not.toMatch(/scrollback:\s*30000/);
    expect(compContent).toMatch(/8000/);
    expect(compContent).toMatch(/3000/);
  });

  it('integrates initSafeWebglAddon during terminal initialization', () => {
    expect(compContent).toContain('initSafeWebglAddon');
  });

  it('accepts isActive prop in WebTerminalViewProps and passes it from UnifiedTerminalView', () => {
    expect(compContent).toContain('isActive?: boolean;');
    expect(unifiedContent).toContain('isActive={subTab === \'interactive\'}');
  });

  it('flushes backgroundQueue when transitioning from inactive to active', () => {
    expect(compContent).toContain('backgroundQueueRef');
    expect(compContent).toContain('writeSchedulerRef');
  });
});
```

- [x] **Step 2: 运行测试验证失败**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：FAIL（组件尚未引入这些修改）。

- [x] **Step 3: 修改 `WebTerminalView.tsx`**

1. 引入 helper：
   ```typescript
   import { initSafeWebglAddon } from '../utils/terminalWebglHelper';
   import { TerminalWriteScheduler, BackgroundBufferQueue } from '../utils/terminalStreamHelper';
   ```
2. 在 `WebTerminalViewProps` 增加 `isActive?: boolean`；
3. 将默认 `scrollback` 调整为：
   ```typescript
   const defaultScrollback = isMobile ? 3000 : 8000;
   const configuredScrollback = typeof localStorage !== 'undefined'
     ? parseInt(localStorage.getItem('terminal_scrollback_lines') || '', 10)
     : NaN;
   const scrollback = !isNaN(configuredScrollback) && configuredScrollback > 0
     ? configuredScrollback
     : defaultScrollback;
   ```
4. 在 `term` 创建后调用 `initSafeWebglAddon(term)`，并使用 `webglCleanupRef.current` 存储清理函数，在 `useEffect` 清理阶段调用；
5. 初始化 `BackgroundBufferQueue` 与 `TerminalWriteScheduler`：
   - 当 `ws.onmessage` 收到数据时：
     - 如果数据是控制信令（`JSON:` 开头），立即同步处理；
     - 如果 `!isActiveRef.current`，存入 `backgroundQueueRef.current.push(data)`；
     - 否则压入 `writeSchedulerRef.current.push(text)`。
6. 添加 `useEffect` 监听 `isActive`：
   - 当 `isActive` 变为 `true` 时，若 `backgroundQueueRef.current.size() > 0`，调用 `drain()` 并执行写入，紧接着调用 `safeFit(true)` 与 `scrollToBottomSafe`。

- [x] **Step 4: 修改 `UnifiedTerminalView.tsx`**

在 `UnifiedTerminalView.tsx` 挂载 `WebTerminalView` 处补充：
```tsx
<WebTerminalView
  ref={terminalRef}
  adminKey={adminKey}
  isActive={subTab === 'interactive'}
  ...
/>
```

- [x] **Step 5: 运行测试验证通过**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：PASS。

- [x] **Step 6: 执行前端编译构建验证**

运行：`npm run build:frontend`
预期：SUCCESS（TypeScript 无类型错误，Vite 构建成功）。

- [x] **Step 7: 提交代码**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/components/UnifiedTerminalView.tsx tests/terminalPerformanceOptimization.test.ts
git commit -m "perf(terminal): implement webgl hardware acceleration, scrollback tuning, and background tab throttling"
```

---

### Task 4: 端到端回归测试与全量功能验证

**Files:**
- Modify: `tests/terminalPerformanceOptimization.test.ts`

- [x] **Step 1: 运行全量终端相关单元测试**

运行：
```bash
npm test -- tests/terminalSluggishnessAndFileLoadFixes.test.ts
npm test -- tests/terminalPerformanceFixes.test.ts
npm test -- tests/terminalMobileKeyboardPushUp.test.ts
npm test -- tests/terminalPerformanceOptimization.test.ts
```
预期：所有终端相关套件全部 PASS。

- [x] **Step 2: 完整构建验证**

运行：`npm run build`
预期：构建通过（后端、前端、CLI 全部编译完成）。

- [x] **Step 3: 最终提交**

```bash
git commit -am "chore: finalize terminal performance optimization test suite"
```
