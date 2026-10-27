# File Manager Markdown & PDF Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable GFM Markdown rendered preview (with Preview/Edit toggle) and native browser PDF preview modal in `TerminalFileManagerView`.

**Architecture:** Extract pure, dependency-free GFM Markdown rendering and XSS sanitization into `frontend/src/utils/markdownRenderer.ts` so it is directly unit-testable in Jest (`node` environment) and consumed by a new `TerminalMarkdownViewer` component. Add `TerminalPdfPreviewModal` using an `application/pdf` Blob URL inside an `<iframe>` (with Open in New Tab, Maximize/Restore, and Download actions), and wire both into `TerminalFileManagerView`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React, Jest (`ts-jest`).

**Spec:** `docs/superpowers/specs/2026-10-27-file-manager-markdown-and-pdf-preview-design.md`

## Global Constraints

- Markdown files (`.md`, `.markdown`, case-insensitive) open in `'preview'` mode by default (`viewMode: 'preview'`) and provide a toolbar toggle between `'preview'` (`预览` / `Preview`) and `'edit'` (`编辑` / `Edit`).
- PDF files (`.pdf`, case-insensitive) open in `TerminalPdfPreviewModal` by fetching `/api/terminal/files/download` and wrapping the response in `new Blob([rawBlob], { type: 'application/pdf' })` before calling `URL.createObjectURL`.
- All rendered Markdown HTML must strip dangerous tags (`<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<form>`) and inline event handler attributes (`on*`) as well as unsafe link protocols (`javascript:`, `vbscript:`, `data:`).
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts` (`--detectOpenHandles --forceExit` enforced).

## Review Focus

- Malicious Markdown payloads (`<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `[click](javascript:alert(1))`) must have executable scripts, event handlers, and `javascript:` URLs stripped from the rendered HTML output.
- Fenced code blocks containing HTML special characters (`<div class="test">&</div>`) or quotes must be HTML-escaped inside `<pre><code>` and preserve raw text in `data-copy-code` (URI-encoded) so copying yields exact unescaped source code.
- GFM tables, task lists (`- [x] done`, `- [ ] todo`), blockquotes, inline code, headings, and links (`target="_blank" rel="noopener noreferrer"`) must render into valid semantic HTML elements.
- Rapidly opening or closing a PDF preview before the download finishes must guard against stale state updates via a request counter ref and always call `URL.revokeObjectURL` on cleanup.
- Editing a Markdown file in Monaco Editor and toggling back to `'preview'` mode must immediately render the unsaved in-memory `editorTarget.content`, and `Ctrl+S` must save in both `'preview'` and `'edit'` modes.

---

### Task 1: i18n Keys & GFM Markdown Renderer Utility

**Files:**
- Modify: `frontend/src/i18n/locales/en.ts:115-150`
- Modify: `frontend/src/i18n/locales/zh.ts:117-152`
- Create: `frontend/src/utils/markdownRenderer.ts`
- Test: `tests/markdownRenderer.test.ts`

**Interfaces:**
- Produces:
  - `isMarkdownExtension(ext: string): boolean` — returns `true` for `'md'` or `'markdown'` (case-insensitive, leading dot optional).
  - `isPdfExtension(ext: string): boolean` — returns `true` for `'pdf'` (case-insensitive, leading dot optional).
  - `sanitizeMarkdownHtml(html: string): string` — strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<form>`, `on*` event attributes, and `javascript:`/`vbscript:`/`data:` URLs in `href`/`src`.
  - `renderMarkdownToHtml(markdown: string, labels?: { copyCode?: string }): string` — converts GFM Markdown string to sanitized HTML string; fenced code blocks include a header bar with language label and `<button type="button" data-copy-code="${encodeURIComponent(rawCode)}">`.
  - `en.files` and `zh.files` keys: `previewMode`, `editMode`, `openInNewTab`, `emptyMarkdown`, `copyCode`, `codeCopied`, `retry`, `maximize`, `restore`.

- [x] **Step 1: Write the failing test in `tests/markdownRenderer.test.ts`**

```typescript
import {
  isMarkdownExtension,
  isPdfExtension,
  renderMarkdownToHtml,
  sanitizeMarkdownHtml,
} from '../frontend/src/utils/markdownRenderer';
import { en } from '../frontend/src/i18n/locales/en';
import { zh } from '../frontend/src/i18n/locales/zh';

describe('Markdown Renderer & File Type Helpers', () => {
  test('i18n locales contain markdown and pdf preview keys in both zh and en', () => {
    const requiredKeys = [
      'previewMode',
      'editMode',
      'openInNewTab',
      'emptyMarkdown',
      'copyCode',
      'codeCopied',
      'retry',
      'maximize',
      'restore',
    ] as const;

    for (const key of requiredKeys) {
      expect(zh.files[key]).toBeTruthy();
      expect(en.files[key]).toBeTruthy();
    }
    expect(zh.files.previewMode).toBe('预览');
    expect(zh.files.editMode).toBe('编辑');
    expect(en.files.previewMode).toBe('Preview');
    expect(en.files.editMode).toBe('Edit');
  });

  test('isMarkdownExtension and isPdfExtension identify extensions case-insensitively', () => {
    expect(isMarkdownExtension('md')).toBe(true);
    expect(isMarkdownExtension('MD')).toBe(true);
    expect(isMarkdownExtension('.markdown')).toBe(true);
    expect(isMarkdownExtension('txt')).toBe(false);

    expect(isPdfExtension('pdf')).toBe(true);
    expect(isPdfExtension('PDF')).toBe(true);
    expect(isPdfExtension('.pdf')).toBe(true);
    expect(isPdfExtension('png')).toBe(false);
  });

  test('renders GFM headings, tables, task lists, blockquotes, and external links', () => {
    const md = [
      '# Title 1',
      '## Title 2',
      '',
      '> A quote line',
      '',
      '- [x] Completed task',
      '- [ ] Pending task',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| CPU | 80% |',
      '',
      'Visit [Example](https://example.com) and `inline_code`.',
    ].join('\n');

    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<h1');
    expect(html).toContain('Title 1</h1>');
    expect(html).toContain('<h2');
    expect(html).toContain('<blockquote');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('CPU</td>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code');
    expect(html).toContain('inline_code</code>');
  });

  test('renders fenced code blocks with escaped HTML and URI-encoded data-copy-code attribute', () => {
    const rawCode = 'const a = "<div class=\\"x\\">&</div>";';
    const md = '```ts\n' + rawCode + '\n```';
    const html = renderMarkdownToHtml(md, { copyCode: 'Copy code' });

    expect(html).toContain('ts');
    expect(html).toContain('&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
    expect(html).toContain(`data-copy-code="${encodeURIComponent(rawCode)}"`);
  });

  test('strips XSS vectors: script tags, onerror attributes, and javascript: links', () => {
    const malicious = [
      '# Safe Heading',
      '<script>window.hacked = true;</script>',
      '<img src="x" onerror="alert(1)" />',
      '[Evil Link](javascript:alert(document.cookie))',
      '<a href="JAVASCRIPT:alert(2)" onclick="steal()">Click</a>',
    ].join('\n');

    const html = renderMarkdownToHtml(malicious);
    expect(html).toContain('Safe Heading');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('window.hacked');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('sanitizeMarkdownHtml removes iframe, object, embed, and style tags directly', () => {
    const dirty = '<div><iframe src="https://evil.com"></iframe><style>body{display:none}</style><p>Keep me</p></div>';
    const clean = sanitizeMarkdownHtml(dirty);
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<style');
    expect(clean).toContain('<p>Keep me</p>');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/markdownRenderer.test.ts`
Expected: FAIL with `Cannot find module '../frontend/src/utils/markdownRenderer'`

- [x] **Step 3: Add i18n keys to `frontend/src/i18n/locales/en.ts` and `frontend/src/i18n/locales/zh.ts`, and implement `frontend/src/utils/markdownRenderer.ts`**

In `frontend/src/i18n/locales/en.ts` under `files`:
```typescript
    previewMode: "Preview",
    editMode: "Edit",
    openInNewTab: "Open in New Tab",
    emptyMarkdown: "Document is empty. Click 'Edit' above to start writing.",
    copyCode: "Copy code",
    codeCopied: "Copied",
    retry: "Retry",
    maximize: "Maximize",
    restore: "Restore"
```

In `frontend/src/i18n/locales/zh.ts` under `files`:
```typescript
    previewMode: "预览",
    editMode: "编辑",
    openInNewTab: "新窗口打开",
    emptyMarkdown: "文档内容为空，点击右上角「编辑」开始编写",
    copyCode: "复制代码",
    codeCopied: "已复制",
    retry: "重试",
    maximize: "最大化",
    restore: "还原"
```

In `frontend/src/utils/markdownRenderer.ts`, implement:
- `isMarkdownExtension(ext: string): boolean` and `isPdfExtension(ext: string): boolean`
- `escapeHtml(text: string): string`
- `sanitizeUrl(url: string): string` (blocks `javascript:`, `vbscript:`, `data:` except safe image data URLs if needed; returns `'#'` when unsafe)
- `sanitizeMarkdownHtml(html: string): string` (strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<form>` blocks, strips `on[a-z]+\s*=` attributes, and neutralizes `javascript:`/`vbscript:`/`data:` in `href`/`src`)
- `renderMarkdownToHtml(markdown: string, labels?: { copyCode?: string }): string` supporting GFM fenced code blocks (` ```lang ... ``` ` with `data-copy-code="${encodeURIComponent(rawCode)}"`), ATX headings (`#`–`######`), GFM tables (`| col |`), blockquotes (`>`), unordered/ordered lists and task list checkboxes (`- [x]`, `- [ ]`), horizontal rules (`---`, `***`), images (`![alt](src)`), links (`[text](url)` with `target="_blank" rel="noopener noreferrer"`), bold/italic/strikethrough, and inline code (`` `code` ``), followed by `sanitizeMarkdownHtml`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/markdownRenderer.test.ts`
Expected: PASS (all tests in `tests/markdownRenderer.test.ts` green)

- [x] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales/en.ts frontend/src/i18n/locales/zh.ts frontend/src/utils/markdownRenderer.ts tests/markdownRenderer.test.ts
git commit -m "feat(frontend): add GFM markdown renderer utility with XSS sanitization and i18n keys"
```

---

### Task 2: `TerminalMarkdownViewer` and `TerminalPdfPreviewModal` Components

**Files:**
- Create: `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`
- Create: `frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalFileManagerView.tsx`
- Test: `tests/fileManagerMarkdownAndPdf.test.ts`

**Interfaces:**
- Consumes (from Task 1):
  - `isMarkdownExtension`, `isPdfExtension`, `renderMarkdownToHtml` from `../../utils/markdownRenderer`
  - `zh.files` / `en.files` translation keys via `useTranslation()`
- Produces:
  - `TerminalMarkdownViewer({ content, onRequestEdit }: TerminalMarkdownViewerProps)` in `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`
  - `TerminalPdfPreviewModal({ file, blobUrl, loading, error, onClose, onDownload, onRetry }: TerminalPdfPreviewModalProps)` in `frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`
  - Updated `TerminalFileManagerView` supporting:
    - `pdfPreviewTarget` state & `handleOpenPdf(file)` using `new Blob([rawBlob], { type: 'application/pdf' })` + `URL.createObjectURL` + cleanup on close/unmount
    - `editorTarget.viewMode: 'preview' | 'edit'` defaulting to `'preview'` when `isMarkdownExtension(file.extension)` is true
    - Header segmented toggle button (`预览` / `编辑`) for Markdown files in the editor modal

- [x] **Step 1: Write the failing test in `tests/fileManagerMarkdownAndPdf.test.ts`**

```typescript
import fs from 'fs';
import path from 'path';

describe('File Manager Markdown & PDF Preview Integration', () => {
  const fileManagerPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalFileManagerView.tsx'
  );
  const mdViewerPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalMarkdownViewer.tsx'
  );
  const pdfModalPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalPdfPreviewModal.tsx'
  );

  test('TerminalMarkdownViewer component exists and wires renderMarkdownToHtml and copy delegation', () => {
    expect(fs.existsSync(mdViewerPath)).toBe(true);
    const mdViewerCode = fs.readFileSync(mdViewerPath, 'utf-8');
    expect(mdViewerCode).toContain('renderMarkdownToHtml');
    expect(mdViewerCode).toContain('data-copy-code');
    expect(mdViewerCode).toContain('navigator.clipboard.writeText');
    expect(mdViewerCode).toContain('dangerouslySetInnerHTML');
  });

  test('TerminalPdfPreviewModal component exists and renders iframe with new-tab, maximize, download, and close actions', () => {
    expect(fs.existsSync(pdfModalPath)).toBe(true);
    const pdfModalCode = fs.readFileSync(pdfModalPath, 'utf-8');
    expect(pdfModalCode).toContain('<iframe');
    expect(pdfModalCode).toContain('window.open(blobUrl');
    expect(pdfModalCode).toContain("t('files.openInNewTab'");
    expect(pdfModalCode).toContain('onDownload(file)');
    expect(pdfModalCode).toContain('Escape');
  });

  test('TerminalFileManagerView routes PDF files to TerminalPdfPreviewModal with application/pdf Blob and revokes object URLs', () => {
    const fmCode = fs.readFileSync(fileManagerPath, 'utf-8');
    expect(fmCode).toContain('isPdfExtension');
    expect(fmCode).toContain('TerminalPdfPreviewModal');
    expect(fmCode).toContain("type: 'application/pdf'");
    expect(fmCode).toContain('URL.createObjectURL');
    expect(fmCode).toContain('URL.revokeObjectURL');
  });

  test('TerminalFileManagerView opens Markdown files in preview mode by default and provides preview/edit toggle', () => {
    const fmCode = fs.readFileSync(fileManagerPath, 'utf-8');
    expect(fmCode).toContain('isMarkdownExtension');
    expect(fmCode).toContain('TerminalMarkdownViewer');
    expect(fmCode).toContain("viewMode: isMarkdown ? 'preview' : 'edit'");
    expect(fmCode).toContain("t('files.previewMode'");
    expect(fmCode).toContain("t('files.editMode'");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fileManagerMarkdownAndPdf.test.ts`
Expected: FAIL because `TerminalMarkdownViewer.tsx` and `TerminalPdfPreviewModal.tsx` do not exist yet.

- [x] **Step 3: Implement `TerminalMarkdownViewer.tsx`, `TerminalPdfPreviewModal.tsx`, and wire them into `TerminalFileManagerView.tsx`**

1. Create `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`:
   - Props: `export interface TerminalMarkdownViewerProps { content: string; onRequestEdit?: () => void; }`
   - If `!content.trim()`, render an empty state card with `FileText` icon, `t('files.emptyMarkdown', '文档内容为空，点击右上角「编辑」开始编写')`, and a button triggering `onRequestEdit` if provided.
   - Memoize `html = useMemo(() => renderMarkdownToHtml(content, { copyCode: t('files.copyCode', '复制代码') }), [content, t])`.
   - Handle click events on container via event delegation: `const btn = (e.target as HTMLElement).closest('[data-copy-code]') as HTMLElement | null;`. Decode `btn.getAttribute('data-copy-code')` via `decodeURIComponent`, copy with `navigator.clipboard.writeText(code)`, and temporarily update the button text to `t('files.codeCopied', '已复制')` for 2000ms.
   - Style the markdown container (`overflow-y-auto h-full p-4 sm:p-6 select-text`) with typography classes for headings, tables, blockquotes, lists, inline code, and code blocks matching dark/light theme variables.

2. Create `frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`:
   - Props:
     ```typescript
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
   - Keyboard listener for `Escape` to invoke `onClose()`.
   - Header bar with PDF icon (`FileText className="w-4 h-4 text-rose-400 shrink-0"`), file name, formatted size, and action buttons:
     - Open in New Tab (`window.open(blobUrl, '_blank', 'noopener,noreferrer')`, disabled when `!blobUrl`, label `t('files.openInNewTab', '新窗口打开')`)
     - Maximize / Restore toggle (`isMaximized` state)
     - Download (`onDownload(file)`)
     - Close (`onClose`)
   - Body area:
     - `loading`: spinner + `t('files.loading', '加载中...')`
     - `error`: error message + Retry button (`onRetry`) + Download button (`onDownload(file)`)
     - `blobUrl`: `<iframe src={blobUrl} title={file.name} className="w-full h-full border-0 bg-white" />`

3. Update `frontend/src/components/terminal/TerminalFileManagerView.tsx`:
   - Import `isMarkdownExtension` and `isPdfExtension` from `../../utils/markdownRenderer`, `TerminalMarkdownViewer` from `./TerminalMarkdownViewer`, and `TerminalPdfPreviewModal` from `./TerminalPdfPreviewModal`.
   - Extend `editorTarget` state type with `viewMode: 'preview' | 'edit'`.
   - Add `pdfPreviewTarget` state (`{ file: TerminalFileItem; blobUrl: string | null; loading: boolean; error?: string | null } | null`) and `pdfRequestIdRef = useRef(0)` to prevent race conditions and revoke stale blob URLs.
   - In `renderItemIcon(item)`: return `<FileText className="w-4 h-4 text-rose-400 shrink-0" />` when `isPdfExtension(ext)` is true.
   - In `handleOpenFile(file)`:
     - If `isPdfExtension(ext)` is true, invoke `handleOpenPdf(file)` which fetches `/api/terminal/files/download?hostId=...&path=...`, wraps response in `new Blob([rawBlob], { type: 'application/pdf' })`, creates object URL via `URL.createObjectURL(pdfBlob)`, and stores it in `pdfPreviewTarget`.
     - Otherwise, compute `const isMarkdown = isMarkdownExtension(ext);` and initialize `editorTarget` with `viewMode: isMarkdown ? 'preview' : 'edit'`.
   - In Editor modal header: when `isMarkdownExtension(editorTarget.file.extension) && !editorTarget.isBinary`, render the segmented toggle button switching `editorTarget.viewMode` between `'preview'` (`t('files.previewMode', '预览')`) and `'edit'` (`t('files.editMode', '编辑')`).
   - In Editor modal body: when `editorTarget.viewMode === 'preview' && isMarkdownExtension(editorTarget.file.extension)`, render `<TerminalMarkdownViewer content={editorTarget.content} onRequestEdit={() => setEditorTarget(prev => prev ? { ...prev, viewMode: 'edit' } : null)} />`; otherwise render `<Editor ... />`.
   - Render `<TerminalPdfPreviewModal ... />` when `pdfPreviewTarget` is non-null, revoking `pdfPreviewTarget.blobUrl` on close and unmount.

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/fileManagerMarkdownAndPdf.test.ts && npm run build:frontend`
Expected: PASS on all Jest tests and `tsc --noEmit && vite build` succeeds with zero errors.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalMarkdownViewer.tsx frontend/src/components/terminal/TerminalPdfPreviewModal.tsx frontend/src/components/terminal/TerminalFileManagerView.tsx tests/fileManagerMarkdownAndPdf.test.ts
git commit -m "feat(files): support Markdown GFM preview/edit toggle and PDF preview modal"
```
