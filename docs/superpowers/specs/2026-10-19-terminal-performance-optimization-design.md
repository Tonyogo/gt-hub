# 终端长时间运行性能优化设计方案 (Terminal Long-Run Performance Optimization)

- **日期**：2026-10-19
- **状态**：Approved
- **影响范围**：`frontend/src/components/WebTerminalView.tsx`, `frontend/src/components/UnifiedTerminalView.tsx`, `frontend/package.json`

---

## 1. 背景与核心瓶颈

在当前 `gt-hub` 在线终端（WebTerminal）中，长时间使用或运行大吞吐输出（如构建、长日志）后，用户常遇到明显的输入迟滞、界面掉帧与内存膨胀。通过系统性源码排查，根本诱因包括：
1. **渲染器瓶颈**：未启用 WebGL 硬件加速，单纯依靠 CPU 在 Canvas/DOM 上进行全量字符重绘，GPU 利用率为 0。
2. **Scrollback 缓冲区过大**：默认配置为 `scrollback: 30000`，随着数据积累，内部环形缓冲区对象过多，造成频繁的 V8 GC 停顿与遍历开销。
3. **后台标签争抢 CPU**：多标签切换（如切换到文件管理、定时任务面板）时，终端容器仅通过 CSS `hidden` 隐藏，WebSocket 仍持续向不可见 DOM 调用 `term.write()`，导致后台空耗 CPU，且在切回前台时引发布局和重绘突发风暴。
4. **流式数据逐包写入阻塞主线程**：大量数据以细碎数据��抵达时，高频调用 `term.write`，占用微任务/宏任务队列，导致用户的键盘输入事件无法及时得到调度。

---

## 2. 优化方案与架构设计

本次采用全方位的**方案 A（主动节流与双层 Ring Buffer 机制）**：

### 2.1 WebGL 硬件加速与降级熔断
- **依赖添加**：引入 `@xterm/addon-webgl` 库。
- **安全挂载与上下文丢失恢复**：
  在终端初始化时，通过安全容器包裹挂载 WebGL 插件：
  ```typescript
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      console.warn('[WebTerminal] WebGL context lost, falling back to standard renderer');
      webglAddon.dispose();
      webglAddonRef.current = null;
    });
    term.loadAddon(webglAddon);
    webglAddonRef.current = webglAddon;
  } catch (err) {
    console.warn('[WebTerminal] WebGL unsupported, using canvas fallback', err);
  }
  ```
- **资源清理**：在组件卸载或 `xterm.dispose()` 时，显式调用 `webglAddon.dispose()`，保证显存和纹理彻底释放。

### 2.2 响应式 Scrollback 精细化分级
- **分级规则**：
  - 桌面端默认：`8000` 行（替代 `30000` 行）。
  - 移动端默认：`3000` 行。
  - 支持读取用户自定义偏好：`localStorage.getItem('terminal_scrollback_lines')`。
- **收益**：避免大量历史 `CellData` 占用堆内存，减少约 70% 的常驻内存与 GC 停顿。

### 2.3 后台 Tab 挂起与按需 Flush 机制
1. **Props 扩充**：
   `WebTerminalViewProps` 增加 `isActive?: boolean`（默认为 `true`）。
   `UnifiedTerminalView` 传入：`isActive={subTab === 'interactive'}`。
2. **后台缓冲队列（Background Buffer Queue）**：
   - 维护一个最大容量为 2MB 的后台环形缓冲区。
   - 当 `isActive === false` 时，接收到的 WebSocket 数据压入后台队列，暂缓向 `term.write()` 发送，防止无谓的后台渲染。
   - 队列超出上限时，安全丢弃最早的头部数据，保证内存上限严格可控。
3. **前台切回时序同步**：
   - 当 `isActive` 重新变为 `true` 时：
     1. 取出后台积压数据，分块合并送入 `term.write()`；
     2. 在下一帧（`requestAnimationFrame`）执行 `fitAddon.fit()`、`sendResize(...)` 与 `scrollToBottomSafe(term)`，使视口与光标瞬间精准对齐。

### 2.4 流式高频数据帧微批处理调度器（TerminalWriteScheduler）
- **写入批处理机制**：
  - 实现专用于前端流式接收的缓冲调度逻辑（16ms 或 64KB 窗口）：
  - 收集短时间内高频到达���多个 WebSocket chunk，合并为单次 `term.write`，大幅降低 VT 解析器初始化频率与微任务调度开销。
- **用户交互即时穿透**：
  - 用户的键入事件通过高速直通车立即通过 WebSocket 发送，不经过任何前端队列等待，确保打字零延迟。

---

## 3. 测试与验证计划

### 3.1 自动化测试（Jest）
新增测试文件 `tests/terminalPerformanceOptimization.test.ts`，覆盖：
1. WebGL Addon 正常挂载与 `onContextLoss` 优雅降级降级测试；
2. `isActive` 状态切换下的数据队列隔离与恢复 Flush 验证；
3. 移动端/桌面端分级 `scrollback` 逻辑验证；
4. 流式高频小包批处理合并验证。

### 3.2 压力与稳定性验证
1. 在浏览器中执行持续日志输出（`seq 1 50000`），验证打字与 `Ctrl+C` 中断无粘滞；
2. 保持多面板切换（文件/终端），验证切页无白屏、终端状态平滑保持；
3. 长时间挂机监控 DevTools 堆内存，无内存泄漏与锯齿状暴涨。
