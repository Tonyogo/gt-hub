# 移除 `@xterm/addon-webgl` 加速与相关依赖实施计划 (Remove Xterm WebGL Addon Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底剥离 `@xterm/addon-webgl` 依赖及其辅助模块，避免由于环境缺失图形加速/WebGL 或依赖不同步引起的构建与运行报错，恢复为经过验证的标准 Canvas/DOM 渲染，并保留已有的 Scrollback 优化与微批写入调度器。

**Architecture:**
- 删除 `frontend/src/utils/terminalWebglHelper.ts`；
- 从 `frontend/package.json` 中移除 `@xterm/addon-webgl` 依赖并更新锁定文件；
- 清理 `WebTerminalView.tsx` 中的 WebGL 引用及生命周期销毁；
- 更新 `tests/terminalPerformanceOptimization.test.ts` 测试套件，移除 WebGL 测试，保留写入调度与后台队列测试。

**Tech Stack:** React 18, TypeScript, Xterm.js 5.5, Jest.

## Global Constraints

- **零破坏**：移除 WebGL 加速后，终端必须正常使用默认 Canvas/DOM 渲染，无运行时报错或黑屏；
- **优化保留**：Scrollback 限制（桌��� 8000 / 移动 3000）、后台 Tab 挂起队列与 16ms 流式数据微批调度必须完整保留并保持测试通过；
- **构建通过**：`npm run build:frontend` 与 `npm test` 均须无任何类型或模块导入错误。

---

### Task 1: 移除依赖项与删除辅助文件

**Files:**
- Delete: `frontend/src/utils/terminalWebglHelper.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Interfaces:**
- Removes: `initSafeWebglAddon` from `terminalWebglHelper.ts`

- [x] **Step 1: 删除 `frontend/src/utils/terminalWebglHelper.ts`**

```bash
rm -f frontend/src/utils/terminalWebglHelper.ts
```

- [x] **Step 2: 从 `frontend/package.json` 中移除 `@xterm/addon-webgl` 依赖**

修改 `frontend/package.json`，在 `dependencies` 中移除 `"@xterm/addon-webgl": "^0.18.0",`：
```json
  "dependencies": {
    "@monaco-editor/react": "^4.7.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/xterm": "^5.5.0",
    "lucide-react": "^0.395.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
```

- [x] **Step 3: 更新前端依赖锁定**

运行：
```bash
cd frontend && npm install
```

- [x] **Step 4: 提交依赖与辅助文件移除**

```bash
git add frontend/package.json frontend/package-lock.json
git rm -f frontend/src/utils/terminalWebglHelper.ts 2>/dev/null || rm -f frontend/src/utils/terminalWebglHelper.ts
git commit -m "chore(deps): remove @xterm/addon-webgl dependency and helper"
```

---

### Task 2: 清理 `WebTerminalView.tsx` 与更新测试套件

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `tests/terminalPerformanceOptimization.test.ts`

- [x] **Step 1: 更新 `tests/terminalPerformanceOptimization.test.ts`**

移除关于 `initSafeWebglAddon` 的导入及所有测试块，更新为仅测试流式调度、后台队列与组件集成：
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { TerminalWriteScheduler, BackgroundBufferQueue } from '../frontend/src/utils/terminalStreamHelper';

describe('Terminal Performance Optimization', () => {
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
        }, 50, 10);

        scheduler.push('12345');
        expect(writtenBatches.length).toBe(0);
        scheduler.push('67890abc');
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
        queue.push('abc');
        expect(queue.size()).toBeLessThanOrEqual(10);
        const drained = queue.drain();
        expect(drained.endsWith('67890abc')).toBe(true);
        expect(drained.length).toBeLessThanOrEqual(10);
      });
    });
  });

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

    it('does not import or instantiate webgl addon', () => {
      expect(compContent).not.toContain('initSafeWebglAddon');
      expect(compContent).not.toContain('@xterm/addon-webgl');
      expect(compContent).not.toContain('webglCleanupRef');
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
});
```

- [x] **Step 2: 运行测试验证失败**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：FAIL（`WebTerminalView.tsx` 仍包含 `initSafeWebglAddon`）。

- [x] **Step 3: 修改 `WebTerminalView.tsx` 移除 WebGL 相关逻辑**

1. 移除引用：
   删除：
   ```typescript
   import { initSafeWebglAddon } from '../utils/terminalWebglHelper';
   ```
   保留 `TerminalWriteScheduler` 与 `BackgroundBufferQueue`。
2. 删除组件内部的 ref：
   删除：
   ```typescript
   const webglCleanupRef = useRef<(() => void) | null>(null);
   ```
3. 在 `term` 初始化处删除 WebGL 挂载：
   删除：
   ```typescript
   const webglResult = initSafeWebglAddon(term);
   webglCleanupRef.current = webglResult.dispose;
   ```
4. 在组件清理函数中删除：
   删除：
   ```typescript
   if (webglCleanupRef.current) {
     webglCleanupRef.current();
     webglCleanupRef.current = null;
   }
   ```

- [x] **Step 4: 运行测试验证通过**

运行：`npm test -- tests/terminalPerformanceOptimization.test.ts`
预期：PASS。

- [x] **Step 5: 提交更改**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalPerformanceOptimization.test.ts
git commit -m "refactor(terminal): remove webgl addon references from WebTerminalView"
```

---

### Task 3: 构建与全量回归验证

**Files:**
- Verification only

- [x] **Step 1: 验证前端独立构建**

运行：
```bash
npm run build:frontend
```
预期：SUCCESS，无编译错误。

- [x] **Step 2: 运行全量终端测试套件**

运行：
```bash
npm test -- tests/terminalPerformanceOptimization.test.ts
npm test -- tests/terminalSluggishnessAndFileLoadFixes.test.ts
npm test -- tests/terminalPerformanceFixes.test.ts
npm test -- tests/terminalMobileKeyboardPushUp.test.ts
```
预期：所有测试套件全部 PASS。

- [x] **Step 3: 全项目构建测试**

运行：
```bash
npm run build
```
预期：SUCCESS。
