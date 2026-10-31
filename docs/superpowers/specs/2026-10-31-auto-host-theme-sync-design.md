# 自动跟随系统与嵌入宿主网页主题同步设计规范 (Auto System & Embedded Host Theme Sync Design)

**日期**: 2026-10-31  
**范围**: `frontend/src/theme/ThemeContext.tsx`、`frontend/src/components/LoginView.tsx`、`frontend/src/components/UnifiedTerminalView.tsx` 及国际化与自动化测试。

---

## 1. 背景与设计目标

当 `gt-hub` 独立访问或作为 `<iframe>` 嵌入到其他管理系统（如类似 `zashboard`、云原生运维面板、内部 Portal）时，目前存在以下问题：
1. `ThemeMode` 仅支持 `'dark' | 'light'` 二态，默认固定为 `'dark'`，无法默认跟随操作系统或宿主环境。
2. 当嵌入到其他网站（`window.self !== window.top`）时，若本地 `localStorage` 曾保存过 `'dark'`，页面会被锁死在深色，无法跟随外部宿主网站的浅色/深色主题变化。
3. 未监听 `window.matchMedia('(prefers-color-scheme: dark)')`、同源父文档 DOM 属性/背景色以及跨源 `postMessage` 主题广播。

**设计目标**：
- 引入 `'system'`（自动模式）作为默认 `ThemeMode`，形成 `'system' | 'light' | 'dark'` 三态体系，同时 `resolvedTheme` 保持 `'light' | 'dark'` 二态输出，确保下游 Xterm、Monaco 与所有 UI 组件零改动无缝兼容。
- 实现 **四层宿主/系统主题自动感知与实时同步引擎**：
  1. **URL 参数透传**（`?theme=dark|light|auto|system`）
  2. **跨源 `postMessage` 主题消息监听**
  3. **同源父窗口 DOM（`class`/`data-theme`/`style.colorScheme`/背景色亮度 Luminance）探测 + `MutationObserver` 实时同步**
  4. **浏览器 `prefers-color-scheme` 媒体查询监听**（同时覆盖操作系统主题切换与跨域宿主 `color-scheme` CSS 属性穿透）
- 当运行在 `<iframe>` 嵌入环境中时，默认优先启用 `'system'` 自动跟随宿主主题（忽略旧的独立访问 `localStorage` 缓存，除非URL显式指定或用户在当前会话手动点击切换）。

---

## 2. 核心架构与纯函数接口设计 (`frontend/src/theme/ThemeContext.tsx`)

### 2.1 类型定义
```ts
export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeContextType {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}
```

### 2.2 纯辅助函数（导出供单元测试直接验证）
1. **`parseThemeToken(raw: unknown): ThemeMode | null`**
   - 规范化字符串输入：
     - `'dark'` / `'night'` / `'true'` -> `'dark'`
     - `'light'` / `'day'` / `'false'` -> `'light'`
     - `'auto'` / `'system'` -> `'system'`
     - 其他返回 `null`。
2. **`parseThemeFromUrl(searchOrHash?: string): ThemeMode | null`**
   - 解析 `window.location.search` 和 `window.location.hash` 中的 `theme` 或 `colorScheme` 或 `colorMode` 参数。
3. **`parseThemeFromMessage(data: unknown): ThemeMode | null`**
   - 支持字符串消息（如 `'theme:dark'`、`'theme:light'`）或 JSON 字符串 / 对象：
     - 匹配 `{ type: 'theme-change' | 'set-theme' | 'gt-theme' | 'zashboard-theme' | 'theme', theme | mode | value | colorScheme }`
     - 或顶层直接包含 `{ theme: 'dark' | 'light' | 'auto' }`、`{ colorMode: 'dark' | 'light' }`、`{ colorScheme: 'dark' | 'light' }`、`{ isDark: boolean }`。
4. **`parseLuminanceTheme(cssColor: string | null | undefined): ResolvedTheme | null`**
   - 解析 `rgb(r, g, b)`、`rgba(r, g, b, a)`（当 `a > 0.1`）或 `#RRGGBB` / `#RGB`。
   - 计算相对亮度 `L = (0.299 * r + 0.587 * g + 0.114 * b) / 255`：`L < 0.5` 返回 `'dark'`，否则返回 `'light'`。
5. **`detectElementTheme(el: Element | null, computedStyle?: CSSStyleDeclaration | null): ResolvedTheme | null`**
   - 依次检查元素的：
     - `classList` 是否含 `'dark'` / `'light'`（以及 `'theme-dark'` / `'theme-light'`）
     - 属性 `data-theme`、`data-color-mode`、`data-color-scheme`、`data-bs-theme`、`theme`
     - `style.colorScheme` 或 `computedStyle.colorScheme`
     - `computedStyle.backgroundColor`（通过 `parseLuminanceTheme` 判断背景明暗）
6. **`detectParentDocumentTheme(win?: Window): ResolvedTheme | null`**
   - 当 `win.parent && win.parent !== win` 时，在 `try { ... } catch {}`（防跨域 SecurityError）中读取 `win.parent.document.documentElement` 和 `win.parent.document.body`，调用 `detectElementTheme` 返回宿主页面的实际主题。
7. **`resolveAutoTheme(win?: Window): ResolvedTheme`**
   - 综合探测当前环境的自动主题：
     1. 若 `parseThemeFromUrl` 返回明确的 `'dark'` 或 `'light'`，直接采用；
     2. 若 `detectParentDocumentTheme(win)` 返回 `'dark'` 或 `'light'`，直接采用；
     3. 否则读取 `win.matchMedia('(prefers-color-scheme: dark)').matches`（`true` -> `'dark'`, `false` -> `'light'`，若不支持则回退 `'dark'`）。

### 2.3 状态初始化与实时监听器
1. **初始 `theme` 模式决策 (`getInitialThemeMode`)**：
   - 若 URL 参数指定了 `?theme=dark|light|auto|system`，优先采用 URL 参数。
   - 若当前处于 `<iframe>` 嵌入环境（`window.self !== window.top`），默认返回 `'system'`（自动匹配宿主，不被过去独立访问时的 `localStorage` 锁定）。
   - 若为顶层独立窗口，读取 `localStorage.getItem('gemini_proxy_theme')`（支持 `'system' | 'dark' | 'light'`），无缓存时默认返回 `'system'`。
2. **四大实时监听器（在 `ThemeProvider` 的 `useEffect` 中挂载与清理）**：
   - `window.matchMedia('(prefers-color-scheme: dark)')` 的 `change` 事件监听（兼容旧版 `addListener`）。
   - 同源 `window.parent.document` 的 `MutationObserver`：监听 `documentElement` 与 `body` 的 `attributes: true`, `attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-color-scheme', 'data-bs-theme', 'theme']`。
   - `window.addEventListener('message', ...)`：收到合法的宿主主题 `postMessage` 时更新外部覆盖主题或切换模式。
   - `window.addEventListener('popstate' / 'hashchange')`：响应单页路由或 URL 查询参数变化。

---

## 3. UI 主题切换交互 (`LoginView.tsx` & `UnifiedTerminalView.tsx`)

- 保持各组件现有的快速切换体验，同时在 `UnifiedTerminalView.tsx` 和 `LoginView.tsx` 中支持一键切换，并在按钮 `title` 中清晰提示当前状态（如自动跟随 / 亮色 / 暗色），保留 `Sun` 和 `Moon` 图标引用以完全兼容现有单元测试断言。
