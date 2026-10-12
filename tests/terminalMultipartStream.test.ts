import request from 'supertest';
import app from '../src/app';
import config from '../config/default';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { Readable, PassThrough } from 'stream';
import http from 'http';

describe('Multipart Stream Upload Robustness & Edge Cases', () => {
  const secretKey = config.adminSecretKey || 'test-admin-key';
  const testHostId = 'test-multipart-stream-node';
  let mockAgentWs: any;
  let receivedChunks: { offset: number; truncate?: boolean; length: number }[] = [];

  beforeAll(() => {
    config.adminSecretKey = secretKey;
    mockAgentWs = {
      readyState: 1,
      send: jest.fn((msg: string) => {
        if (msg.startsWith('JSON:')) {
          const parsed = JSON.parse(msg.slice(5));
          if (parsed.type === 'file_rpc' && parsed.action === 'upload_chunk') {
            const buf = Buffer.from(parsed.params?.data || '', 'base64');
            receivedChunks.push({
              offset: parsed.params?.offset,
              truncate: parsed.params?.truncate,
              length: buf.length,
            });
            terminalHostManager.handleAgentRpcResponse({
              reqId: parsed.reqId,
              success: true,
            });
          }
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId: testHostId,
      name: 'Multipart-Stream-Node',
      agentWs: mockAgentWs,
    });
  });

  afterAll(() => {
    terminalHostManager.unregisterAgent(testHostId);
  });

  beforeEach(() => {
    receivedChunks = [];
  });

  test('handles multipart boundary split across chunk boundaries', async () => {
    const boundary = '----WebKitFormBoundarySplitTest123';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="split.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const body = 'Hello Split Stream Data!';
    const footer = `\r\n--${boundary}--\r\n`;

    // Split deliberately right between the boundary and the trailing dashes '--'
    const fullPayload = Buffer.from(header + body + footer);
    const splitIndex = fullPayload.indexOf(Buffer.from(`--${boundary}`)) + `--${boundary}`.length;

    // chunk1 ends right at '--WebKitFormBoundarySplitTest123'
    const chunk1 = fullPayload.slice(0, splitIndex);
    // chunk2 starts with '--\r\n'
    const chunk2 = fullPayload.slice(splitIndex);

    const stream = new PassThrough();

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    const reqPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/admin/terminal/files/upload?hostId=${testHostId}&path=/tmp`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-admin-key': secretKey,
        },
      }, (res) => {
        let resData = '';
        res.on('data', c => { resData += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode || 500, body: resData });
          }
        });
      });
      clientReq.on('error', reject);
      stream.pipe(clientReq);
    });

    // Write chunk1
    stream.write(chunk1);
    await new Promise(r => setTimeout(r, 50));
    // Write chunk2 and finish
    stream.end(chunk2);

    const result = await reqPromise;
    server.close();

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.uploaded).toContain('split.txt');
  });

  test('rejects prematurely closed multipart stream without closing boundary', async () => {
    const boundary = '----WebKitFormBoundaryTruncatedTest123';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truncated.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const body = 'This stream was cut off before closing boundary...';

    const stream = new PassThrough();

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    const reqPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/admin/terminal/files/upload?hostId=${testHostId}&path=/tmp`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-admin-key': secretKey,
        },
      }, (res) => {
        let resData = '';
        res.on('data', c => { resData += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode || 500, body: resData });
          }
        });
      });
      clientReq.on('error', reject);
      stream.pipe(clientReq);
    });

    // Send header and body, but NO closing boundary, then abruptly end stream
    stream.write(Buffer.from(header + body));
    stream.end();

    const result = await reqPromise;
    server.close();

    // Must be rejected as incomplete, NOT returned as 200 OK!
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toMatch(/end of multipart|boundary/i);
  });

  test('handles byte-by-byte streaming of multiple files in single multipart request', async () => {
    const boundary = '----WebKitFormBoundaryByteByByte999';
    const part1 = `--${boundary}\r\nContent-Disposition: form-data; name="file1"; filename="file1.txt"\r\nContent-Type: text/plain\r\n\r\nfile-one-content`;
    const part2 = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file2"; filename="file2.txt"\r\nContent-Type: text/plain\r\n\r\nfile-two-content`;
    const footer = `\r\n--${boundary}--\r\n`;

    const fullPayload = Buffer.from(part1 + part2 + footer);
    const stream = new PassThrough();

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    const reqPromise = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/admin/terminal/files/upload?hostId=${testHostId}&path=/tmp`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-admin-key': secretKey,
        },
      }, (res) => {
        let resData = '';
        res.on('data', c => { resData += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode || 500, body: resData });
          }
        });
      });
      clientReq.on('error', reject);
      stream.pipe(clientReq);
    });

    // Feed data in small 5-byte chunks
    for (let i = 0; i < fullPayload.length; i += 5) {
      stream.write(fullPayload.slice(i, Math.min(i + 5, fullPayload.length)));
    }
    stream.end();

    const result = await reqPromise;
    server.close();

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.uploaded).toEqual(['file1.txt', 'file2.txt']);
  });

  test('aborts upload and returns error when agent RPC fails on a chunk', async () => {
    const errorHostId = 'test-failing-agent-node';
    const mockFailingWs = {
      readyState: 1,
      send: jest.fn((msg: string) => {
        if (msg.startsWith('JSON:')) {
          const parsed = JSON.parse(msg.slice(5));
          if (parsed.type === 'file_rpc' && parsed.action === 'upload_chunk') {
            terminalHostManager.handleAgentRpcResponse({
              reqId: parsed.reqId,
              success: false,
              error: 'Agent disk quota exceeded',
            });
          }
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId: errorHostId,
      name: 'Failing-Agent-Node',
      agentWs: mockFailingWs,
    });

    const boundary = '----WebKitFormBoundaryErrorTest999';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="err.txt"\r\nContent-Type: text/plain\r\n\r\nerror-test-content\r\n--${boundary}--\r\n`;

    const res = await request(app)
      .post('/api/admin/terminal/files/upload')
      .set('x-admin-key', secretKey)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .query({ hostId: errorHostId, path: '/tmp' })
      .send(payload);

    terminalHostManager.unregisterAgent(errorHostId);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Agent disk quota exceeded');
  });
});
