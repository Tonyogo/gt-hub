import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../src/app';
import config from '../config/default';
import { ticketManager, TicketManager } from '../src/server/modules/auth/ticketManager';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Origin HTTP Compression, Reusable Preview Tickets & Inline PDF Stream', () => {
  const originalSecretKey = config.adminSecretKey;
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
    config.adminSecretKey = originalSecretKey;
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
