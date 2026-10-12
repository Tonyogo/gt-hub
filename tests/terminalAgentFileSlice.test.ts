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

  test('upload_chunk with offset and truncate writes chunked file sequentially', (done) => {
    const chunkFile = path.join(tempDir, 'chunked-output.txt');
    const chunk1 = Buffer.from('CHUNK-ONE-');
    const chunk2 = Buffer.from('CHUNK-TWO');

    // First chunk: offset 0, truncate true
    const ws1 = createMockWs((res1) => {
      expect(res1.success).toBe(true);

      // Second chunk: offset chunk1.length
      const ws2 = createMockWs((res2) => {
        expect(res2.success).toBe(true);
        const assembled = fs.readFileSync(chunkFile, 'utf-8');
        expect(assembled).toBe('CHUNK-ONE-CHUNK-TWO');
        done();
      });

      handleFileRpc(
        {
          reqId: 'req-upload-2',
          action: 'upload_chunk',
          path: tempDir,
          params: {
            filename: 'chunked-output.txt',
            data: chunk2.toString('base64'),
            offset: chunk1.length,
          },
        },
        ws2
      );
    });

    handleFileRpc(
      {
        reqId: 'req-upload-1',
        action: 'upload_chunk',
        path: tempDir,
        params: {
          filename: 'chunked-output.txt',
          data: chunk1.toString('base64'),
          offset: 0,
          truncate: true,
        },
      },
      ws1
    );
  });

  test('async list, write, read, mkdir, rename, delete operations execute without blocking', async () => {
    const rpcPromise = (action: string, targetPath: string, params?: any) => {
      return new Promise<any>((resolve) => {
        const ws = createMockWs((res) => resolve(res));
        handleFileRpc({ reqId: `req-${Date.now()}-${Math.random()}`, action, path: targetPath, params }, ws);
      });
    };

    // 1. mkdir
    const subDirName = `sub-${Date.now()}`;
    const mkdirRes = await rpcPromise('mkdir', tempDir, { dirName: subDirName });
    expect(mkdirRes.success).toBe(true);
    const subDir = path.join(tempDir, subDirName);
    expect(fs.existsSync(subDir)).toBe(true);

    // 2. write
    const asyncFile = path.join(subDir, 'test-async.txt');
    const writeRes = await rpcPromise('write', asyncFile, { content: 'hello async fs' });
    expect(writeRes.success).toBe(true);

    // 3. read
    const readRes = await rpcPromise('read', asyncFile);
    expect(readRes.success).toBe(true);
    expect(readRes.data.content).toBe('hello async fs');
    expect(readRes.data.isBinary).toBe(false);

    // 4. list
    const listRes = await rpcPromise('list', subDir);
    expect(listRes.success).toBe(true);
    expect(listRes.data.files.length).toBe(1);
    expect(listRes.data.files[0].name).toBe('test-async.txt');

    // 5. rename
    const renamedFile = path.join(subDir, 'renamed-async.txt');
    const renameRes = await rpcPromise('rename', asyncFile, { newPath: renamedFile });
    expect(renameRes.success).toBe(true);
    expect(fs.existsSync(renamedFile)).toBe(true);
    expect(fs.existsSync(asyncFile)).toBe(false);

    // 6. delete
    const deleteRes = await rpcPromise('delete', renamedFile);
    expect(deleteRes.success).toBe(true);
    expect(fs.existsSync(renamedFile)).toBe(false);
  });
});
