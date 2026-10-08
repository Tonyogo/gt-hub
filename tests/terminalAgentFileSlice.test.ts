import fs from 'fs';
import path from 'path';
import os from 'os';
// @ts-ignore
import { handleFileRpc } from '../scripts/gt.js';

describe('Agent File RPC Slice and Stat Tests', () => {
  const tempDir = path.join(os.tmpdir(), `gt-agent-test-${Date.now()}`);
  const testFile = path.join(tempDir, 'sample.txt');
  const fileContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 bytes

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(testFile, fileContent, 'utf-8');
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockWs(onMessage: (parsed: any) => void) {
    return {
      readyState: 1, // WebSocket.OPEN
      send: jest.fn((raw: string) => {
        if (raw.startsWith('JSON:')) {
          onMessage(JSON.parse(raw.slice(5)));
        }
      }),
    };
  }

  test('stat returns file size and metadata', (done) => {
    const ws = createMockWs((res) => {
      expect(res.success).toBe(true);
      expect(res.data.size).toBe(36);
      expect(res.data.isDirectory).toBe(false);
      expect(typeof res.data.mtime).toBe('number');
      done();
    });

    handleFileRpc({ reqId: 'req-1', action: 'stat', path: testFile }, ws);
  });

  test('download_chunk without offset/length returns full base64 string for backward compatibility', (done) => {
    const ws = createMockWs((res) => {
      expect(res.success).toBe(true);
      expect(typeof res.data).toBe('string');
      const decoded = Buffer.from(res.data, 'base64').toString('utf-8');
      expect(decoded).toBe(fileContent);
      done();
    });

    handleFileRpc({ reqId: 'req-2', action: 'download_chunk', path: testFile }, ws);
  });

  test('download_chunk with offset and length returns sliced chunk', (done) => {
    const ws = createMockWs((res) => {
      expect(res.success).toBe(true);
      expect(typeof res.data).toBe('object');
      expect(res.data.size).toBe(36);
      expect(res.data.offset).toBe(10);
      expect(res.data.length).toBe(10);
      const decoded = Buffer.from(res.data.data, 'base64').toString('utf-8');
      expect(decoded).toBe(fileContent.slice(10, 20)); // 'KLMNOPQRST'
      done();
    });

    handleFileRpc(
      {
        reqId: 'req-3',
        action: 'download_chunk',
        path: testFile,
        params: { offset: 10, length: 10 },
      },
      ws
    );
  });

  test('download_chunk with offset exceeding size returns empty chunk or error', (done) => {
    const ws = createMockWs((res) => {
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/offset/i);
      done();
    });

    handleFileRpc(
      {
        reqId: 'req-4',
        action: 'download_chunk',
        path: testFile,
        params: { offset: 100, length: 10 },
      },
      ws
    );
  });
});
