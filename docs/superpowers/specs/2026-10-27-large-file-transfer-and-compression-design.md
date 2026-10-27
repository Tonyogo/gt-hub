# 大文件加载与下载全链路加速及压缩优化设计文档

- **日期**：2026-10-27
- **状态**：已确认

## 1. 背景与痛点分析

在通过 Cloudflare Tunnel（`cloudflared`）转发 `gt-hub` 流量的生产环境中，打开和下载远程节点上的大文件（如大体积 PDF、日志、代码/Markdown、图片等）速度较慢，核心瓶颈定位如下：

1. **串行停等分块传输（Stop-and-Wait Bottleneck）**：
   - `TerminalFileService.createAgentChunkedStream` 目前使用 `512KB` 分块，且每次 `read()` 只发起 **1 个** `download_chunk` RPC 请求，必须等前一个分块在 `Hub <-> Agent` 之间完整往返后才发下一个。在跨网/隧道环境下，大量时间消耗在空等 RTT 上，带宽利用率极低。
2. **源站缺乏 HTTP 压缩 & Cloudflare 内容类型白名单限制**：
   - Express 服务端（`src/server/app.ts`）未启用 HTTP 响应压缩中间件。
   - Cloudflare 边缘节点仅对部分白名单 MIME 类型自动压缩，且对带有 `Content-Disposition: attachment` 或 `application/pdf` / `application/octet-stream` 的下载流默认透传不压缩。
3. **Agent <-> Hub RPC 传输未启用应用层压缩**：
   - `fileRpcHandler.ts` 在 `read`（最大 5MB 文本）和 `download_chunk` 时直接发送原始文本或未压缩的 Base64 字符串（体积膨胀 33%）。
4. **PDF 预览前端阻塞在全量 `await res.blob()`**：
   - 打开 PDF 时，前端通过 `fetch` + `await res.blob()` 必须等待整个 PDF 文件 100% 下载进浏览器内存后才渲染第一页，无法利用浏览器原生 PDF 阅读器的流式加载与 HTTP Range 分片能力。

---

## 2. 优化目标与核心方案

### 2.1 滑动窗口并发预取流（2MB 分块 + 3 并发 Read-Ahead Pipeline）
- **位置**：`src/terminal/services/terminalFileService.ts`
- **设计**：
  - 将默认分块阈值与大小提升至 `DEFAULT_DOWNLOAD_CHUNK_SIZE = 1024 * 1024`（1MB，兼顾单帧内存与吞吐）并支持 `MAX_PREFETCH_CONCURRENCY = 4`（同时在途预取 4 个分块，即 4MB 滑动窗口）。
  - 在 `createAgentChunkedStream` 中维护滑动窗口队列：当流启动或消费完一个分块时，自动并发派发后续分块的 `download_chunk` RPC 请求，按序 push 给下游 HTTP 响应流。
  - 一旦客户端断开连接（`destroy`），立即停止后续分块派发并清空缓存队列。

### 2.2 Agent <-> Hub 文件 RPC 智能 Gzip 压缩（向后兼容）
- **位置**：`src/agent/handlers/fileRpcHandler.ts` & `src/terminal/services/terminalFileService.ts`
- **设计**：
  - **下载分块 (`download_chunk`)**：
    - 当 Hub 请求 `params.acceptEncoding === 'gzip'` 且分块大小 `>= 4096` 字节、且文件扩展名不属于已高压缩格式（如 `.zip`, `.gz`, `.7z`, `.rar`, `.bz2`, `.xz`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.mp4`）时，Agent 使用 Node.js 原生 `zlib.gzipSync(chunk, { level: zlib.constants.Z_BEST_SPEED })`（level 1 极速压缩）。
    - 若压缩后字节数小于原始字节数的 95%，返回 `{ data: gzBuf.toString('base64'), encoding: 'gzip', size: stat.size, offset, length: bytesRead }`；否则直接返回原始 Base64（避免不可压缩数据浪费 CPU）。
    - Hub 端 `terminalFileService` 检测到 `res.data.encoding === 'gzip'` 时，使用 `zlib.gunzipSync` 自动还原原始 `Buffer`。旧版 Agent 忽略 `acceptEncoding` 返回未压缩数据时，Hub 完全向后兼容。
  - **文本读取 (`read`)**：
    - 当 `params.acceptEncoding === 'gzip'` 且文本字节数 `>= 4096` 时，Agent 将 UTF-8 Buffer 进行 `gzipSync` 后以 `contentEncoding: 'gzip'` + Base64 返回，Hub 端解压还原为 UTF-8 字符串。

### 2.3 源站 HTTP 响应流压缩与 `?compress=1` / `?inline=1` 支持
- **位置**：`src/server/middlewares/compressionMiddleware.ts`、`src/server/app.ts`、`src/terminal/controllers/terminalFileController.ts`
- **设计**：
  1. **通用 API JSON/文本响应压缩中间件（`compressionMiddleware.ts`）**：
     - 基于 Node.js 内置 `zlib`（零第三方 npm 依赖），当客户端 `Accept-Encoding` 包含 `gzip` 且响应为 JSON/文本（如 `/api/terminal/files/content`、`/api/terminal/files/list`）且体积 `>= 1024` 字节时，自动使用 `zlib.gzipSync` 压缩并设置 `Content-Encoding: gzip` 与 `Vary: Accept-Encoding`。
  2. **大文件下载流压缩与内联预览（`terminalFileController.ts`）**：
     - **内联预览支持（`?inline=1`）**：当 query 包含 `inline=1` 或 `inline=true` 时，设置 `Content-Disposition: inline; filename="..."`，否则保持 `attachment`。
     - **流式 Gzip 压缩传输**：
       - 当请求**无 `Range` 头**（全量下载或开启 `?compress=1`）、客户端 `Accept-Encoding` 包含 `gzip`，且目标文件为可压缩类型（文本、日志、代码、JSON、XML、CSV、SQL、Markdown、PDF、SVG、TAR 等，或显式传入 `compress=1`）时：
       - 移除固定的未压缩 `Content-Length`，设置 `Content-Encoding: gzip`、`Vary: Accept-Encoding`，通过 `stream.pipe(zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })).pipe(res)` 进行边拉边压边发！
       - 这样即使经过 Cloudflare Tunnel，Cloudflare 也会直接透传源站已压缩的 `gzip` 流，浏览器收到后原生透明解压。
       - 当请求带有 `Range` 头（如 `gt cp` 断点续传或浏览器 PDF 分片拉取）且未强制 `compress=1` 时，保持原有的精确字节 Range 响应（`206 Partial Content` + 原始字节流），确保 RFC 9110 兼容性与现有测试 100% 通过。

### 2.4 PDF 直连流式预览与可复用预览 Ticket
- **位置**：`src/server/modules/auth/ticketManager.ts`、`src/server/modules/auth/authController.ts`、`frontend/src/utils/apiClient.ts`、`frontend/src/components/terminal/TerminalFileManagerView.tsx`
- **设计**：
  - **痛点**：浏览器内置 PDF 阅读器在加载 `<iframe src="/api/terminal/files/download?inline=1&ticket=...">` 时，可能会发起**多次 HTTP 请求**（1 次主请求 + 多次 `Range: bytes=...` 分片请求，或点击“新窗口打开”）。而现有的 `ticketManager.consumeTicket()` 是严格单次销毁的，第 2 个 Range 请求就会返回 `401 Unauthorized`！
  - **解决方案**：
    - 在 `TicketManager.createTicket(metadata, ttlMs, reusable?: boolean)` 中支持短期可复用窗口（当 `reusable: true` 或在有效期内允许同一 ticket 在 TTL 如 60 秒内被多次消费，用于流式媒体/PDF Range 预览）。
    - 前端 `handleOpenPdf` 获取 ticket 后，直接构造流式预览 URL：`/api/terminal/files/download?hostId=...&path=...&inline=1&ticket=...` 传给 `TerminalPdfPreviewModal` 的 `<iframe>`！
    - **效果**：打开任意大小的 PDF 无需等待 `await res.blob()` 全量下载，弹窗 **0 秒立即显示**，由浏览器原生 PDF 引擎通过流式/Range 分片秒开第一页！

---

## 3. 测试与验证计划

1. **单元测试与集成测试（`tests/fileTransferOptimization.test.ts`）**：
   - 验证 `TerminalFileService` 的并发预取滑动窗口（多个 `download_chunk` 并发发出且按序组装无乱序）。
   - 验证 `fileRpcHandler` 的 `download_chunk` 与 `read` 在 `acceptEncoding: 'gzip'` 下的压缩与解压一致性。
   - 验证 `/api/terminal/files/content` 与 `/api/terminal/files/download` 在 `Accept-Encoding: gzip` 下的 `Content-Encoding: gzip` 压缩响应，以及 `?inline=1` 的 `Content-Disposition: inline` 响应头。
   - 验证 `ticketManager` 支持预览场景下的多 Range 请求窗口复用。
   - 验证前端 `TerminalFileManagerView` 使用直连流式 URL 秒开 PDF。
2. **回归测试**：
   - 运行 `tests/terminalFileRangeDownload.test.ts`、`tests/terminalAgentFileSlice.test.ts`、`tests/fileManagerMarkdownAndPdf.test.ts`，确保所有既有测试 100% 通过。
