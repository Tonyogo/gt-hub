# 企业级浅色与深色双主题系统重构设计规范 (Enterprise Light & Dark Theme System Design)

**日期**: 2026-10-31  
**范围**: `gt-hub` 前端全局主题引擎、Design Token 体系、通用 UI 组件库、全部业务视图/弹窗、Xterm 终端、Monaco 编辑器、Markdown 与 ANSI 日志渲染器。

---

## 1. 背景与问题诊断

当前 `gt-hub` 前端虽然在 `ThemeContext.tsx` 和 `index.css` 中定义了基础的 `light` / `dark` 切换逻辑，但在实际演进过程中积累了以下核心问题：

1. **大量硬编码深色样式导致浅色模式严重割裂**：
   - `TerminalCronView.tsx` 与 `TerminalTaskView.tsx` 根容器硬编码 `bg-[#121316] text-slate-200`，顶部工具栏硬编码 `bg-black/20 border-white/[0.08]`。
   - 四大核心弹窗（`TaskLogModal`、`CronJobModal`、`CronLogModal`、`CreateTaskModal`）及 `UnifiedTerminalView` 更多菜单硬编码 `bg-[#18181b]`、`bg-[#0c1017]`、`bg-[#090d16]`。
   - `TerminalScriptDrawer.tsx` 代码编辑与预览区硬编码 `bg-[#121214]` 与 `bg-black/20`。
   - 各视图中的次级按钮大量使用 `bg-white/[0.04]`、`border-white/[0.06]`、`text-slate-400 hover:text-white`，在浅色模式下边框消失或悬停时文字变白隐形。
2. **脆弱的全局 CSS 覆盖补丁**：
   - `index.css` 第 81–97 行使用 `:root:not(.dark) { .text-slate-100 ... }` 强行篡改 Tailwind 原生颜色类来修补浅色模式，导致语义混乱、对比度失控。
3. **品牌主色调（Brand Accent）不统一**：
   - `LoginView.tsx` 与 `App.tsx` 使用翡翠绿（`emerald-500/600`）作为品牌主色，而进入主控台后 Tab 与按钮又混用靛蓝（`indigo-600`）与 `indigo-to-purple` 渐变。
4. **终端、日志与 Markdown 在浅色模式下可读性不足**：
   - 浅色模式下任务/Cron 日志弹窗仍为黑底，Markdown 渲染器（`markdownRenderer.ts`）硬编码深色文本类（`text-slate-200`、`text-amber-300`、`bg-black/20`），Xterm 浅色 16 色调色板中部分浅色字在白底上对比度不足。

---

## 2. 设计目标与视觉定位

1. **视觉风格定位**：对标 Linear / Vercel / GitHub 的现代极简企业级设计风格。
   - **唯一品牌交互主色（Brand Primary）**：全站统一使用 **Indigo（蓝靛色，Light `#4F46E5` / Dark `#6366F1`）**，覆盖登录页、Logo 徽章、主操作按钮、Tab 选中态、输入框聚焦环、分屏激活态。
   - **克制的表面与光影**：移除花哨的 `indigo-to-purple` 渐变与过度的霓虹发光；深色模式通过**表面亮度递进（Luminance Elevation）+ 微光边框**体现层级，浅色模式通过**冷灰画布 + 纯白容器 + 实色细边框 + 细腻多层阴影**体现层级。
   - **纯粹的语义状态色**：`Emerald`（在线/成功）、`Amber`（连接中/警告/修饰键激活）、`Rose`（离线/错误/删除）各司其职，并在浅色模式下自动加深文字色阶（600/700）以保证 WCAG AA 对比度。
2. **全局 100% 彻底统一浅色与深色模式**：
   - 切换到浅色模式时，顶栏、所有业务视图（终端、文件、定时任务、后台任务、代理测速）、所有 Modal 弹窗、脚本抽屉、Xterm 终端画布、任务/Cron 日志输出框、Monaco 编辑器、Markdown 预览全部同步切换为高对比度浅色表面。

---

## 3. 企业级 Design Token 体系架构

### 3.1 CSS 变量令牌表（`frontend/src/index.css`）

移除 `:root:not(.dark)` 脏补丁，建立标准的多层语义 CSS 变量体系：

| 语义令牌 (CSS Variable) | 浅色模式 (`:root`) | 深色模式 (`:root.dark`, `:root[data-theme="dark"]`) | 用途说明 |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#F8FAFC` (Slate 50) | `#090D16` (深邃碳蓝黑) | 应用最底层画布、主工作区背景 |
| `--bg-surface` | `#FFFFFF` (Pure White) | `#0F1523` (深灰蓝面板) | 顶栏导航、主卡片容器、列表/表格主体 |
| `--bg-surface-sub` | `#F1F5F9` (Slate 100) | `#151D2E` (次级面板) | 表头、次级内嵌块、代码块顶栏、胶囊 Tab 槽底 |
| `--bg-elevated` | `#FFFFFF` (Pure White) | `#182235` (高阶浮层) | Modal 弹窗、下拉菜单、脚本抽屉、浮动工具栏 |
| `--bg-terminal` | `#FFFFFF` (Pure White) | `#090D16` (沉浸终端底) | Xterm 终端画布、Task/Cron 日志流容器、代码编辑区 |
| `--bg-control` | `rgba(15, 23, 42, 0.04)` | `rgba(255, 255, 255, 0.05)` | 次级按钮、图标按钮、未激活胶囊默认背景 |
| `--bg-control-hover` | `rgba(15, 23, 42, 0.08)` | `rgba(255, 255, 255, 0.10)` | 次级按钮、表格行、下拉菜单项悬停背景 |
| `--bg-surface-hover` | `rgba(15, 23, 42, 0.04)` | `rgba(255, 255, 255, 0.05)` | 兼容现有表面悬停引用 |
| `--bg-overlay` | `rgba(15, 23, 42, 0.45)` | `rgba(2, 6, 23, 0.72)` | Modal 弹窗与抽屉遮罩层 |
| `--text-primary` | `#0F172A` (Slate 900) | `#F8FAFC` (Slate 50) | 主标题、正文、激活态文字、主图标 |
| `--text-secondary` | `#475569` (Slate 600) | `#94A3B8` (Slate 400) | 次级文本、未激活 Tab、工具栏默认图标 |
| `--text-muted` | `#64748B` (Slate 500) | `#64748B` (Slate 500) | 占位符、禁用文本、时间戳、隐藏文件弱化文本 |
| `--border-subtle` | `#E2E8F0` (Slate 200) | `rgba(255, 255, 255, 0.08)` | 面板分割线、表格行分割线、卡片默认边框 |
| `--border-default` | `#CBD5E1` (Slate 300) | `rgba(255, 255, 255, 0.14)` | 输入框边框、按钮边框、弹窗/下拉菜单外框 |
| `--border-hover` | `#94A3B8` (Slate 400) | `rgba(255, 255, 255, 0.22)` | 控件与卡片悬停边框 |
| `--border-focus` | `#4F46E5` (Indigo 600) | `#6366F1` (Indigo 500) | 输入框聚焦环、分屏激活边框 |
| `--code-bg` | `#F1F5F9` (Slate 100) | `#090D16` | 行内代码与代码块背景 |
| `--code-text` | `#0F172A` (Slate 900) | `#E2E8F0` (Slate 200) | 代码块默认文字颜色 |
| `--scrollbar-thumb` | `rgba(15, 23, 42, 0.18)` | `rgba(255, 255, 255, 0.14)` | 滚动条滑块默认色 |
| `--scrollbar-thumb-hover` | `rgba(15, 23, 42, 0.32)` | `rgba(255, 255, 255, 0.28)` | 滚动条滑块悬停色 |

### 3.2 Tailwind 配置扩展与通用组件类（`tailwind.config.js` & `index.css`）

1. **`tailwind.config.js`**：扩展语义颜色别名（`canvas`、`surface`、`surface-sub`、`elevated`、`terminal`、`control`、`control-hover`），支持直接使用 `bg-canvas`、`bg-surface`、`bg-elevated`、`bg-control` 等语义类，同时完全兼容 `bg-[var(--bg-*)]` 写法。
2. **`index.css` `@layer components` 统一组件规范**：
   - `.ui-card`：`bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] rounded-2xl shadow-sm dark:shadow-none`
   - `.ui-card-sub`：`bg-[var(--bg-surface-sub)] border border-[var(--border-subtle)] text-[var(--text-primary)] rounded-xl`
   - `.ui-elevated`：`bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] rounded-2xl shadow-xl dark:shadow-2xl`
   - `.ui-tab-container`：`flex items-center p-1 bg-[var(--bg-surface-sub)] rounded-xl border border-[var(--border-subtle)]`
   - `.ui-tab-pill`：`px-3 py-1.5 rounded-lg text-xs font-medium transition-all text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-control-hover)]`
   - `.ui-tab-pill-active`：`!bg-indigo-600 !text-white shadow-xs`
   - `.ui-btn-primary`：`bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl font-medium text-xs shadow-xs transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none`（去除紫色渐变）
   - `.ui-btn-secondary`：`bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-xl text-xs font-medium transition-all active:scale-[0.98]`
   - `.ui-icon-btn`：`p-1.5 rounded-lg bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all active:scale-95`
   - `.ui-input`：`bg-[var(--bg-surface-sub)] border border-[var(--border-default)] hover:border-[var(--border-hover)] focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-indigo-500/30 font-mono transition-all`

---

## 4. 全站视图与组件迁移规范

### 4.1 入口与登录页（`App.tsx`, `LoginView.tsx`）
- `App.tsx`：加载态 `Loader2` 图标颜色改为 `text-indigo-500`。
- `LoginView.tsx`：
  - 品牌 Logo 徽章改为 `bg-indigo-500/10 border-indigo-500/25 text-indigo-600 dark:text-indigo-400`。
  - 密钥输入框聚焦环改为 `focus:border-indigo-500 focus:ring-indigo-500/30`。
  - 登录主按钮改为 `bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-sm`。
  - 错误提示框适配双主题：`bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400`。

### 4.2 顶栏工作台与节点选择器（`UnifiedTerminalView.tsx`, `TerminalHostSelector.tsx`）
- `UnifiedTerminalView.tsx`：
  - 顶栏所有操作图标按钮、分屏按钮、语言/主题切换按钮统一从 `bg-white/[0.04] text-slate-400 hover:text-white border-white/[0.06]` 迁移至 `bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]`。
  - 移动端「更多菜单」弹出层（第 817 行）从 `bg-[#18181b] border-[#27272a] text-slate-300` 迁移至 `bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-primary)] divide-[var(--border-subtle)] shadow-xl`。
  - 在线/连接中状态胶囊：`bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20`。
  - 分屏分割线（Splitter）：默认 `bg-[var(--border-subtle)] hover:bg-indigo-500/60`。
- `TerminalHostSelector.tsx`：
  - 触发按钮、下拉浮层（Popover）以及「添加节点（Add Node）」Modal 全部使用 `--bg-elevated`、`--bg-surface-sub`、`--text-primary`、`--text-secondary`、`--border-default`，消除浅色模式下白字或深灰底残留。

### 4.3 定时任务与后台任务视图（`TerminalCronView.tsx`, `TerminalTaskView.tsx`）
- 根容器从 `bg-[#121316] text-slate-200` 改为 `bg-[var(--bg-canvas)] text-[var(--text-primary)]`。
- 顶部工具栏从 `bg-black/20 border-white/[0.08]` 改为 `bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]`。
- 搜索框、刷新按钮、状态过滤胶囊、统计卡片、任务列表卡片（含命令代码块、状态标签、操作按钮）全部替换为语义变量与双主题高对比度状态色（如运行中 `text-amber-700 dark:text-amber-400`、成功 `text-emerald-700 dark:text-emerald-400`、失败 `text-rose-700 dark:text-rose-400`）。

### 4.4 文件管理器与预览组件（`TerminalFileManagerView.tsx`, `TerminalImagePreviewModal.tsx`, `TerminalPdfPreviewModal.tsx`, `TerminalMarkdownViewer.tsx`）
- 面包屑导航栏、搜索框、工具栏按钮、表头（`bg-[var(--bg-surface-sub)]`）、文件列表行（`hover:bg-[var(--bg-control-hover)]`）全部适配双主题。
- 隐藏文件区分样式：保持 `isHidden ? 'text-slate-400' : 'text-[var(--text-primary)]'`（或兼容测试预期的语义类名）。
- 内置的新建文件夹、重命名、删除确认弹窗及底部编辑器抽屉、图片/PDF 预览弹窗统一使用 `--bg-elevated` 与 `--bg-overlay`。

### 4.5 代理与网络测速视图（`TerminalProxyView.tsx`）
- 测速配置栏、实时仪表盘卡片、RTT/下载/上传指标面板、进度条底槽、测速历史表格全部统一为 `--bg-surface` / `--bg-surface-sub` 与语义文字颜色。

### 4.6 四大业务弹窗与脚本抽屉（`CronJobModal.tsx`, `CreateTaskModal.tsx`, `TaskLogModal.tsx`, `CronLogModal.tsx`, `TerminalScriptDrawer.tsx`）
- 4 个弹窗容器从 `bg-[#18181b] border-white/10 text-slate-200` 统一改为 `bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-primary)] shadow-2xl`。
- `TaskLogModal.tsx` 与 `CronLogModal.tsx` 的日志输出容器从 `bg-[#0c1017]` / `bg-[#090d16]` 改为 `bg-[var(--bg-terminal)] border-t border-[var(--border-subtle)] text-[var(--text-primary)]`。
- `TerminalScriptDrawer.tsx`：抽屉主容器使用 `bg-[var(--bg-elevated)]`，左侧列表使用 `bg-[var(--bg-surface-sub)]`，脚本代码编辑框与预览 `<pre>` 从 `bg-[#121214]` 改为 `bg-[var(--bg-terminal)] border-[var(--border-default)] text-[var(--text-primary)]`。

### 4.7 终端交互与辅助组件（`WebTerminalView.tsx`, `TerminalAccessoryBar.tsx`, `TerminalMagnifierBubble.tsx`, `TerminalSelectionToolbar.tsx`, `TerminalEmptyState.tsx`, `TerminalLogsView.tsx`）
- `WebTerminalView.tsx`：
  - 内部顶栏、浮动置底按钮、离线警告横幅、复制成功 Toast 均适配浅色与深色。
- `TerminalAccessoryBar.tsx`：
  - 普通按键使用 `bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-primary)] border-[var(--border-subtle)]`。
  - 激活态修饰键（Ctrl/Alt/SelectMode）使用 `bg-indigo-600 text-white`，Shift 激活态保持 `bg-amber-600 text-white`，`OK` 快捷按钮保持 `bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`。
- `TerminalMagnifierBubble.tsx`、`TerminalSelectionToolbar.tsx`、`TerminalEmptyState.tsx`、`TerminalLogsView.tsx`：全部消除硬编码深色底，接入 `--bg-elevated` / `--bg-surface`。

---

## 5. 终端、ANSI 日志、Monaco 与 Markdown 双主题深度校准

### 5.1 Xterm.js 终端调色板（`WebTerminalView.tsx`）
- **Dark Theme (`DARK_TERMINAL_THEME`)**：
  - `background: '#090D16'`, `foreground: '#F1F5F9'`, `cursor: '#6366F1'`, `cursorAccent: '#090D16'`, `selectionBackground: 'rgba(99, 102, 241, 0.35)'`
  - 标准 16 色采用高清晰度现代终端配色。
- **Light Theme (`LIGHT_TERMINAL_THEME`)**：
  - `background: '#FFFFFF'`, `foreground: '#0F172A'`, `cursor: '#4F46E5'`, `cursorAccent: '#FFFFFF'`, `selectionBackground: 'rgba(79, 70, 229, 0.18)'`
  - 针对白底校准 16 色：`black: '#0F172A'`, `red: '#DC2626'`, `green: '#059669'`, `yellow: '#B45309'`, `blue: '#2563EB'`, `magenta: '#7C3AED'`, `cyan: '#0891B2'`, `white: '#475569'`, `brightBlack: '#64748B'`, `brightRed: '#E11D48'`, `brightGreen: '#10B981'`, `brightYellow: '#D97706'`, `brightBlue: '#4F46E5'`, `brightMagenta: '#9333EA'`, `brightCyan: '#06B6D4'`, `brightWhite: '#0F172A'`。

### 5.2 ANSI 日志格式化器（`ansiLogFormatter.ts`）
- 保持 `parseAnsiToSegments` 返回的 `colorClass` 对现有单元测试（如 `text-emerald-400`、`text-rose-400`）完全向后兼容。
- 在 `index.css` 中针对 `.ansi-log-container`（应用于 `TaskLogModal` 和 `CronLogModal` 日志区域）在浅色模式下提供精准的高对比度颜色映射（例如浅色下 `.ansi-log-container .text-emerald-400 { color: #047857; }`、`.text-amber-400 { color: #B45309; }`、`.text-slate-100 { color: #0F172A; }`），既不破坏纯函数单元测试，又保证浅色日志框极佳的可读性。

### 5.3 Monaco Editor 双主题（`monacoTheme.ts`）
- `gemini-proxy-dark`：`editor.background: '#090D16'`，`editor.lineHighlightBackground: '#151D2E80'`，`editorLineNumber.foreground: '#475569'`，`editorLineNumber.activeForeground: '#94A3B8'`。
- `gemini-proxy-light`：`editor.background: '#FFFFFF'`，`editor.lineHighlightBackground: '#F1F5F9'`，`editorLineNumber.foreground: '#94A3B8'`，`editorLineNumber.activeForeground: '#334155'`。

### 5.4 Markdown 渲染器（`markdownRenderer.ts`）
- 行内代码：`bg-[var(--code-bg)] text-indigo-600 dark:text-amber-300 border border-[var(--border-subtle)]`。
- 代码块容器：顶栏 `bg-[var(--bg-surface-sub)] text-[var(--text-secondary)]`，内容区 `bg-[var(--code-bg)] text-[var(--code-text)]`。
- 标题 H1–H6、正文段落、列表、表格、引用块全部使用 `text-[var(--text-primary)]`、`text-[var(--text-secondary)]`、`border-[var(--border-subtle)]`。

---

## 6. 测试与验证策略

1. **现有测试回归验证**：
   - 检查并确保 `tests/ansiLogFormatter.test.ts`、`tests/terminalAccessoryBar.test.ts`、`tests/terminalMobileFullscreenHeader.test.ts`、`tests/terminalFileManagerHiddenFiles.test.ts`、`tests/frontendLoginView.test.ts`、`tests/markdownRenderer.test.ts` 等所有测试通过（若個別静态源码字符串断言涉及旧硬编码类名，同步更新测试断言以匹配新语义类名）。
2. **新增企业级主题系统专项测试（`tests/enterpriseThemeSystem.test.ts`）**：
   - 验证 `index.css` 中完整定义了浅色与深色语义令牌，且已移除 `:root:not(.dark)` 脏覆盖补丁。
   - 验证 `LoginView.tsx`、`TerminalCronView.tsx`、`TerminalTaskView.tsx`、`TaskLogModal.tsx`、`CronJobModal.tsx`、`CronLogModal.tsx`、`CreateTaskModal.tsx`、`TerminalScriptDrawer.tsx` 等组件已彻底清除 `#121316`、`#18181b`、`#0c1017`、`#121214` 等硬编码深色背景。
   - 验证 `WebTerminalView.tsx` 与 `monacoTheme.ts` 的 Light / Dark 主题背景色与全局令牌严格对齐。
3. **构建验证**：
   - 执行 `npm run build:frontend` 验证 TypeScript 编译与 Tailwind CSS 构建无报错。
