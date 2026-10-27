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

  test('retries download_chunk automatically when agent briefly reconnects mid-stream', async () => {
    const hostId = 'prefetch-retry-node';
    const chunkSize = 512 * 1024; // 512KB
    const totalSize = chunkSize * 3; // 1.5MB (3 chunks)
    let chunk1Attempts = 0;

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
          const offset = Number(params.offset) || 0;
          const length = Number(params.length) || chunkSize;
          const chunkIndex = Math.floor(offset / chunkSize);

          if (chunkIndex === 1 && chunk1Attempts === 0) {
            chunk1Attempts++;
            // Simulate agent reconnect mid-stream:
            setTimeout(() => {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: false,
                error: `Agent ${hostId} reconnected; previous RPC cancelled`,
              });
            }, 10);
            return;
          }

          if (chunkIndex === 1) {
            chunk1Attempts++;
          }

          const rawBuf = Buffer.alloc(length, 70 + chunkIndex); // 'F', 'G', 'H'
          const gzBuf = zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_SPEED });

          setTimeout(() => {
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
          }, 10);
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId,
      name: 'Retry-Agent',
      agentWs: mockWs,
    });

    try {
      const service = new TerminalFileService();
      const result = await service.getFileStream(hostId, '/remote/retry-file.bin');
      expect(result.status).toBe(200);
      expect(result.stream).toBeDefined();

      const receivedChunks: Buffer[] = [];
      for await (const part of result.stream!) {
        receivedChunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      }

      const fullBuffer = Buffer.concat(receivedChunks);
      expect(fullBuffer.length).toBe(totalSize);
      expect(chunk1Attempts).toBe(2);
      expect(fullBuffer[0]).toBe(70); // 'F'
      expect(fullBuffer[chunkSize]).toBe(71); // 'G'
      expect(fullBuffer[chunkSize * 2]).toBe(72); // 'H'
    } finally {
      terminalHostManager.unregisterAgent(hostId);
    }
  });
});
