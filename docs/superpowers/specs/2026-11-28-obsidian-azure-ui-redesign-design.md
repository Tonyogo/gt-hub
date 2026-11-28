# Obsidian Azure UI 体系重构与 App Hub 集成设计文档

**日期**：2026-11-28  
**设计基线**：`../app-hub/docs/subsystem-ui-design-guide.md`（Obsidian Azure · 极光曜石）  
**状态**：待审阅  

---

## 1. 背景与目标

`gt-hub` 前端作为可独立运行亦可无缝嵌入 App Hub「发现中心（`EmbeddedWebView`）」的终端与运维工作台，当前界面存在以下系统性偏差：

1. **视觉色系偏离**：仍采用旧版 Slate/Navy 底色（`#090D16` / `#F8FAFC`）与全站 250+ 处 `indigo-*` / `slate-*` 硬编码，未落地 Obsidian Azure 深浅四层景深以及「单色高对比主 CTA 与 Azure/Cyan 遥测强调色分离」原则。
2. **排版与圆角失范**：`UnifiedTerminalView` 根容器整体套用 `font-mono text-xs`，导致中文标题、导航与表格列头误用等宽字体；缺少自托管字体、移动端 `16px` 防缩放保护与 `prefers-reduced-motion` 降级规则；圆角混用 `rounded-2xl` / `rounded-xl`。
3. **弹窗层级与 Tailwind v3 样式陷阱**：除 `TerminalHostSelector` 外，其余 11 处业务弹窗/抽屉未挂载至 `document.body` Portal，且缺少统一的 `role="dialog"` / `aria-modal` / `Escape` 关闭 / `max-h-[88dvh]` 约束；全站 9 处 `bg-[var(--*)]/95`（及 `/80`）写法在 Tailwind CSS v3 中静默失效导致浮层背景透明。
4. **宿主集成与首屏防闪烁缺口**：`frontend/index.html` 缺少首屏 Anti-FOUC 同步脚本；在 App Hub `iframe` 内嵌运行时，顶栏仍展示与宿主重复的 GitHub 外链、独立主题切换及 SSO 场景下的退出登录按钮；`xterm.js` 与 `Monaco Editor` 深色背景仍停留在 `#090D16`。

### 目标与成功标准

- **视觉一致性**：深色（`#07080a` / `#0b0d11` / `#101216` / `#161920`）与浅色（`#f5f6f8` / `#fafbfc` / `#ffffff` / `#f8f9fb`）四层景深、主 CTA 与强调色分离、三级圆角、语义状态色与 App Hub 完全对齐。
- **离线自托管排版**：引入 `@fontsource-variable/inter` 与 `@fontsource-variable/jetbrains-mono` 离线打包，全站 UI 文本回归 `font-sans`，仅代码/路径/ID/时间戳/终端/对齐数值使用 `font-mono`。
- **宿主无缝集成**：首屏零白屏闪烁，支持 URL / `localStorage` / `theme-change` / `app-hub:auth-init` 实时同步；嵌入 `iframe` 时自动收起冗余壳层控件并 `100%` 铺满视口。
- **工程健壮性**：通过单一轻量化 `ModalShell` 统一 12 处弹窗/抽屉 Portal 与交互规范；根除全部 Tailwind v3 变量透明度失效写法；零侵入终端核心 I/O、帧合批与移动端输入/选区逻辑。

---

## 2. 总体架构决策

采用 **薄 CSS 原语层 + 统一 `ModalShell` Portal 壳 + 渐进增强现有 Context** 架构：

1. **样式层（`frontend/src/index.css`、`frontend/tailwind.config.js`）**：承载完整 Obsidian Azure CSS Token、组件原语类（`.ui-card`、`.ui-btn-primary`、`.ui-btn-secondary`、`.ui-ambient-stage`、`.ui-row-indicator`、`.ui-modal-shell`、`.ui-composer-shell`、`.ui-badge-*`、`.ui-elevated-glass`、`.ui-surface-glass`）以及响应式/降级保护。
2. **最小共享组件层（`frontend/src/components/ui/ModalShell.tsx`）**：仅抽取 1 个高频易错底层容器，统一封装 `createPortal(..., document.body)`、键盘与遮罩关闭、视口高度/滚动隔离与无障碍属性，不引入第三方无头组件库。
3. **宿主集成层（`frontend/index.html`、`ThemeContext.tsx`、`AuthContext.tsx`）**：保留既有四级自动主题探测与严格 Origin SSO 校验，补齐 Anti-FOUC 脚本并暴露 `isEmbedded` 与 `isSsoAuthenticated`。
4. **视图与终端配色层**：按四层景深与局部布局精修策略，系统性升级登录页、顶栏导航、任务管理、定时任务、文件管理、网络代理、实时日志、节点选择、`xterm.js` 与 `Monaco`。

---

## 3. 详细设计

### 3.1 视觉基础层（Token、字体、圆角、终端/编辑器与反模式修复）

#### 3.1.1 CSS Token 体系（`frontend/src/index.css`）

在 `:root`（浅色）与 `:root.dark, :root[data-theme="dark"]`（深色）中完整定义设计指南第 3 节的全部标准变量，同时保留项目既有别名变量以实现平滑迁移：

| 语义分类 | 变量名 | 浅色值（Light） | 深色值（Dark） |
| --- | --- | --- | --- |
| 四层表面 | `--bg-canvas` / `--bg-sidebar` / `--bg-surface` / `--bg-surface-sub` | `#f5f6f8` / `#fafbfc` / `#ffffff` / `#f8f9fb` | `#07080a` / `#0b0d11` / `#101216` / `#161920` |
| 输入与交互 | `--bg-input` / `--bg-surface-hover` | `#ffffff` / `rgba(17, 19, 24, 0.04)` | `#0b0d11` / `rgba(255, 255, 255, 0.045)` |
| 兼容别名 | `--bg-elevated` / `--bg-terminal` / `--bg-control` / `--bg-control-hover` / `--bg-overlay` | `#ffffff` / `#ffffff` / `rgba(17, 19, 24, 0.04)` / `rgba(17, 19, 24, 0.075)` / `rgba(9, 9, 11, 0.35)` | `#13161d` / `#07080a` / `rgba(255, 255, 255, 0.045)` / `rgba(255, 255, 255, 0.09)` / `rgba(0, 0, 0, 0.6)` |
| 边框体系 | `--border-subtle` / `--border-hover` / `--border-input`（别名 `--border-default`） / `--border-focus` | `#e2e5eb` / `#cfd5df` / `#d5dbe4` / `#2563eb` | `rgba(255,255,255,0.085)` / `rgba(255,255,255,0.16)` / `rgba(255,255,255,0.12)` / `#3b82f6` |
| 文本层级 | `--text-primary` / `--text-secondary` / `--text-muted` | `#111318` / `#4b5262` / `#646b7a` | `#f4f6f9` / `#a1a8b8` / `#858d9e` |
| 单色主 CTA | `--cta-bg` / `--cta-hover` / `--cta-text` | `#111318` / `#262b36` / `#ffffff` | `#f4f6f9` / `#e2e7f0` / `#09090b` |
| 遥测强调色 | `--accent-primary` / `--accent-fill` / `--accent-hover` / `--accent-text` / `--accent-soft-bg` / `--accent-soft-border` | `#2563eb` / `#2563eb` / `#1d4ed8` / `#1d4ed8` / `#eff6ff` / `#bfdbfe` | `#3b82f6` / `#3b82f6` / `#60a5fa` / `#60a5fa` / `rgba(59,130,246,0.14)` / `rgba(96,165,250,0.28)` |
| 语义状态（Success） | `--status-success-{text,bg,border}` | `#047857` / `#ecfdf5` / `#a7f3d0` | `#34d399` / `rgba(16,185,129,0.14)` / `rgba(52,211,153,0.28)` |
| 语义状态（Warning） | `--status-warning-{text,bg,border}` | `#92400e` / `#fffbeb` / `#fde68a` | `#fbbf24` / `rgba(245,158,11,0.14)` / `rgba(251,191,36,0.28)` |
| 语义状态（Danger） | `--status-danger-{text,bg,border}` | `#be123c` / `#fff1f2` / `#fecdd3` | `#fb7185` / `rgba(244,63,94,0.14)` / `rgba(251,113,133,0.28)` |
| 语义状态（Info） | `--status-info-{text,bg,border}` | `#0369a1` / `#f0f9ff` / `#bae6fd` | `#38bdf8` / `rgba(56,189,248,0.14)` / `rgba(56,189,248,0.28)` |
| 代码与图表 | `--code-bg` / `--code-text` / `--chart-grid` / `--chart-axis` | `#ffffff` / `#111318` / `#e7eaef` / `#646b7a` | `#0b0d11` / `#e5e9f0` / `rgba(255,255,255,0.07)` / `#858d9e` |
| 投影（Card / Hover） | `--shadow-card` / `--shadow-card-hover` | `0 1px 2px rgba(17,19,24,0.04), 0 6px 16px -4px rgba(17,19,24,0.05)` / `0 2px 6px rgba(17,19,24,0.05), 0 12px 24px -6px rgba(17,19,24,0.08)` | `inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 28px -12px rgba(0,0,0,0.68)` / `inset 0 1px 0 rgba(255,255,255,0.13), 0 14px 32px -10px rgba(0,0,0,0.8)` |
| 投影（Input / Popover） | `--shadow-input` / `--shadow-popover` | `0 1px 2px rgba(17,19,24,0.02)` / `0 14px 34px -6px rgba(17,19,24,0.12), 0 4px 12px -2px rgba(17,19,24,0.06)` | `none` / `inset 0 1px 0 rgba(255,255,255,0.09), 0 22px 52px -12px rgba(0,0,0,0.85)` |
| 滚动条 | `--scrollbar-thumb` / `--scrollbar-thumb-hover` | `rgba(0,0,0,0.15)` / `rgba(0,0,0,0.28)` | `rgba(255,255,255,0.12)` / `rgba(255,255,255,0.24)` |

#### 3.1.2 核心 CSS 原语类

- `.ui-card` / `.ui-card-interactive`：卡片背景、边框、`12px` 圆角、`var(--shadow-card)` 及深色模式顶部微渐变（`linear-gradient(180deg, rgba(255,255,255,0.025) 0%, transparent 100%)`）。
- `.ui-btn-primary`：使用 `--cta-bg` / `--cta-hover` / `--cta-text`，`8px` 圆角（`rounded-lg`）；**严禁叠加 `text-white`**，加载旋转指示器使用 `text-current` 或 `border-current border-t-transparent`。
- `.ui-btn-secondary` / `.ui-icon-btn` / `.ui-input` / `.ui-composer-shell`：统一 `8px` 圆角（输入框容器 `.ui-composer-shell` 为 `12px`）、`--accent-fill` 聚焦环（`0 0 0 3px rgba(59, 130, 246, 0.14)`）。
- `.ui-ambient-stage`：仅用于 `LoginView` 与各空状态顶部约 `260px` 极光氛围晕，严禁铺在密集表格、日志或终端区域。
- `.ui-row-indicator`：选中行左侧 `2.5px` 垂直指示条（深色青蓝渐变 + `box-shadow: 0 0 8px rgba(56, 189, 248, 0.65)`）。
- `.ui-badge-success` / `.ui-badge-warning` / `.ui-badge-danger` / `.ui-badge-info` / `.ui-badge-neutral`：`6px` 圆角（`rounded-md`），直接绑定 `--status-*` Token。
- `.ui-elevated-glass` 与 `.ui-surface-glass`：使用 `background-color: color-mix(in srgb, var(--bg-elevated) 92%, transparent)` 与 `color-mix(in srgb, var(--bg-surface) 84%, transparent)`，全面替代 Tailwind v3 下失效的 `bg-[var(--*)]/95` 与 `bg-[var(--*)]/80`。

#### 3.1.3 自托管字体与排版/圆角/响应式保护

- 安装依赖：`frontend/package.json` 新增 `@fontsource-variable/inter` 与 `@fontsource-variable/jetbrains-mono`，在 `frontend/src/main.tsx` 顶部引入：
  ```ts
  import '@fontsource-variable/inter';
  import '@fontsource-variable/jetbrains-mono';
  ```
- 字体变量与 Tailwind 绑定：在 `index.css` 定义 `--font-sans` 与 `--font-mono`，在 `tailwind.config.js` 将 `theme.extend.fontFamily.sans` 和 `fontFamily.mono` 绑定至对应 CSS 变量，`body` 默认应用 `font-family: var(--font-sans)`。
- 根字体修正：移除 `UnifiedTerminalView.tsx` 根节点的 `font-mono text-xs`，保持所有导航、标题、按钮与表头为 `font-sans`；仅在终端画布、命令/脚本/JSON、文件路径、Task ID、Cron 表达式、URL、时间戳与对齐数值（搭配 `tabular-nums`）显式使用 `font-mono`。
- 三级圆角纪律：卡片/面板/常规弹窗 `rounded-xl`（`12px`，大桌面模态框可用 `rounded-2xl`）；按钮/输入框/下拉/顶栏控件 `rounded-lg`（`8px`）；状态徽章/能力芯片 `rounded-md`（`6px`）；`rounded-full` 仅用于状态圆点、滚动回底圆钮与开关滑块。
- 移动端与无障碍规则：在 `index.css` 补充 `@media screen and (max-width: 767px) { input:not(.xterm-helper-textarea), textarea:not(.xterm-helper-textarea), select { font-size: 16px !important; } }`（显式排除 xterm 内部隐藏输入框，确保不影响终端 IME 行高与坐标计算）以及 `@media (prefers-reduced-motion: reduce)` 动效禁用规则。

#### 3.1.4 终端与代码编辑器配色同步

- **`frontend/src/components/WebTerminalView.tsx`**：
  - `DARK_TERMINAL_THEME`：`background: '#07080a'`，`foreground: '#f4f6f9'`，`cursor: '#60a5fa'`，`selectionBackground: 'rgba(59, 130, 246, 0.32)'`，ANSI 蓝/青校准为 `#60a5fa` / `#38bdf8`。
  - `LIGHT_TERMINAL_THEME`：`background: '#ffffff'`，`foreground: '#111318'`，`cursor: '#2563eb'`，`selectionBackground: 'rgba(37, 99, 235, 0.2)'`。
- **`frontend/src/utils/monacoTheme.ts`**：
  - `gemini-proxy-dark`：`editor.background: '#0b0d11'`，`editor.lineHighlightBackground: '#161920'`，`editorLineNumber.foreground: '#646b7a'`，`editorLineNumber.activeForeground: '#a1a8b8'`。
  - `gemini-proxy-light`：`editor.background: '#ffffff'`，`editor.lineHighlightBackground: '#f8f9fb'`，`editorLineNumber.foreground: '#858d9e'`，`editorLineNumber.activeForeground: '#111318'`。

---

### 3.2 宿主集成与壳层收口

#### 3.2.1 首屏 Anti-FOUC 引导脚本（`frontend/index.html`）

在 `<head>` 中加入同步执行内联脚本，在任何 React Bundle 加载前确定初始主题并写入背景色：
- 优先级：`URL ?theme / ?colorScheme` → `localStorage.getItem('gt_hub_theme_mode') || localStorage.getItem('app_hub_theme_mode')` → `window.matchMedia('(prefers-color-scheme: dark)').matches`（兜底 `'dark'`）；
- 同步设置 `root.classList.toggle('dark', isDark)`、`root.setAttribute('data-theme', resolved)`、`root.style.colorScheme = resolved`、`root.style.backgroundColor = isDark ? '#07080a' : '#f5f6f8'`。

#### 3.2.2 `ThemeContext.tsx` 与 `AuthContext.tsx` 增强

- **`ThemeContext.tsx`**：
  - 在 `PARENT_STORAGE_KEYS` 首位增加 `'app_hub_theme_mode'`；
  - `applyThemeToRootDocument(resolved)` 同步设置 `root.style.backgroundColor = resolved === 'dark' ? '#07080a' : '#f5f6f8'`；
  - 在 `ThemeContextType` 新增 `isEmbedded: boolean`（由 `isEmbeddedIframe()` 初始化），使所有页面一致感知 `iframe` 嵌入状态；
  - 保留既有四级自动探测与 `postMessage`（覆盖 App Hub `theme-change` 与 `app-hub:auth-init` 携带的 `theme` / `colorScheme` / `isDark`）。
- **`AuthContext.tsx`**：
  - 新增并暴露 `isSsoAuthenticated: boolean`：当初始凭据来自 `consumeHashAdminKey()` 或通过 `app-hub:auth-init` 消息完成免登时置为 `true`；手动表单 `login()` 成功或 `logout()` 时置为 `false`；
  - 保留现有的 URL Hash 清理（`history.replaceState`）、`app-hub:auth-request` 主动握手与 Origin 白名单/同根域校验逻辑。

#### 3.2.3 `UnifiedTerminalView` 顶栏、下划线子导航与嵌入态收口

- **无双层外壳**：主容器在独立模式与 `isEmbedded` 嵌入模式下均使用 `h-[100dvh] w-screen rounded-none border-none shadow-none bg-[var(--bg-canvas)]`；顶栏采用 `bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]`（桌面高约 `44px`，紧凑贴合）。
- **第一层下划线子导航（5 个 SubTab）**：
  - 替换原 `bg-indigo-600 text-white` 蓝紫胶囊，改用无底色干扰的下划线 Tab：
    - 激活态：文字 `text-[var(--text-primary)] font-medium`，图标 `text-[var(--accent-text)]`，底部 `2px` 激活指示条（`.ui-tab-underline-active`：浅色 `var(--accent-fill)`，深色 `linear-gradient(90deg, #38bdf8, #3b82f6)` + `box-shadow: 0 0 8px rgba(56, 189, 248, 0.55)`）；
    - 未激活态：`text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]`。
- **嵌入态（`isEmbedded === true`）壳层收口**：
  - 桌面顶栏与移动端「更多菜单」同时隐藏 **GitHub 仓库外链** 与 **独立主题切换按钮**；
  - 当 `isEmbedded && isSsoAuthenticated` 为真时，隐藏 **退出登录** 按钮（避免误退出破坏 App Hub 免登态）；
  - 保留 **语言切换**、**全屏切换**、服务器时区标签以及全部业务操作按钮（节点选择、粘贴、划选、分屏、脚本库、缩放、重连、重置、刷新）。
- **分屏视图**：激活窗格边框、顶部窗格头与 `Active` 标识统一迁移至 `--accent-primary` / `--accent-soft-bg` / `--accent-soft-border` / `--accent-text`；拖拽分隔条改用 `bg-[var(--border-subtle)] hover:bg-[var(--accent-primary)]` 的细线条设计。

#### 3.2.4 `LoginView.tsx` 与 `App.tsx`

- **`App.tsx`**：认证检测 Loading 图标由 `text-indigo-500` 改为 `text-[var(--accent-primary)]`。
- **`LoginView.tsx`**：
  - 外层背景应用 `.ui-ambient-stage` 顶部极光氛围晕；
  - 居中登录容器改为 `.ui-card`（`rounded-xl`，深色顶部高光 + 微渐变）；
  - 品牌 Logo 底座改为低饱和 Azure Tinted（`bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)]`）；
  - 密钥输入区改用 `.ui-composer-shell`；
  - 提交按钮改为单色 `.ui-btn-primary`（移除 `bg-indigo-600 text-white`），Loading 图标使用 `text-current`；
  - 当 `isEmbedded === true` 时隐藏右上角 GitHub 外链与主题切换按钮，仅保留语言切换。

---

### 3.3 核心业务视图布局精修

#### 3.3.1 `TerminalTaskView.tsx`（后台任务管理）
- **单容器 4 列无缝指标条**：合并原有 4 个零散带独立边框的统计卡为 1 个 `.ui-card overflow-hidden`，内部采用 `grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[var(--border-subtle)]`。核心 KPI 数字采用 `text-[26px] leading-tight font-semibold tracking-tight font-mono tabular-nums`，图标芯片使用低饱和 Tinted 风格，运行中数量 > 0 时搭配带微光的语义状态点。
- **SWR 局部刷新**：当已有数据且触发刷新时，在列表区域顶部渲染 `2px` Azure 动画进度条并给主体内容加 `opacity-70 transition-opacity`，不卸载现有列表。
- **筛选器、数据表与空状态**：「新建任务」主 CTA 改为 `.ui-btn-primary`；状态筛选激活项改为 `--accent-soft-bg` / `--accent-soft-border` / `--accent-text`；表格头部下沉至 `--bg-surface-sub`，状态徽章统一 `.ui-badge-*`，任务 ID 与耗时使用 `font-mono tabular-nums`；空状态容器叠加 `.ui-ambient-stage` 与微光徽章底座。

#### 3.3.2 `TerminalCronView.tsx`（定时任务）
- 顶栏搜索框统一 `.ui-input`（`rounded-lg`，无衬线占位提示），主按钮「新建任务」改为 `.ui-btn-primary`，数据刷新同样采用顶部 `2px` SWR 细进度条。
- 列表卡片与表格升级为 `.ui-card` + `--bg-surface-sub` 表头；Cron 表达式、下次运行时间、执行耗时统一 `font-mono tabular-nums`；`hub:` 脚本标识改为 `--accent-soft-bg` / `--accent-text`；运行状态点在深色模式保留微光环；空状态叠加 `.ui-ambient-stage`。

#### 3.3.3 `TerminalFileManagerView.tsx` & `markdownRenderer.ts`（文件管理）
- **Edge-to-Edge 工作台**：移除顶部路径与操作栏上的 `.ui-card` 外框与 `mb-2` 留白，改为紧贴容器顶部的 `--bg-surface border-b border-[var(--border-subtle)]` 栏，下方文件表格与空状态直接铺满剩余区域，消除双层卡片嵌套。
- **主操作与拖拽蒙层**：上传/新建按钮按主次分离使用 `.ui-btn-primary` / `.ui-btn-secondary`；拖拽上传蒙层由失效的 `bg-[var(--bg-surface)]/80` 替换为 `.ui-surface-glass` + `border-2 border-dashed border-[var(--accent-primary)]`；Toast 改用 `.ui-elevated-glass`；文件大小与修改时间使用 `font-mono tabular-nums`。
- **图标与 Markdown 渲染**：代码类文件图标从 `indigo-400` 调整为 `text-blue-500 dark:text-blue-400`；`frontend/src/utils/markdownRenderer.ts` 中链接、引用左边框、行内代码与任务列表复选框全部由 `indigo-*` 迁移至 `text-[var(--accent-text)]`、`border-[var(--accent-primary)]` 与 `var(--code-bg)`。

#### 3.3.4 `TerminalProxyView.tsx`（网络代理与 HTTP 调试台）
- 顶部监听端口条、请求构造器、响应详情与测速面板统一对齐 Obsidian Azure 四层表面（顶栏 `--bg-surface`、功能卡 `.ui-card`、请求体/响应体/CLI 命令槽 `--code-bg` + `font-mono`）。
- 清除全部 `indigo-*` 图标与按钮（展开端口按钮、复制图标改用 `--accent-text` / `--accent-soft-bg`）；「发送请求」「开始测速」主按钮使用单色 `.ui-btn-primary`；延迟与速率指标使用 `font-mono tabular-nums`；Toast 改用 `.ui-elevated-glass`。

#### 3.3.5 `TerminalHostSelector`、`TerminalEmptyState`、`TerminalLogsView` 与终端浮层
- **`TerminalHostSelector.tsx`**：下拉列表采用 `--bg-surface` + `var(--shadow-popover)`（`rounded-xl`），选中节点行左侧加入 `.ui-row-indicator`（`2.5px` 垂直青蓝指示条），在线状态圆点在深色模式配微光，弹窗内「复制」与提示卡清除全部 `indigo-*`。
- **`TerminalEmptyState.tsx`**：应用 `.ui-ambient-stage` 与微光边框图标底座（`--accent-soft-bg` + `--accent-soft-border` + 深色柔和外晕），「接入内网新节点」使用 `.ui-btn-primary`。
- **`TerminalLogsView.tsx` & `ansiLogFormatter.ts`**：全量清除 `slate-*` / `indigo-*` 硬编码；搜索框、级别筛选、自动滚动激活态改用 Azure 强调 Token；`ansiLogFormatter.ts` 中默认文本与暗灰采用语义类或高对比中性灰，蓝/亮蓝改用 `text-blue-400` 并同步调整 `index.css` 浅色 `.ansi-log-container` 覆写确保 ≥ 4.5:1。
- **终端浮层与移动端附件栏**：
  - `WebTerminalView.tsx` 断连提示条、底部提示胶囊、回底按钮、`TerminalSelectionToolbar.tsx`、`TerminalMagnifierBubble.tsx` 全部用 `.ui-elevated-glass` 替代 `bg-[var(--*)]/95`；
  - `TerminalAccessoryBar.tsx` 修饰键（Ctrl / Alt / Shift）激活态改为 `--accent-soft-bg` / `--accent-soft-border` / `--accent-text`。

---

### 3.4 统一 `ModalShell` Portal 架构

#### 3.4.1 组件接口（`frontend/src/components/ui/ModalShell.tsx`）

```ts
export interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  variant?: 'modal' | 'drawer';        // 默认 'modal'
  maxWidthClassName?: string;          // 默认 'max-w-lg'（drawer 默认 'max-w-md'）
  heightClassName?: string;            // 固定高弹窗如编辑器/预览可传 'h-[88dvh]'
  zIndex?: 'base' | 'nested';          // 'base' => z-50, 'nested' => z-[60]
  closeOnBackdrop?: boolean;           // 默认 true
  disableClose?: boolean;              // 默认 false（异步提交锁定时传 true）
  bodyClassName?: string;              // 内容区自定义 padding/背景
  noHeader?: boolean;                  // 图片预览等自定义顶栏时可选
  ariaLabel?: string;                  // 无标题时兜底 aria-label
}
```

#### 3.4.2 行为规范

- **Portal 安全挂载**：`if (!isOpen || typeof document === 'undefined') return null;`，经由 `createPortal(..., document.body)` 渲染。
- **视口与滚动纪律**：
  - `variant="modal"`：遮罩 `fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-zinc-950/35 dark:bg-black/60 backdrop-blur-xl`；壳体 `ui-card ui-modal-shell overflow-hidden flex flex-col w-full max-h-[88dvh] rounded-t-2xl sm:rounded-xl`（大桌面预览/编辑模态框可选 `sm:rounded-2xl`）；头部与底部严格 `shrink-0`；主体区严格 `flex-1 min-h-0 overflow-y-auto overscroll-contain`；移动端底部自动叠加 `env(safe-area-inset-bottom)`。
  - `variant="drawer"`：遮罩 `fixed inset-0 flex justify-end bg-zinc-950/35 dark:bg-black/60 backdrop-blur-xl`；壳体 `ui-modal-shell bg-[var(--bg-sidebar)] border-l border-[var(--border-subtle)] h-full w-full flex flex-col overflow-hidden`；同样保持 `shrink-0` 头尾 + `flex-1 min-h-0 overflow-y-auto overscroll-contain`。
- **动效安全**：入场仅使用纯 `opacity` 过渡，严禁在遮罩或弹窗壳上使用带残留 `transform` 的 `zoom-in-*` / `scale-*` 动画类。
- **无障碍与键盘**：挂载 `role="dialog" aria-modal="true"`，通过 `useId()` 关联 `aria-labelledby`；注册 `keydown` 监听 `Escape` 触发 `onClose`（受 `disableClose` 保护）。

#### 3.4.3 全站 12 处弹窗/抽屉迁移清单

| 位置 | 弹窗 / 抽屉 | 变体与层级 |
| --- | --- | --- |
| `CreateTaskModal.tsx` | 新建后台任务 | `modal` / `base`（`z-50`） |
| `CronJobModal.tsx` | 新建/编辑定时任务 | `modal` / `base`（`z-50`） |
| `CronLogModal.tsx` | 定时任务执行历史与日志 | `modal` / `base`（`z-50`） |
| `TaskLogModal.tsx` | 后台任务实时日志 | `modal` / `base`（`z-50`） |
| `TerminalScriptDrawer.tsx` | 常用脚本库抽屉 | `drawer` / `base`（`z-50`） |
| `TerminalImagePreviewModal.tsx` | 图片预览弹窗 | `modal` / `base`（`z-50`） |
| `TerminalPdfPreviewModal.tsx` | PDF 预览弹窗 | `modal` / `base`（`z-50`） |
| `TerminalHostSelector.tsx` | 接入内网新节点引导弹窗 | `modal` / `base`（`z-50`） |
| `TerminalFileManagerView.tsx` (×4) | 新建文件夹 / 重命名 / 删除确认 / 代码与 Markdown 编辑器弹窗 | `modal` / `base`（编辑器内二次确认或叠层用 `nested` `z-[60]`） |

> 注：`TerminalHostSelector` 的节点选择下拉浮层属于 anchored popover，继续保留其精准定位 `createPortal(..., document.body)`，仅升级视觉样式与 `.ui-row-indicator`。

---

## 4. 风险边界与零回归约束

1. **终端核心体验零变更**：不改动 `WebTerminalView.tsx` 的 WebSocket 二进制协议解析、`TerminalWriteScheduler` 帧合批、滚轮/触控板防串码门禁、IME 输入及划选逻辑，仅替换配色常量与浮层透明样式类。
2. **移动端输入框防缩放兼容性**：全局 `@media (max-width: 767px)` 规则显式使用 `:not(.xterm-helper-textarea)`，确保移动端表单不触发 iOS 缩放且不干扰终端内部隐藏 IME 控件的坐标与行高计算。
3. **离线构建完整性**：验证安装 `@fontsource-variable/inter` 与 `@fontsource-variable/jetbrains-mono` 后，所有 `.woff2` 字体均由 Vite 打包进 `dist/frontend/assets/`，HTML 与 CSS 中零外链请求。
4. **独立与嵌入双场景回归**：确保独立访问模式保留完整主题切换/GitHub/登出能力，嵌入 `iframe` 模式与 App Hub `theme-change` / `app-hub:auth-init` 实时联动且无冗余壳层。

---

## 5. 测试与验收计划

### 5.1 设计系统守卫测试升级（`tests/enterpriseThemeSystem.test.ts`）

同步更新并强化既有架构守卫测试，使其成为 Obsidian Azure 的持续回归防线：
- **Token 完整性**：校验 `frontend/src/index.css` 包含全部 Obsidian Azure 深浅 Token（`#07080a`、`#0b0d11`、`#101216`、`#161920`、`#f5f6f8`、`#fafbfc`、`#ffffff`、`#f8f9fb`、`--cta-bg`、`--accent-primary`、`--status-success-text`、`--shadow-card` 等）、`.ui-card` / `.ui-btn-primary` / `.ui-btn-secondary` / `.ui-ambient-stage` / `.ui-row-indicator` / `.ui-modal-shell` / `.ui-composer-shell`、移动端 `16px` 防缩放规则与 `prefers-reduced-motion` 规则。
- **反模式零残留静态扫描**：扫描 `frontend/src/` 下全部 `.ts` / `.tsx` / `.css` 文件，断言：
  - 0 处 `indigo-` 类名；
  - 0 处 `slate-` 类名；
  - 0 处 Tailwind v3 失效 CSS 变量透明度修饰符（`/(?:bg|border|text)-\[var\(--[^\]]+\)\]\//`）；
  - 0 处 `fonts.googleapis.com` / `fonts.gstatic.com` 外部 CDN 引用；
  - `.ui-btn-primary` 调用处不叠加 `text-white`。
- **终端与编辑器同步**：校验 `WebTerminalView.tsx` 使用 `#07080a` / `#ffffff`，`monacoTheme.ts` 使用 `#0b0d11` / `#ffffff`。
- **首屏 Anti-FOUC 与自托管字体**：校验 `frontend/index.html` 包含同步主题初始化脚本，`frontend/src/main.tsx` 引入 `@fontsource-variable/inter` 与 `@fontsource-variable/jetbrains-mono`。
- **全量弹窗 Portal 化**：校验 12 处业务弹窗/抽屉文件全部使用 `ModalShell`（不再直接手写裸 `fixed inset-0` 弹窗壳）。

### 5.2 新增专项单元测试

- **`tests/modalShell.test.ts`**：验证 `ModalShell` 经由 `createPortal` 挂载至 `document.body`、包含 `role="dialog"` 与 `aria-modal="true"`、响应 `Escape` 与遮罩点击关闭、`disableClose` 生效、`zIndex="nested"` 输出 `z-[60]`、`max-h-[88dvh]` 与 `overscroll-contain` 存在。
- **`tests/autoHostThemeSync.test.ts` & `tests/frontendAuthContext.test.ts` 扩展**：验证 `app_hub_theme_mode` 兼容、`root.style.backgroundColor` 同步、`isEmbedded` 与 `isSsoAuthenticated` 状态导出，以及 `UnifiedTerminalView` / `LoginView` 在嵌入态隐藏重复壳层控件的渲染逻辑。

### 5.3 回归验证命令

- 定向测试：`npm test -- tests/enterpriseThemeSystem.test.ts tests/modalShell.test.ts tests/autoHostThemeSync.test.ts tests/frontendAuthContext.test.ts tests/frontendLoginView.test.ts tests/frontendCronModals.test.ts tests/frontendUnifiedSubTabs.test.ts tests/frontendSplitPaneTerminal.test.ts tests/frontendSplitPaneWorkspace.test.ts tests/frontendMobileCronAndTaskViews.test.ts tests/proxyUi.test.ts tests/fileManagerMarkdownAndPdf.test.ts`
- 类型检查与全量构建：`npm run typecheck && npm run build`
