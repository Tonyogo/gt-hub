# 文件管理器支持 Markdown 与 PDF 文件显示设计文档

- **日期**：2026-10-27
- **状态**：待评审

## 1. 背景与目标

在 `gt-hub` 的远程文件管理器（`TerminalFileManagerView`）中，当前双击或点击「查看 / 编辑」文件时的处理逻辑如下：
1. **图片文件（`png`, `jpg`, `svg`, `webp` 等）**：通过 `/api/terminal/files/download` 拉取二进制 Blob 并在 `TerminalImagePreviewModal` 中预览。
2. **Markdown 文件（`.md`, `.markdown`）**：直接进入 Monaco Editor 代码编辑器展示原始 Markdown 源码，无法直接阅读排版后的富文本文档。
3. **PDF 文件（`.pdf`）**：调用 `/api/terminal/files/content` 读取文本内容，由于后端判定 `isBinary: true`，前端统一回退到“此文件为二进制格式，暂不支持在线预览”提示界面，必须下载到本地才能查看。

**本次设计目标**：
- **Markdown 文件（`.md` / `.markdown`）**：点击打开时默认进入**渲染预览视图**（支持标准 GFM 语法、表格、任务列表、代码块及一键复制、XSS 安全过滤）；弹窗顶部提供**「预览 / 编辑」**切换按钮，切换到「编辑」模式可使用原有的 Monaco Editor 编辑源码并保存（`Ctrl+S`），切换回「预览」即时查看最新修改后的排版效果。
- **PDF 文件（`.pdf`）**：点击打开时进入专属 **PDF 预览弹窗（`TerminalPdfPreviewModal`）**，通过 `/api/terminal/files/download` 获取二进制流并构造 `application/pdf` Blob URL，利用浏览器原生 `<iframe>` 渲染 PDF（支持目录、页码跳转、搜索、缩放、打印），同时在顶部工具栏提供**新标签页打开**（兼顾移动端浏览器兼容兜底）、**全屏/还原**及**直接下载**功能。

---

## 2. 技术选型

### 2.1 Markdown 解析与安全清洗
- 采用 **`marked` + `dompurify`**：
  - `marked`：轻量级、高性能 GFM（GitHub Flavored Markdown）解析器，支持通过自定义 `Renderer` 为代码块注入语言标题栏与复制按钮、为外部链接附加安全属性（`target="_blank" rel="noopener noreferrer"`）。
  - `dompurify`：对生成的 HTML 进行严格 XSS 过滤（仓库 `frontend/package.json` 的 `overrides` 中已声明 `dompurify` 版本约束），防止恶意 Markdown 文件中内嵌 `<script>`、`onerror`、`javascript:` 链接等攻击向量。

### 2.2 PDF 预览方案
- 采用 **浏览器原生 PDF 预览器（`Blob URL` + `<iframe>`）**：
  - 零第三方大体积渲染引擎依赖（无需打包 1.5MB+ 的 `pdfjs-dist` worker）。
  - 将下载接口返回的二进制数据显式包装为 `new Blob([blob], { type: 'application/pdf' })`，避免因响应头 `Content-Disposition: attachment` 触发浏览器直接下载，确保 `<iframe>` 内稳定调用浏览器原生 PDF 阅读器。
  - 提供「在新窗口打开」按钮，解决部分移动端 WebView 内置 `<iframe>` 不直接渲染 PDF 的兼容问题。

---

## 3. 架构与组件设计

### 3.1 新增组件：`frontend/src/components/terminal/TerminalMarkdownViewer.tsx`
- **Props 定义**：
  ```ts
  export interface TerminalMarkdownViewerProps {
    content: string;
    onRequestEdit?: () => void;
  }
  ```
- **核心职责**：
  1. 使用 `marked`（开启 `gfm: true, breaks: true`）解析 `content`。
  2. 自定义 `marked.Renderer`：
     - **代码块（`code`）**：渲染带顶部栏的代码容器，左侧显示语言名称（如 `bash`, `typescript`, `json` 等，未指定时显示 `text`），右侧提供带有 `data-copy-code` 属性的复制按钮，主体使用 `<pre><code>` 展示转义后的代码内容。
     - **链接（`link`）**：仅允许 `http:`, `https:`, `mailto:`, `#` 锚点或相对路径，过滤 `javascript:` / `vbscript:` / `data:` 危险协议；外链统一添加 `target="_blank" rel="noopener noreferrer"`。
  3. 使用 `DOMPurify.sanitize(rawHtml, { ... })` 进行安全净化，显式允许 GFM 任务列表 `<input type="checkbox" disabled checked>` 以及代码块复制按钮所需的 `data-copy-code` 属性。
  4. **事件委托复制交互**：在根容器的 `onClick` 中监听 `[data-copy-code]` 按钮点击，读取对应代码块文本写入 `navigator.clipboard.writeText`，并在按钮上给予 2 秒的复制成功状态反馈。
  5. **主题与排版样式**：支持亮色/暗色主题自适应（基于 CSS 变量 `var(--bg-surface)`、`var(--border-subtle)`、`var(--text-primary)` 等），完整覆盖标题层级（`h1`~`h6`）、表格边框与斑马纹、引用块（`blockquote`）、任务列表、行内代码、水平分割线及图片自适应宽度。
  6. **空内容状态**：当 `content.trim()` 为空时，展示友好的空文档提示，并可点击切换至编辑模式。

### 3.2 新增组件：`frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`
- **Props 定义**：
  ```ts
  export interface TerminalPdfPreviewModalProps {
    file: TerminalFileItem;
    blobUrl: string | null;
    loading: boolean;
    error?: string | null;
    onClose: () => void;
    onDownload: (file: TerminalFileItem) => void;
    onRetry?: () => void;
  }
  ```
- **核心职责**：
  1. **顶部工具栏**：
     - 左侧：PDF 专属图标（玫瑰红/琥珀色 `FileText`）、文件名、文件大小徽章。
     - 右侧操作按钮：
       - 「新窗口打开」（`ExternalLink` 图标）：当 `blobUrl` 就绪时调用 `window.open(blobUrl, '_blank', 'noopener,noreferrer')`。
       - 「最大化 / 还原」（`Maximize2` / `Minimize2` 图标）：切换弹窗全屏铺满与常规模态框尺寸（`max-w-6xl h-[90vh]`）。
       - 「下载」（`Download` 图标）：调用 `onDownload(file)`。
       - 「关闭」（`X` 图标，支持 `Esc` 快捷键与点击遮罩关闭）。
  2. **主体内容区**：
     - `loading === true`：居中显示加载动画与「正在加载 PDF...」提示。
     - `error` 非空：显示错误原因、「重试」按钮及「直接下载」按钮。
     - `blobUrl` 就绪：渲染 `<iframe src={blobUrl} title={file.name} className="w-full h-full border-0 bg-white" />`。

### 3.3 修改组件：`frontend/src/components/terminal/TerminalFileManagerView.tsx`
1. **扩展名常量与辅助函数**：
   - 新增 `MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])`。
   - 新增 `PDF_EXTENSIONS = new Set(['pdf'])`。
   - `renderItemIcon(item)` 中：为 `pdf` 文件展示专属颜色的图标（如 `text-rose-400`），为 `md` / `markdown` 文件展示醒目的文档图标（`text-sky-400`）。
2. **`handleOpenFile` 分流逻辑**：
   - 若 `IMAGE_EXTENSIONS.has(ext)`：走原有图片预览流程。
   - 若 `PDF_EXTENSIONS.has(ext)`：
     - 先释放上一次可能残留的 `pdfPreviewTarget.blobUrl`。
     - 设置 `pdfPreviewTarget({ file, blobUrl: null, loading: true, error: null })` 立即打开弹窗显示加载态。
     - 请求 `/api/terminal/files/download?hostId=...&path=...`，成功后构造 `new Blob([rawBlob], { type: 'application/pdf' })` 并生成 `URL.createObjectURL(pdfBlob)` 更新到 `pdfPreviewTarget`。
     - 使用请求序号（requestId ref）防止快速切换文件或提前关闭弹窗时的竞态覆盖与 Blob URL 泄漏。
   - 其余文件：走 `editorTarget` 流程，在 `editorTarget` 状态中新增字段 `viewMode: 'preview' | 'edit'`：
     - 当 `MARKDOWN_EXTENSIONS.has(ext)` 时，初始 `viewMode` 为 `'preview'`；
     - 其他文本/代码文件初始 `viewMode` 为 `'edit'`。
3. **编辑器/预览弹窗工具栏增强**：
   - 当打开的文件属于 `MARKDOWN_EXTENSIONS` 且 `!editorTarget.isBinary` 时，在弹窗头部显示「预览 / 编辑」分段切换控件：
     - `预览`（`Eye` 图标）：激活时渲染 `<TerminalMarkdownViewer content={editorTarget.content} onRequestEdit={() => ...} />`。
     - `编辑`（`FileCode` / `Edit2` 图标）：激活时渲染原有的 `<Editor ... />`。
   - 保存按钮（`Ctrl+S`）在 Markdown 的预览和编辑模式下均保持可用（方便编辑后切到预览确认效果再直接保存）。

### 3.4 国际化文案（`frontend/src/i18n/locales/zh.ts` & `en.ts`）
在 `files` 命名空间下补充以下字段：
- `previewMode`: `"预览"` / `"Preview"`
- `editMode`: `"编辑"` / `"Edit"`
- `openInNewTab`: `"新窗口打开"` / `"Open in New Tab"`
- `emptyMarkdown`: `"文档内容为空，点击右上角「编辑」开始编写"` / `"Document is empty. Click 'Edit' above to start writing."`
- `copyCode`: `"复制代码"` / `"Copy code"`
- `codeCopied`: `"已复制"` / `"Copied"`
- `retry`: `"重试"` / `"Retry"`
- `maximize`: `"最大化"` / `"Maximize"`
- `restore`: `"还原"` / `"Restore"`

---

## 4. 测试与验证计划

1. **单元测试（`tests/fileManagerMarkdownAndPdf.test.ts`）**：
   - 验证 Markdown 渲染逻辑与 XSS 安全净化（GFM 表格、任务列表、代码块语言与复制属性、过滤恶意 `<script>` 与 `javascript:` 链接）。
   - 验证 `TerminalFileManagerView` 对 `.md` / `.markdown` 默认进入预览模式且支持「预览 / 编辑」切换。
   - 验证 `TerminalFileManagerView` 对 `.pdf` 文件分流至 `TerminalPdfPreviewModal` 并使用 `application/pdf` Blob URL 及清理回收机制。
2. **构建与回归验证**：
   - 执行 `npm run build:frontend` 验证 TypeScript 类型检查与 Vite 打包通过。
   - 执行目标测试与相关回归测试，确保全部通过。
