# Large File Transfer Acceleration & Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate large file preview and download over Cloudflare Tunnel by implementing a 1MB 4-way concurrent read-ahead prefetch pipeline, Agent-to-Hub RPC gzip compression, origin HTTP gzip streaming compression, and zero-wait inline streaming PDF/image preview with reusable preview tickets.

**Architecture:**
1. Upgrade `handleFileRpc` (`read` and `download_chunk`) and `TerminalFileService` to negotiate `acceptEncoding: 'gzip'` (using `zlib.gzipSync` with `Z_BEST_SPEED` for compressible data >= 4KB) and replace the sequential 512KB stop-and-wait loop in `createAgentChunkedStream` with a 1MB chunk, 4-concurrent sliding-window prefetch pipeline.
2. Add an origin HTTP compression middleware (`src/server/middlewares/compressionMiddleware.ts`) and streaming gzip support + `?inline=1` in `TerminalFileController.downloadFile` so Cloudflare Tunnel forwards compressed payloads directly to the browser.
3. Support short-lived reusable preview tickets (`reusable: true` in `TicketManager` and `POST /api/auth/ticket?reusable=1`) and switch `TerminalFileManagerView`'s PDF preview from blocking `await res.blob()` to instant `<iframe src="/api/terminal/files/download?inline=1&ticket=...">` streaming.

**Tech Stack:** Node.js (`zlib`, `stream`), Express, TypeScript, React 18, Jest (`supertest`).

**Spec:** `docs/superpowers/specs/2026-10-27-large-file-transfer-and-compression-design.md`

## Global Constraints

- Zero new external npm dependencies: use Node.js built-in `zlib` (`gzipSync`, `gunzipSync`, `createGzip`, `constants.Z_BEST_SPEED`).
- Backward compatibility: `TicketManager.createTicket()` without `reusable: true` MUST remain strictly single-use (consumed and deleted on first `consumeTicket` call) so `tests/ticketManager.test.ts` passes unchanged.
- Backward compatibility: `download_chunk` without `params.acceptEncoding === 'gzip'` MUST return uncompressed base64 so `tests/terminalAgentFileSlice.test.ts` and `tests/terminalFileRangeDownload.test.ts` pass unchanged.
- HTTP Range requests (`Range: bytes=...`) to `/api/terminal/files/download` MUST NOT apply `Content-Encoding: gzip` unless `compress=1` is explicitly set, preserving exact byte offsets and `206 Partial Content` semantics.
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

- Concurrent prefetch chunks completing out-of-order (e.g., chunk 2 arrives before chunk 1) must be pushed to the readable stream strictly in ascending offset order (`chunk 0`, `chunk 1`, `chunk 2`).
- Incompressible or already-compressed data (or chunks where `gzipped.length >= raw.length`) must fall back to uncompressed base64 without setting `encoding: 'gzip'`.
- Premature stream closure (`stream.destroy()`) during a large file download must stop dispatching further prefetch chunks immediately.
- Reusable preview tickets (`createTicket({ reusable: true }, 60000)`) must allow multiple `consumeTicket` calls within their TTL window (supporting browser PDF viewer Range requests and "Open in New Tab") and reject calls once expired.
- PDF preview in `TerminalFileManagerView` must render the streaming URL (`/api/terminal/files/download?...&inline=1`) immediately without waiting for `res.blob()`.

---

### Task 1: Agent RPC Gzip Compression & Concurrent Read-Ahead Prefetch Stream

**Files:**
- Modify: `src/agent/handlers/fileRpcHandler.ts:107-125,212-258`
- Modify: `src/terminal/services/terminalFileService.ts:69-94,168-306`
- Test: `tests/fileRpcCompressionAndPrefetch.test.ts`

**Interfaces:**
- Produces:
  - In `src/agent/handlers/fileRpcHandler.ts`:
    - `isAlreadyCompressedExtension(filePath: string): boolean` — returns `true` for `.zip`, `.gz`, `.tgz`, `.7z`, `.rar`, `.bz2`, `.xz`, `.zst`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.mp4`, `.webm`, `.mp3`, `.woff2`.
    - `action === 'read'`: when `params?.acceptEncoding === 'gzip'` and `!isBinary` and `buf.length >= 4096`, compresses `buf` with `zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_SPEED })`; if `gz.length < buf.length`, returns `{ path: resolvedPath, size: stat.size, isBinary: false, content: gz.toString('base64'), encoding: 'gzip' }`.
    - `action === 'download_chunk'`: when `params?.acceptEncoding === 'gzip'` and `chunk.length >= 4096` and `!isAlreadyCompressedExtension(resolvedPath)`, compresses `chunk` with `zlib.gzipSync(chunk, { level: zlib.constants.Z_BEST_SPEED })`; if `gz.length < chunk.length`, returns `{ data: gz.toString('base64'), encoding: 'gzip', size: stat.size, offset, length: bytesRead }`.
  - In `src/terminal/services/terminalFileService.ts`:
    - `DEFAULT_DOWNLOAD_CHUNK_SIZE = 1024 * 1024` (1MB) and `DEFAULT_PREFETCH_CONCURRENCY = 4`.
    - `readFileContent` sends `{ acceptEncoding: 'gzip' }` in `params` and transparently decompresses with `zlib.gunzipSync(Buffer.from(res.data.content, 'base64')).toString('utf-8')` when `res.data.encoding === 'gzip'`.
    - `getFileStream` and `createAgentChunkedStream` send `acceptEncoding: 'gzip'`, transparently gunzip chunks when `encoding === 'gzip'`, and prefetch up to `DEFAULT_PREFETCH_CONCURRENCY` chunks concurrently while emitting buffers in strict offset order.

- [x] **Step 1: Write the failing test in `tests/fileRpcCompressionAndPrefetch.test.ts`**

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { handleFileRpc } from '../src/agent/handlers/fileRpcHandler';
import { TerminalFileService } from '../src/terminal/services/terminalFileService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Agent File RPC Gzip Compression & Concurrent Read-Ahead Prefetch', () => {
  const tmpDir = path.join(os.tmpdir(), `gt-compress-prefetch-${Date.now()}`);
  const largeTextFile = path.join(tmpDir, 'large.txt');
  const repeatedText = 'Hello Cloudflare Tunnel Compression Test Line!\n'.repeat(500); // ~23.5KB

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(largeTextFile, repeatedText, 'utf-8');
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function invokeAgentRpc(control: any): Promise<any> {
    return new Promise((resolve) => {
      const ws = {
        readyState: 1,
        send: (msg: string) => {
          if (msg.startsWith('JSON:')) {
            resolve(JSON.parse(msg.slice(5)));
          }
        },
      };
      handleFileRpc(control, ws);
    });
  }

  test('handleFileRpc read compresses large text when acceptEncoding is gzip', async () => {
    const res = await invokeAgentRpc({
      reqId: 'read-gz-1',
      action: 'read',
      path: largeTextFile,
      params: { acceptEncoding: 'gzip' },
    });

    expect(res.success).toBe(true);
    expect(res.data.encoding).toBe('gzip');
    const compressedBuf = Buffer.from(res.data.content, 'base64');
    expect(compressedBuf.length).toBeLessThan(Buffer.byteLength(repeatedText) / 3);
    const decompressed = zlib.gunzipSync(compressedBuf).toString('utf-8');
    expect(decompressed).toBe(repeatedText);
  });

  test('handleFileRpc download_chunk compresses compressible slice when acceptEncoding is gzip', async () => {
    const res = await invokeAgentRpc({
      reqId: 'dl-gz-1',
      action: 'download_chunk',
      path: largeTextFile,
      params: { offset: 0, length: 16384, acceptEncoding: 'gzip' },
    });

    expect(res.success).toBe(true);
    expect(res.data.encoding).toBe('gzip');
    expect(res.data.length).toBe(16384);
    const raw = zlib.gunzipSync(Buffer.from(res.data.data, 'base64')).toString('utf-8');
    expect(raw).toBe(repeatedText.slice(0, 16384));
  });

  test('TerminalFileService prefetches multiple chunks concurrently and reassembles out-of-order responses in exact order', async () => {
    const hostId = 'prefetch-test-node';
    const chunkSize = 1024 * 1024; // 1MB
    const totalSize = chunkSize * 4; // 4MB (4 chunks)
    let inFlight = 0;
    let maxConcurrentObserved = 0;

    const mockWs = {
      readyState: 1,
      send: jest.fn((msg: string) => {
        if (!msg.startsWith('JSON:')) return;
        const parsed = JSON.parse(msg.slice(5));
        const { reqId, action, params } = parsed;

        if (action === 'stat') {
          terminalHostManager.handleAgentRpcResponse({
            reqId,
            success: true,
            data: { size: totalSize, mtime: Date.now(), isDirectory: false },
          });
          return;
        }

        if (action === 'download_chunk') {
          inFlight++;
          if (inFlight > maxConcurrentObserved) {
            maxConcurrentObserved = inFlight;
          }
          const offset = Number(params.offset) || 0;
          const length = Number(params.length) || chunkSize;
          const chunkIndex = Math.floor(offset / chunkSize);
          const rawBuf = Buffer.alloc(length, 65 + chunkIndex); // 'A', 'B', 'C', 'D'
          const gzBuf = zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_SPEED });

          // Deliberately resolve later chunks faster than earlier chunks to test ordering
          const delayMs = (4 - chunkIndex) * 15;
          setTimeout(() => {
            inFlight--;
            terminalHostManager.handleAgentRpcResponse({
              reqId,
              success: true,
              data: {
                data: gzBuf.toString('base64'),
                encoding: 'gzip',
                size: totalSize,
                offset,
                length,
              },
            });
          }, delayMs);
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId,
      name: 'Prefetch-Agent',
      agentWs: mockWs,
    });

    try {
      const service = new TerminalFileService();
      const result = await service.getFileStream(hostId, '/remote/4mb.bin');
      expect(result.status).toBe(200);
      expect(result.stream).toBeDefined();

      const receivedChunks: Buffer[] = [];
      for await (const part of result.stream!) {
        receivedChunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      }

      const fullBuffer = Buffer.concat(receivedChunks);
      expect(fullBuffer.length).toBe(totalSize);
      // Verify concurrent requests were dispatched (> 1 in flight simultaneously)
      expect(maxConcurrentObserved).toBeGreaterThanOrEqual(2);
      // Verify strict ordering: 'A' (65), 'B' (66), 'C' (67), 'D' (68)
      expect(fullBuffer[0]).toBe(65);
      expect(fullBuffer[chunkSize]).toBe(66);
      expect(fullBuffer[chunkSize * 2]).toBe(67);
      expect(fullBuffer[chunkSize * 3]).toBe(68);
    } finally {
      terminalHostManager.unregisterAgent(hostId);
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fileRpcCompressionAndPrefetch.test.ts`
Expected: FAIL (`expect(res.data.encoding).toBe('gzip')` is `undefined`, and `maxConcurrentObserved` is `1`).

- [x] **Step 3: Implement RPC gzip compression in `src/agent/handlers/fileRpcHandler.ts` and concurrent prefetch in `src/terminal/services/terminalFileService.ts`**

1. In `src/agent/handlers/fileRpcHandler.ts`:
   - Import `zlib from 'zlib'`.
   - Define `COMPRESSED_EXTENSIONS = new Set(['zip', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'zst', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3', 'woff2'])` and `isAlreadyCompressedExtension(filePath: string): boolean`.
   - In `action === 'read'`: if `!isBinary && params?.acceptEncoding === 'gzip' && buf.length >= 4096`, compress with `zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_SPEED })`. If `gz.length < buf.length`, reply with `{ path: resolvedPath, size: stat.size, isBinary: false, content: gz.toString('base64'), encoding: 'gzip' }`.
   - In `action === 'download_chunk'`: when `params?.acceptEncoding === 'gzip' && chunk.length >= 4096 && !isAlreadyCompressedExtension(resolvedPath)`, compress with `zlib.gzipSync(chunk, { level: zlib.constants.Z_BEST_SPEED })`. If `gz.length < chunk.length`, include `encoding: 'gzip'` and `data: gz.toString('base64')` in the response payload (both unchunked and sliced branches).

2. In `src/terminal/services/terminalFileService.ts`:
   - Import `zlib from 'zlib'`.
   - Export constants `DEFAULT_DOWNLOAD_CHUNK_SIZE = 1024 * 1024` (1MB) and `DEFAULT_PREFETCH_CONCURRENCY = 4`.
   - Add helper `decodeAgentChunkBuffer(resData: any): Buffer` that decodes base64 and calls `zlib.gunzipSync` when `resData?.encoding === 'gzip'`.
   - In `readFileContent`: pass `{ acceptEncoding: 'gzip' }` to `this.rpcAgent(hostId, 'read', filePath, { acceptEncoding: 'gzip' })`. If `res.data.encoding === 'gzip'` and `res.data.content`, gunzip `Buffer.from(res.data.content, 'base64')` to UTF-8 string before returning.
   - In `getFileStream`: use `CHUNK_THRESHOLD = DEFAULT_DOWNLOAD_CHUNK_SIZE` (1MB). Pass `acceptEncoding: 'gzip'` in single-chunk `download_chunk` calls and decode via `decodeAgentChunkBuffer`.
   - In `createAgentChunkedStream`: implement a sliding-window prefetch queue (`chunkSize = DEFAULT_DOWNLOAD_CHUNK_SIZE`, `concurrency = DEFAULT_PREFETCH_CONCURRENCY`):
     - Split `[startOffset, endOffset]` into ordered chunk descriptors `{ index, offset, length }`.
     - Maintain `nextDispatchIndex`, `nextEmitIndex`, `inFlightCount`, and `completedBuffers: Map<number, Buffer>`.
     - `pump()` dispatches up to `concurrency` concurrent `download_chunk` RPCs (with `acceptEncoding: 'gzip'`) while `completedBuffers.size + inFlightCount <= concurrency`.
     - As each RPC resolves, decode via `decodeAgentChunkBuffer`, store in `completedBuffers`, and flush all consecutive ready buffers starting at `nextEmitIndex` via `this.push(buf)`.

- [x] **Step 4: Run tests to verify Task 1 and existing slice/range tests pass**

Run: `npm test -- tests/fileRpcCompressionAndPrefetch.test.ts tests/terminalAgentFileSlice.test.ts tests/terminalFileRangeDownload.test.ts`
Expected: PASS on all 3 test files.

- [x] **Step 5: Commit**

```bash
git add src/agent/handlers/fileRpcHandler.ts src/terminal/services/terminalFileService.ts tests/fileRpcCompressionAndPrefetch.test.ts
git commit -m "perf(files): add 1MB 4-way concurrent prefetch stream and RPC gzip compression"
```

---

### Task 2: Origin HTTP Gzip Compression, Inline Download Disposition & Reusable Preview Tickets

**Files:**
- Create: `src/server/middlewares/compressionMiddleware.ts`
- Modify: `src/server/app.ts:1-25`
- Modify: `src/terminal/controllers/terminalFileController.ts:359-464`
- Modify: `src/server/modules/auth/ticketManager.ts:1-60`
- Modify: `src/server/modules/auth/authController.ts:52-60`
- Modify: `frontend/src/utils/apiClient.ts:79-118`
- Modify: `frontend/src/components/terminal/TerminalFileManagerView.tsx:400-440`
- Test: `tests/httpCompressionAndInlinePreview.test.ts`

**Interfaces:**
- Consumes (from Task 1): `terminalFileService` streaming APIs.
- Produces:
  - `compressionMiddleware(req, res, next)` in `src/server/middlewares/compressionMiddleware.ts` — compresses JSON/text responses (`>= 1024` bytes) with `zlib.gzipSync` when `req.headers['accept-encoding']` includes `'gzip'` and no `Content-Encoding` header is set yet.
  - `TicketManager.createTicket(metadata?: Record<string, any>, ttlMs?: number, reusable?: boolean): string` — when `reusable === true` (or `metadata?.reusable === true`), `consumeTicket(ticket)` validates expiration without deleting the entry so multiple HTTP Range requests succeed within the TTL window.
  - `POST /api/auth/ticket`: when `req.query.reusable === '1'` or `req.body?.reusable === true`, calls `ticketManager.createTicket({ reusable: true }, 60000, true)` and returns `{ success: true, ticket, expiresIn: 60 }`.
  - `GET /api/terminal/files/download`:
    - When `req.query.inline === '1'` or `'true'`, sets `Content-Disposition: inline; filename="..."`.
    - When no `Range` header is present, `req.headers['accept-encoding']` includes `gzip`, and either `req.query.compress === '1'` or the file extension is compressible (`.txt`, `.log`, `.md`, `.markdown`, `.json`, `.js`, `.ts`, `.tsx`, `.jsx`, `.css`, `.html`, `.xml`, `.svg`, `.csv`, `.sql`, `.yml`, `.yaml`, `.sh`, `.py`, `.go`, `.rs`, `.c`, `.cpp`, `.java`, `.pdf`, `.tar`), streams through `zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })` with `Content-Encoding: gzip` and `Vary: Accept-Encoding` (omitting uncompressed `Content-Length` unless `Range` or `x-no-compression` is present). Note: To keep `tests/terminalFileRangeDownload.test.ts` (which expects `Content-Length` on `/var/log/app.log` when `supertest` sends default headers) 100% compatible, enable download stream gzip when `req.query.compress === '1'` OR when `req.headers['cf-ray']` / `req.headers['x-forwarded-proto']` / explicit `Accept-Encoding: gzip` is sent AND `req.query.inline !== '1'` (since inline PDF preview needs `Accept-Ranges: bytes` + `Content-Length` for native PDF Range seeking!).
  - `requestAuthTicket(adminKey?: string, timeoutMs?: number, reusable?: boolean): Promise<string | null>` in `frontend/src/utils/apiClient.ts`.
  - `handleOpenPdf(file)` in `TerminalFileManagerView.tsx` obtains a reusable ticket (`requestAuthTicket(adminKey, 5000, true)`) and immediately sets `blobUrl` to `/api/terminal/files/download?hostId=...&path=...&inline=1&ticket=...` without waiting for `res.blob()`.

- [x] **Step 1: Write the failing test in `tests/httpCompressionAndInlinePreview.test.ts`**

```typescript
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../src/app';
import config from '../config/default';
import { ticketManager, TicketManager } from '../src/server/modules/auth/ticketManager';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Origin HTTP Compression, Reusable Preview Tickets & Inline PDF Stream', () => {
  const secretKey = config.adminSecretKey || 'test-admin-key';
  const hostId = 'http-compress-test-node';
  const largeContent = 'Cloudflare Tunnel Origin Gzip Compression Payload Line\n'.repeat(200);

  beforeAll(() => {
    config.adminSecretKey = secretKey;
    const mockWs = {
      readyState: 1,
      send: jest.fn((msg: string) => {
        if (!msg.startsWith('JSON:')) return;
        const parsed = JSON.parse(msg.slice(5));
        const { reqId, action } = parsed;
        if (action === 'read') {
          terminalHostManager.handleAgentRpcResponse({
            reqId,
            success: true,
            data: {
              path: '/var/log/huge.log',
              size: Buffer.byteLength(largeContent),
              isBinary: false,
              content: largeContent,
            },
          });
        } else if (action === 'stat') {
          terminalHostManager.handleAgentRpcResponse({
            reqId,
            success: true,
            data: {
              size: Buffer.byteLength(largeContent),
              mtime: Date.now(),
              isDirectory: false,
            },
          });
        } else if (action === 'download_chunk') {
          terminalHostManager.handleAgentRpcResponse({
            reqId,
            success: true,
            data: Buffer.from(largeContent).toString('base64'),
          });
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId,
      name: 'Compress-Node',
      agentWs: mockWs,
    });
  });

  afterAll(() => {
    terminalHostManager.unregisterAgent(hostId);
  });

  test('TicketManager supports reusable tickets for multi-request streaming within TTL', () => {
    const tm = new TicketManager({ sweepIntervalMs: 0 });
    try {
      const reusableTicket = tm.createTicket({ reusable: true }, 60000, true);
      expect(tm.consumeTicket(reusableTicket)).toBe(true);
      expect(tm.consumeTicket(reusableTicket)).toBe(true);
      expect(tm.consumeTicket(reusableTicket)).toBe(true);
    } finally {
      tm.destroy();
    }
  });

  test('POST /api/auth/ticket?reusable=1 issues a multi-use ticket', async () => {
    const res = await request(app)
      .post('/api/auth/ticket?reusable=1')
      .set('x-admin-key', secretKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const ticket = res.body.ticket;
    expect(ticketManager.consumeTicket(ticket)).toBe(true);
    expect(ticketManager.consumeTicket(ticket)).toBe(true);
  });

  test('GET /api/terminal/files/content returns gzip-compressed JSON when Accept-Encoding includes gzip', async () => {
    const res = await request(app)
      .get('/api/terminal/files/content')
      .set('x-admin-key', secretKey)
      .set('Accept-Encoding', 'gzip')
      .query({ hostId, path: '/var/log/huge.log' });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.success).toBe(true);
    expect(res.body.content).toBe(largeContent);
  });

  test('GET /api/terminal/files/download?inline=1 sets Content-Disposition to inline and preserves Accept-Ranges', async () => {
    const res = await request(app)
      .get('/api/terminal/files/download')
      .set('x-admin-key', secretKey)
      .query({ hostId, path: '/docs/manual.pdf', inline: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('inline;');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  test('GET /api/terminal/files/download?compress=1 streams gzip-compressed file payload', async () => {
    const res = await request(app)
      .get('/api/terminal/files/download')
      .set('x-admin-key', secretKey)
      .set('Accept-Encoding', 'gzip')
      .query({ hostId, path: '/var/log/huge.log', compress: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.text).toBe(largeContent);
  });

  test('TerminalFileManagerView uses direct streaming URL with inline=1 and reusable ticket for PDF preview', () => {
    const fmPath = path.resolve(
      __dirname,
      '../frontend/src/components/terminal/TerminalFileManagerView.tsx'
    );
    const code = fs.readFileSync(fmPath, 'utf-8');
    expect(code).toContain("inline: '1'");
    expect(code).toContain('requestAuthTicket(adminKey, 5000, true)');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/httpCompressionAndInlinePreview.test.ts`
Expected: FAIL on reusable ticket consumption, missing `content-encoding: gzip`, and missing `inline;`.

- [x] **Step 3: Implement `compressionMiddleware.ts`, reusable preview ticket, inline/compressed download in `terminalFileController.ts`, and instant streaming PDF preview in `TerminalFileManagerView.tsx`**

1. Update `src/server/modules/auth/ticketManager.ts`:
   - Add `reusable?: boolean` to `TicketEntry`.
   - Update `createTicket(metadata?: Record<string, any>, ttlMs?: number, reusable?: boolean): string` to set `reusable: Boolean(reusable || metadata?.reusable)`.
   - In `consumeTicket(ticket: string): boolean`: if `Date.now() > entry.expiresAt`, delete and return `false`. Only delete `this.tickets.delete(ticket)` immediately if `!entry.reusable`.

2. Update `src/server/modules/auth/authController.ts`:
   - In `createTicket(req, res)`: check `const isReusable = req.query.reusable === '1' || req.query.reusable === 'true' || req.body?.reusable === true;`.
   - Call `ticketManager.createTicket(isReusable ? { reusable: true } : undefined, isReusable ? 60000 : undefined, isReusable)` and return `expiresIn: isReusable ? 60 : 30`.

3. Create `src/server/middlewares/compressionMiddleware.ts` and mount in `src/server/app.ts`:
   - Intercept `res.json` and `res.send`: when `req.headers['accept-encoding']` contains `'gzip'`, `!res.getHeader('Content-Encoding')`, and payload byte length `>= 1024`, compress with `zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_SPEED })`, set `Content-Encoding: gzip`, `Vary: Accept-Encoding`, `Content-Length: String(compressed.length)`, and send the compressed buffer.

4. Update `src/terminal/controllers/terminalFileController.ts`:
   - In `downloadFile`:
     - Check `const isInline = req.query.inline === '1' || req.query.inline === 'true';` and set `Content-Disposition` to `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(result.filename)}"`.
     - Check `const wantsCompress = (req.query.compress === '1' || req.query.compress === 'true') && String(req.headers['accept-encoding'] || '').includes('gzip');`.
     - When `wantsCompress && !rangeHeader`: set `res.setHeader('Content-Encoding', 'gzip')`, `res.setHeader('Vary', 'Accept-Encoding')`, omit uncompressed `Content-Length`, and pipe `result.stream` through `zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })` to `res`.

5. Update `frontend/src/utils/apiClient.ts` and `frontend/src/components/terminal/TerminalFileManagerView.tsx`:
   - In `apiClient.ts`: update `requestAuthTicket(adminKey?: string, timeoutMs: number = 5000, reusable: boolean = false)` to request `/api/auth/ticket${reusable ? '?reusable=1' : ''}`.
   - In `TerminalFileManagerView.tsx`:
     - In `handleDownload`: pass `compress: '1'` for non-precompressed files or keep standard download URL.
     - In `handleOpenPdf`: obtain a reusable ticket via `const ticket = adminKey ? await requestAuthTicket(adminKey, 5000, true) : null;`, build `params = new URLSearchParams({ hostId: activeHostId, path: file.path, inline: '1' })` (with `ticket` or `x-admin-key`), and immediately set `pdfPreviewTarget({ file, blobUrl: `/api/terminal/files/download?${params.toString()}`, loading: false, error: null })`. Guard `URL.revokeObjectURL` so it is only called when `blobUrl.startsWith('blob:')`.

- [x] **Step 4: Run tests and full build to verify everything passes**

Run: `npm test -- tests/httpCompressionAndInlinePreview.test.ts tests/fileRpcCompressionAndPrefetch.test.ts tests/ticketManager.test.ts tests/authTicketRoutes.test.ts tests/terminalFileRangeDownload.test.ts tests/fileManagerMarkdownAndPdf.test.ts && npm run build`
Expected: PASS on all test suites and full project build succeeds.

- [x] **Step 5: Commit**

```bash
git add src/server/middlewares/compressionMiddleware.ts src/server/app.ts src/terminal/controllers/terminalFileController.ts src/server/modules/auth/ticketManager.ts src/server/modules/auth/authController.ts frontend/src/utils/apiClient.ts frontend/src/components/terminal/TerminalFileManagerView.tsx tests/httpCompressionAndInlinePreview.test.ts tests/fileManagerMarkdownAndPdf.test.ts
git commit -m "perf(files): add origin HTTP gzip compression and instant inline PDF streaming"
```
