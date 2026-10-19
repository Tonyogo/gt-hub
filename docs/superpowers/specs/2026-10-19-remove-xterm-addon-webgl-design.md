# 移除 `@xterm/addon-webgl` 依赖与加速逻辑设计方案

- **日期**：2026-10-19
- **状态**：Approved
- **影响范围**：`frontend/package.json`, `frontend/src/components/WebTerminalView.tsx`, `frontend/src/utils/terminalWebglHelper.ts`, `tests/terminalPerformanceOptimization.test.ts`

---

## 1. 目标

移除 `@xterm/addon-webgl` 渲染插件及其相关辅助代码，彻底消除图形驱动与跨平台构建依赖问题；同时完整保留此前已验证有效的其它性能优化手段（包括降低 Scrollback 行数限制、后台 Tab 挂起队列与 16ms 流式数据微批调度）。

---

## 2. 变更内容

### 2.1 依赖移除
- 从 `frontend/package.json` 中的 `dependencies` 移除 `"@xterm/addon-webgl"`；
- 重新运行依赖锁定以更新 `frontend/package-lock.json`。

### 2.2 辅助文件删除
- 删除 `frontend/src/utils/terminalWebglHelper.ts`。

### 2.3 终端组件清理 (`WebTerminalView.tsx`)
- 移除 `terminalWebglHelper` 的导入；
- 移除 `webglCleanupRef`；
- 移除终端创建时的 WebGL 挂载和卸载时的 `dispose` 逻辑；
- 保持标准的 Canvas/DOM 渲染模式。

### 2.4 测试用例更新 (`terminalPerformanceOptimization.test.ts`)
- 移除 `initSafeWebglAddon` 相关的单元测试用例及组件规格断言；
- 保留 `TerminalWriteScheduler`、`BackgroundBufferQueue`、Scrollback 与 `isActive` 机制的测试用例。

---

## 3. 验证标准

1. `tests/terminalPerformanceOptimization.test.ts` 全部 PASS；
2. `npm run build:frontend` 正常编译通过；
3. `npm run build` 全量通过；
4. 全局搜索不再包含任何 `@xterm/addon-webgl` 或 `terminalWebglHelper` 的引用。
