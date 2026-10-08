import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
// @ts-ignore
import { downloadRemoteFile } from '../scripts/gt.js';

describe('gt cp CLI Resumable Range Download Tests', () => {
  let server: http.Server;
  let serverUrl: string;
  let port: number;

  const testData = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 62 bytes
  let requestedRanges: (string | undefined)[] = [];
  let transient500Sent = false;

  const tempDir = path.join(os.tmpdir(), `gt-cp-test-${Date.now()}`);

  beforeAll((done) => {
    fs.mkdirSync(tempDir, { recursive: true });

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      if (url.pathname === '/api/terminal/files/download') {
        const range = req.headers['range'];
        requestedRanges.push(range);
        const remoteFilePath = url.searchParams.get('path');

        if (remoteFilePath === '/remote/drop-midway.txt' && !range) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': testData.length,
            'Accept-Ranges': 'bytes',
          });
          res.write(testData.slice(0, 25));
          setTimeout(() => {
            res.socket?.destroy();
          }, 30);
          return;
        }

        if (remoteFilePath === '/remote/premature-end.txt' && !range) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': testData.length,
            'Accept-Ranges': 'bytes',
          });
          res.write(testData.slice(0, 30));
          setTimeout(() => {
            res.destroy();
          }, 30);
          return;
        }

        if (remoteFilePath === '/remote/empty.txt') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': 0,
            'Accept-Ranges': 'bytes',
          });
          res.end('');
          return;
        }

        if (remoteFilePath === '/remote/transient-500.txt') {
          if (!range) {
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': testData.length,
              'Accept-Ranges': 'bytes',
            });
            res.write(testData.slice(0, 20));
            setTimeout(() => {
              res.socket?.destroy();
            }, 30);
            return;
          }
          if (!transient500Sent) {
            transient500Sent = true;
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Agent reconnecting; temporary failure' }));
            return;
          }
        }

        if (!range) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': testData.length,
            'Accept-Ranges': 'bytes',
          });
          res.end(testData);
          return;
        }

        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          const start = parseInt(match[1], 10);
          if (start >= testData.length) {
            res.writeHead(416, {
              'Content-Range': `bytes */${testData.length}`,
              'Accept-Ranges': 'bytes',
            });
            res.end();
            return;
          }

          const end = match[2] ? parseInt(match[2], 10) : testData.length - 1;
          const chunk = testData.slice(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end}/${testData.length}`,
            'Content-Length': chunk.length,
            'Accept-Ranges': 'bytes',
          });
          res.end(chunk);
          return;
        }

        res.writeHead(400);
        res.end('Bad Range');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      port = addr.port;
      serverUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    server.close(done);
  });

  beforeEach(() => {
    requestedRanges = [];
    transient500Sent = false;
  });

  test('downloads whole file cleanly when no partial file exists', async () => {
    const destFile = path.join(tempDir, 'file1.txt');
    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/file1.txt',
      localPath: destFile,
    });

    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(`${destFile}.part`)).toBe(false);
  });

  test('resumes download when a .part file already exists with partial content', async () => {
    const destFile = path.join(tempDir, 'file2.txt');
    const partFile = `${destFile}.part`;

    // Simulate an interrupted download with first 20 bytes
    fs.writeFileSync(partFile, testData.slice(0, 20), 'utf-8');

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/file2.txt',
      localPath: destFile,
    });

    expect(requestedRanges).toContain('bytes=20-');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('handles 416 by resetting and redownloading whole file', async () => {
    const destFile = path.join(tempDir, 'file3.txt');
    const partFile = `${destFile}.part`;

    // Simulate a corrupted .part file with size >= remote size
    fs.writeFileSync(partFile, 'x'.repeat(100), 'utf-8');

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/file3.txt',
      localPath: destFile,
    });

    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('auto-resumes when connection is abruptly destroyed mid-stream', async () => {
    const destFile = path.join(tempDir, 'file-drop.txt');
    const partFile = `${destFile}.part`;

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/drop-midway.txt',
      localPath: destFile,
    });

    expect(requestedRanges).toContain('bytes=25-');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('auto-resumes when stream ends prematurely without full content', async () => {
    const destFile = path.join(tempDir, 'file-premature.txt');
    const partFile = `${destFile}.part`;

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/premature-end.txt',
      localPath: destFile,
    });

    expect(requestedRanges).toContain('bytes=30-');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('auto-resumes when transient 500 error occurs during resumption', async () => {
    const destFile = path.join(tempDir, 'file-transient-500.txt');
    const partFile = `${destFile}.part`;

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/transient-500.txt',
      localPath: destFile,
    });

    // Should have retried with range after the 500 response
    expect(requestedRanges.filter(r => r === 'bytes=20-').length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('auto-resets when .part file is corrupted with size exceeding expected total', async () => {
    const destFile = path.join(tempDir, 'file-oversized-part.txt');
    const partFile = `${destFile}.part`;

    // Create corrupted .part file with 200 bytes (testData is only 62 bytes)
    fs.writeFileSync(partFile, 'Z'.repeat(200), 'utf-8');

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/file1.txt',
      localPath: destFile,
    });

    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe(testData);
    expect(fs.existsSync(partFile)).toBe(false);
  });

  test('downloads empty 0-byte file cleanly', async () => {
    const destFile = path.join(tempDir, 'empty-download.txt');
    const partFile = `${destFile}.part`;

    await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'test-node',
      remotePath: '/remote/empty.txt',
      localPath: destFile,
    });

    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe('');
    expect(fs.existsSync(partFile)).toBe(false);
  });
});
