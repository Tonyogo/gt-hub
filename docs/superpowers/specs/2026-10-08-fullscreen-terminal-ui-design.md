# 极简全屏 Web 终端与文件管理 UI 设计规范

## 1. 概述与背景

当前 `gt-hub` 前端界面存在外层应用标题栏（带 Logo、外层导航 Tab、卡片式固定宽度边框）、运行审计日志视图等附加业务壳，导致核心的 Web 终端与远程文件管理界面被限制在居中卡片内部，屏幕利用率不足且存在视觉冗余。

本次优化将全面精简外层壳架构：
- 彻底剔除外层应用标题栏、全局 `terminal | logs` 标签切换与运行日志模块。
- 重构为原生 100% 满屏（`100dvh` × `100vw`）沉浸式工作台。
- 仅保留核心的 Web 命令行终端（xterm.js）与远程文件管理器（Monaco Editor + 文件列表），并通过顶部的极简微型工具栏统一承载节点切换、模式切换与必要全局配置。

## 2. 界面与组件重构架构

### 2.1 剔除与清理模块
- **剔除组件**：
  - `frontend/src/components/TerminalLogsView.tsx` 及其相关未使用的依赖和翻译键（若无其他用途）。
- **废弃外层壳**：
  - `App.tsx` 中的旧版外层头部导航栏（`header` 包含 `gt-hub` 标题、外层 `nav`、日志 Tab 切换）。
  - 去除 `UnifiedTerminalView` 内部冗余的“普通窗口 / 全屏独立模式”（`isStandalone`）双重形态分支判断，统一默认采用纯粹满屏模式。

### 2.2 重构后的组件树
```text
App.tsx (根容器，固定 100dvh 全屏，管理 adminKey / theme / language 状态)
└── UnifiedTerminalView.tsx (全屏工作台容器)
    ├── MicroTopBar (顶部紧凑工具条，高 36px~40px)
    │   ├── LeftGroup
    │   │   ├── TerminalHostSelector (主机节点选择与状态)
    │   │   ├── Divider
    │   │   ├── TabPillGroup [ 命令行终端 | 文件管理 ]
    │   │   └── ConnectionBadge (动态连接状态微徽章)
    │   ├── Spacer (弹性留白)
    │   └── RightGroup
    │       ├── TerminalActions (缩放、重连、重置会话、划选模式 / 刷新)
    │       ├── Divider
    │       ├── AdminKeyConfig (弹出极简输入框)
    │       ├── LanguageToggle (语言切换)
    │       ├── ThemeToggle (深浅色切换)
    │       └── BrowserFullscreenToggle (浏览器原生全屏切换)
    └── ContentArea (flex-1 满高填充区域)
        ├── WebTerminalView (激活时展示，自动监听尺寸并触发 fit)
        └─��� TerminalFileManagerView (激活时展示，文件列表、Monaco 编辑器、图片预览)
```

## 3. 微型集成顶栏（Micro Top Bar）规范

- **高度**：36px ~ 40px，`shrink-0`，单行自适应。
- **背景与边框**：`bg-[var(--bg-surface)]`，底部分割线 `border-b border-[var(--border-subtle)]`。
- **左侧功能区**：
  - `TerminalHostSelector`：高集成度节点下拉框，显示主机名及延迟状态，并支持打开添加节点弹窗。
  - 分割线：`w-px h-3.5 bg-[var(--border-subtle)]`。
  - 模式切换胶囊（Pills）：
    - 选项：`命令行终端`（`TerminalSquare` 图标）与 `文件管理`（`FolderOpen` 图标）。
    - 激活样式：高对比度胶囊底色及文字（如主题强调色，无冗余厚重边框）。
  - 连接状态徽标（仅在终端模式展示）：
    - 状态灯指示（在线：绿光微晕；重连：琥珀微动；断开：红色）+ 极简状态文字。
- **右侧功能区**：
  - 终端模式动作按钮组：
    - 字体缩放（`ZoomIn` / `ZoomOut`，桌面端展示）。
    - 重新连接（`RefreshCw`）。
    - 重置会话（`Trash2`，带确认弹窗）。
    - 划选模式（`TextSelect`，切换终端原生可选状态）。
  - 文件模式动作按钮组：
    - 刷新目录（`RefreshCw`）。
  - 分割线。
  - 全局配置小图标：
    - Admin Key 凭证（`Key` 图标，点击展开浮动/行内暗色输入框）。
    - 语言切换（`Languages` 图标，中 / 英文切换）。
    - 主题切换（`Sun` / `Moon` 图标，明亮 / 暗色切换）。
    - 网页原生全屏（`Maximize` / `Minimize`，调用全屏 API）。

## 4. 终端与文件管理主区域规范

### 4.1 终端视图（WebTerminalView）
- **尺寸计算与适配**：
  - 容器尺寸：`w-full h-full min-h-0 flex-1`，彻底占满顶栏下方的所有屏幕空间。
  - 动态监听窗口 Resize 及移动端软键盘弹出（通过 Visual Viewport 监听），自动调用 `fitAddon.fit()` 重新计算终端行列数并与服务端同步。
  - 移动端虚拟键盘辅助栏（`TerminalAccessoryBar`）根据视口偏移量浮动贴合在软键盘上方，不遮挡输入区。

### 4.2 文件管理视图（TerminalFileManagerView）
- **布局利用**：
  - 顶部面包屑与新建/上传操作紧贴顶栏下方，间距紧凑。
  - 表格与文件列表占满剩余高度，内部独立滚动。
  - Monaco 代码编辑器与图片预览浮层以沉浸式浮层或平铺模式打开，填满工作区。

## 5. 错误处理与极端场景

1. **无在线主机 / 节点断开**：
   - 终端模式下居中展示极简暗色空状态提示与重连按钮，不破坏全屏框架。
2. **移动端小屏体验**：
   - 顶栏在窄屏下隐藏非核心次要文字（仅展示图标），并隐藏桌面端独有的缩放按钮，优先保证节点选择器与模式切换的可见性。
3. **Admin Key 持久化**：
   - 维持 `localStorage.getItem('admin_secret_key')` 逻辑，在微顶栏内无缝修改并自动通知给子组件。

## 6. 测试与验证策略

1. **类型与构建检查**：
   - 运行 `npm run build`（在 `frontend` 目录执行 `tsc --noEmit && vite build`），确保无废弃类型或丢失属性的报错。
2. **终端 Resize 与 Fit 验证**：
   - 检查从桌面端到移动端视口变化时，xterm 终端是否能平滑撑满宽度与高度，无死角黑边。
3. **模式切换与持久化**：
   - 在终端与文件管理之间快速切换，验证会话状态保留、文件刷新与 Admin Key 保存是否正常。
