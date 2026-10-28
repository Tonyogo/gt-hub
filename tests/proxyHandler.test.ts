import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';
import { ProxyHandler } from '../src/agent/handlers/proxyHandler';

describe('ProxyHandler', () => {
  let httpServer: http.Server;
  let httpPort: number;
  let tcpServer: net.Server;
  let tcpPort: number;

  beforeAll(async () => {
    // 1. Setup local HTTP target server
    httpServer = http.createServer((req, res) => {
      if (req.url === '/get-test') {
        res.setHeader('x-custom-res', 'custom-value');
        res.setHeader('Set-Cookie', ['session=abc123', 'theme=dark']);
        res.writeHead(200);
        res.end('hello from local http target');
      } else if (req.url === '/echo-post') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          res.setHeader('content-type', 'application/octet-stream');
          res.writeHead(200);
          res.end(body);
        });
      } else if (req.url === '/large-response') {
        const largeBuf = Buffer.alloc(100 * 1024, 'A');
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(largeBuf);
      } else if (req.url === '/slow-stream') {
        res.writeHead(200);
        res.write('part1');
        // Do not end immediately to allow testing abort
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        httpPort = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 2. Setup local TCP echo server
    tcpServer = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(d));
    });

    await new Promise<void>((resolve) => {
      tcpServer.listen(0, '127.0.0.1', () => {
        tcpPort = (tcpServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  });

  it('verifies BIN_MSG_TYPE constants', () => {
    expect(BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY).toBe(0x05);
    expect(BIN_MSG_TYPE.PROXY_HTTP_RES_BODY).toBe(0x06);
    expect(BIN_MSG_TYPE.PROXY_TCP_DATA).toBe(0x07);
  });

  it('handles GET request and preserves multi-value set-cookie headers', async () => {
    const sentMessages: (string | Buffer)[] = [];
    let activityCount = 0;

    const handler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      onActivity: () => activityCount++,
      allowProxy: true,
    });

    const reqId = 'req-get-1';
    const handled = handler.handleControlMessage({
      type: 'proxy_http_start',
      reqId,
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/get-test`,
      headers: { host: `127.0.0.1:${httpPort}` },
      bodyEnd: true,
    });

    expect(handled).toBe(true);

    // Wait until proxy_http_end is received
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasEnd = sentMessages.some(
          (m) => typeof m === 'string' && m.includes('"type":"proxy_http_end"') && m.includes(reqId)
        );
        if (hasEnd) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // Verify headers control message
    const headersMsg = sentMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"proxy_http_headers"') && m.includes(reqId)
    ) as string;
    expect(headersMsg).toBeDefined();
    const parsedHeaders = JSON.parse(headersMsg.replace(/^JSON:/, ''));
    expect(parsedHeaders.statusCode).toBe(200);
    expect(parsedHeaders.headers['x-custom-res']).toBe('custom-value');
    expect(parsedHeaders.headers['set-cookie']).toEqual(['session=abc123', 'theme=dark']);

    // Verify binary body chunks
    const bodyChunks = sentMessages
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => decodeBinaryPacket(m))
      .filter((d) => d !== null && d.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY && d.id === reqId);

    const body = Buffer.concat(bodyChunks.map((b) => b!.payload)).toString('utf-8');
    expect(body).toBe('hello from local http target');
    expect(activityCount).toBeGreaterThan(0);
    handler.destroyAll();
  });

  it('handles streaming POST request with 0x05 binary chunks and slices large response <= 32KB', async () => {
    const sentMessages: (string | Buffer)[] = [];

    const handler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      allowProxy: true,
    });

    const reqId = 'req-post-echo';
    handler.handleControlMessage({
      type: 'proxy_http_start',
      reqId,
      method: 'POST',
      url: `http://127.0.0.1:${httpPort}/echo-post`,
      headers: { host: `127.0.0.1:${httpPort}`, 'content-type': 'application/octet-stream' },
      bodyEnd: false,
    });

    const postData = Buffer.from('chunked-post-data-payload');
    const binaryPacket = encodeBinaryPacket(BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY, reqId, postData);
    const binaryHandled = handler.handleBinaryFrame(decodeBinaryPacket(binaryPacket)!);
    expect(binaryHandled).toBe(true);

    handler.handleControlMessage({
      type: 'proxy_http_req_end',
      reqId,
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasEnd = sentMessages.some(
          (m) => typeof m === 'string' && m.includes('"type":"proxy_http_end"') && m.includes(reqId)
        );
        if (hasEnd) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const echoChunks = sentMessages
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => decodeBinaryPacket(m))
      .filter((d) => d !== null && d.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY && d.id === reqId);
    const echoed = Buffer.concat(echoChunks.map((c) => c!.payload)).toString('utf-8');
    expect(echoed).toBe('chunked-post-data-payload');

    // Test large response slicing <= 32768
    const largeReqId = 'req-large-1';
    handler.handleControlMessage({
      type: 'proxy_http_start',
      reqId: largeReqId,
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/large-response`,
      headers: { host: `127.0.0.1:${httpPort}` },
      bodyEnd: true,
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasEnd = sentMessages.some(
          (m) => typeof m === 'string' && m.includes('"type":"proxy_http_end"') && m.includes(largeReqId)
        );
        if (hasEnd) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const largeChunks = sentMessages
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => decodeBinaryPacket(m))
      .filter((d) => d !== null && d.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY && d.id === largeReqId);

    expect(largeChunks.length).toBeGreaterThan(1);
    for (const chunk of largeChunks) {
      expect(chunk!.payload.length).toBeLessThanOrEqual(32 * 1024);
    }
    const totalLarge = Buffer.concat(largeChunks.map((c) => c!.payload));
    expect(totalLarge.length).toBe(100 * 1024);
    handler.destroyAll();
  });

  it('handles proxy_http_abort and drops unknown 0x05 binary frames cleanly', async () => {
    const sentMessages: (string | Buffer)[] = [];
    const handler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      allowProxy: true,
    });

    const reqId = 'req-abort-1';
    handler.handleControlMessage({
      type: 'proxy_http_start',
      reqId,
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/slow-stream`,
      headers: { host: `127.0.0.1:${httpPort}` },
      bodyEnd: true,
    });

    expect(handler.getActiveCount().httpCount).toBe(1);

    // Abort request
    handler.handleControlMessage({
      type: 'proxy_http_abort',
      reqId,
    });

    expect(handler.getActiveCount().httpCount).toBe(0);

    // Unknown reqId binary frame should be handled (return true) without leaking or crashing
    const unknownPacket = encodeBinaryPacket(
      BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY,
      'unknown-req-999',
      Buffer.from('orphaned chunk')
    );
    const decoded = decodeBinaryPacket(unknownPacket)!;
    expect(handler.handleBinaryFrame(decoded)).toBe(true);

    handler.destroyAll();
  });

  it('handles TCP connect, PROXY_TCP_DATA (0x07), and proxy_tcp_close against echo server', async () => {
    const sentMessages: (string | Buffer)[] = [];
    let activityCount = 0;

    const handler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      onActivity: () => activityCount++,
      allowProxy: true,
    });

    const streamId = 'tcp-stream-1';
    const handled = handler.handleControlMessage({
      type: 'proxy_tcp_connect',
      streamId,
      host: '127.0.0.1',
      port: tcpPort,
    });
    expect(handled).toBe(true);

    // Wait for proxy_tcp_connected
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasConnected = sentMessages.some(
          (m) => typeof m === 'string' && m.includes('"type":"proxy_tcp_connected"') && m.includes(streamId)
        );
        if (hasConnected) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(handler.getActiveCount().tcpCount).toBe(1);

    // Send TCP data
    const tcpPayload = Buffer.from('ping-tcp-data');
    const tcpPacket = encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, streamId, tcpPayload);
    expect(handler.handleBinaryFrame(decodeBinaryPacket(tcpPacket)!)).toBe(true);

    // Wait for echo response
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasEcho = sentMessages
          .filter((m): m is Buffer => Buffer.isBuffer(m))
          .map((m) => decodeBinaryPacket(m))
          .some((d) => d !== null && d.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA && d.id === streamId);
        if (hasEcho) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const echoChunks = sentMessages
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => decodeBinaryPacket(m))
      .filter((d) => d !== null && d.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA && d.id === streamId);
    expect(Buffer.concat(echoChunks.map((c) => c!.payload)).toString('utf-8')).toBe('ping-tcp-data');

    // Close stream
    handler.handleControlMessage({
      type: 'proxy_tcp_close',
      streamId,
    });
    expect(handler.getActiveCount().tcpCount).toBe(0);

    handler.destroyAll();
  });

  it('emits proxy_tcp_close on ECONNREFUSED', async () => {
    const sentMessages: (string | Buffer)[] = [];
    const handler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      allowProxy: true,
    });

    // Use an unallocated port
    const streamId = 'tcp-fail-1';
    handler.handleControlMessage({
      type: 'proxy_tcp_connect',
      streamId,
      host: '127.0.0.1',
      port: 1, // Port 1 is normally refused
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasClose = sentMessages.some(
          (m) => typeof m === 'string' && m.includes('"type":"proxy_tcp_close"') && m.includes(streamId)
        );
        if (hasClose) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const closeMsg = sentMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"proxy_tcp_close"') && m.includes(streamId)
    ) as string;
    const parsed = JSON.parse(closeMsg.replace(/^JSON:/, ''));
    expect(parsed.code).toBe('ECONNREFUSED');

    handler.destroyAll();
  });

  it('rejects requests when allowProxy is false or maxConcurrentStreams exceeded', () => {
    const sentMessages: (string | Buffer)[] = [];
    const disabledHandler = new ProxyHandler({
      send: (data: string | Buffer) => sentMessages.push(data),
      allowProxy: false,
    });

    disabledHandler.handleControlMessage({
      type: 'proxy_http_start',
      reqId: 'req-disabled',
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/get-test`,
    });

    const httpRejectMsg = sentMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"proxy_http_end"') && m.includes('req-disabled')
    ) as string;
    expect(httpRejectMsg).toBeDefined();
    expect(JSON.parse(httpRejectMsg.replace(/^JSON:/, '')).code).toBe('EACCES');

    disabledHandler.handleControlMessage({
      type: 'proxy_tcp_connect',
      streamId: 'tcp-disabled',
      host: '127.0.0.1',
      port: tcpPort,
    });

    const tcpRejectMsg = sentMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"proxy_tcp_close"') && m.includes('tcp-disabled')
    ) as string;
    expect(tcpRejectMsg).toBeDefined();
    expect(JSON.parse(tcpRejectMsg.replace(/^JSON:/, '')).code).toBe('EACCES');

    // Max concurrent streams test
    const limitedMessages: (string | Buffer)[] = [];
    const limitedHandler = new ProxyHandler({
      send: (data: string | Buffer) => limitedMessages.push(data),
      allowProxy: true,
      maxConcurrentStreams: 1,
    });

    limitedHandler.handleControlMessage({
      type: 'proxy_http_start',
      reqId: 'req-lim-1',
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/slow-stream`,
    });

    limitedHandler.handleControlMessage({
      type: 'proxy_http_start',
      reqId: 'req-lim-2',
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/slow-stream`,
    });

    const overflowMsg = limitedMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"proxy_http_end"') && m.includes('req-lim-2')
    ) as string;
    expect(overflowMsg).toBeDefined();
    expect(JSON.parse(overflowMsg.replace(/^JSON:/, '')).code).toBe('EMFILE');

    limitedHandler.destroyAll();
  });
});
