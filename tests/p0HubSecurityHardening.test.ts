import http from 'http';
import net from 'net';
import request from 'supertest';
import app, { parseTrustProxySetting } from '../src/server/app';
import { AuthRateLimiter, extractClientIp, loginRateLimiter } from '../src/server/modules/auth/rateLimiter';
import config from '../src/server/config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import {
  validateCallbackConfig,
  isBlockedCallbackHost,
} from '../src/terminal/services/terminalExecCallbackService';

describe('P0 Hub Security Hardening (Task 2 & Task 4)', () => {
  const originalSecret = config.adminSecretKey;
  let testServer: http.Server | null = null;
  let testPort: number = 0;

  beforeEach(() => {
    config.adminSecretKey = 'test-hardening-secret';
    loginRateLimiter.reset();
  });

  afterEach(async () => {
    config.adminSecretKey = originalSecret;
    loginRateLimiter.reset();
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer!.close(() => resolve());
      });
      testServer = null;
    }
  });

  describe('AuthRateLimiter memory bounds', () => {
    it('enforces maxEntries cap and evicts oldest entries', () => {
      const limiter = new AuthRateLimiter({ maxEntries: 3, maxFailures: 5 });
      limiter.recordFailure('1.1.1.1');
      limiter.recordFailure('2.2.2.2');
      limiter.recordFailure('3.3.3.3');
      // 4th IP should trigger eviction
      limiter.recordFailure('4.4.4.4');
      limiter.recordFailure('5.5.5.5');

      // Internal size should not exceed maxEntries
      expect((limiter as any).failures.size).toBeLessThanOrEqual(3);
    });
  });

  describe('extractClientIp & parseTrustProxySetting', () => {
    it('parseTrustProxySetting handles various inputs correctly', () => {
      expect(parseTrustProxySetting(undefined)).toBe(false);
      expect(parseTrustProxySetting('')).toBe(false);
      expect(parseTrustProxySetting('false')).toBe(false);
      expect(parseTrustProxySetting('0')).toBe(false);
      expect(parseTrustProxySetting('true')).toBe(true);
      expect(parseTrustProxySetting('1')).toBe(1);
      expect(parseTrustProxySetting('2')).toBe(2);
      expect(parseTrustProxySetting('loopback')).toBe('loopback');
    });

    it('extractClientIp ignores x-forwarded-for when trustProxy is false', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
        socket: { remoteAddress: '127.0.0.1' },
      };
      expect(extractClientIp(req, false)).toBe('127.0.0.1');
    });

    it('extractClientIp extracts first IP from x-forwarded-for when trustProxy is true or 1', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
        socket: { remoteAddress: '127.0.0.1' },
      };
      expect(extractClientIp(req, true)).toBe('203.0.113.195');
      expect(extractClientIp(req, 1)).toBe('203.0.113.195');
    });
  });

  describe('Review Focus #1: GET /api/auth/status without key vs wrong key', () => {
    it('does not increment failure count or rate-limit when called 20 times without key', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/api/auth/status');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ authRequired: true, authenticated: false, allowedParentOrigins: [] });
      }
    });

    it('throttles with 429 when called 15 times with wrong key', async () => {
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .get('/api/auth/status')
          .set('x-admin-key', 'wrong-key');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ authRequired: true, authenticated: false, allowedParentOrigins: [] });
      }

      const throttled = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'wrong-key');
      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBeDefined();
    });
  });

  describe('adminAuthMiddleware rate limiting (/api/terminal/version)', () => {
    it('returns 429 after 15 failed key attempts and clears on valid key', async () => {
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .get('/api/terminal/version')
          .set('x-admin-key', 'wrong-key');
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .get('/api/terminal/version')
        .set('x-admin-key', 'wrong-key');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();

      // Reset limiter to verify success clears failure
      loginRateLimiter.reset();
      const success = await request(app)
        .get('/api/terminal/version')
        .set('x-admin-key', 'test-hardening-secret');
      expect(success.status).toBe(200);
    });
  });

  describe('proxyAuthMiddleware rate limiting & scoped cookie (/api/proxy/:hostId/ports)', () => {
    it('returns 429 after 15 failed key attempts', async () => {
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .get('/api/proxy/test-node/ports')
          .set('x-admin-key', 'wrong-key');
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .get('/api/proxy/test-node/ports')
        .set('x-admin-key', 'wrong-key');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('scopes gt_proxy_session cookie to /api/proxy and adds Secure on HTTPS', async () => {
      const res = await request(app)
        .get('/api/proxy/test-node/ports?key=test-hardening-secret')
        .set('X-Forwarded-Proto', 'https');

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
      expect(cookieStr).toMatch(/Path=\/api\/proxy/);
      expect(cookieStr).not.toMatch(/Path=\/;/);
      expect(cookieStr).toMatch(/Secure/i);
    });
  });

  describe('WebSocket upgrade rate limiting (/api/terminal/ws)', () => {
    it('returns HTTP/1.1 429 after 15 failed upgrade attempts', async () => {
      testServer = http.createServer(app);
      setupTerminalWebSocket(testServer);
      await new Promise<void>((resolve) => {
        testServer!.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = testServer.address() as net.AddressInfo;
      testPort = addr.port;

      const makeUpgradeReq = (key: string): Promise<string> => {
        return new Promise((resolve, reject) => {
          const client = net.connect(testPort, '127.0.0.1', () => {
            client.write(
              `GET /api/terminal/ws HTTP/1.1\r\nHost: 127.0.0.1:${testPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-admin-key: ${key}\r\n\r\n`
            );
          });
          let data = '';
          client.on('data', (chunk) => {
            data += chunk.toString();
          });
          client.on('end', () => resolve(data));
          client.on('close', () => resolve(data));
          client.on('error', (err) => reject(err));
        });
      };

      for (let i = 0; i < 15; i++) {
        const resp = await makeUpgradeReq('bad-key');
        expect(resp).toMatch(/HTTP\/1\.1 401 Unauthorized/);
      }

      const blockedResp = await makeUpgradeReq('bad-key');
      expect(blockedResp).toMatch(/HTTP\/1\.1 429 Too Many Requests/);
      expect(blockedResp).toMatch(/Retry-After:/i);
    });
  });

  describe('Security headers and disable x-powered-by', () => {
    it('omits x-powered-by and sets security headers on app responses without CSP frame-ancestors by default', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('sets CSP frame-ancestors when GT_FRAME_ANCESTORS is present', async () => {
      const originalAncestors = process.env.GT_FRAME_ANCESTORS;
      process.env.GT_FRAME_ANCESTORS = 'https://portal.example.com, https://admin.example.com';
      try {
        const res = await request(app).get('/health');
        expect(res.headers['content-security-policy']).toBe(
          "frame-ancestors 'self' https://portal.example.com https://admin.example.com"
        );
      } finally {
        if (originalAncestors === undefined) delete process.env.GT_FRAME_ANCESTORS;
        else process.env.GT_FRAME_ANCESTORS = originalAncestors;
      }
    });

    it('sets frame-ancestors self when GT_STRICT_FRAME_ANCESTORS is true and GT_FRAME_ANCESTORS is unset', async () => {
      const originalAncestors = process.env.GT_FRAME_ANCESTORS;
      const originalStrict = process.env.GT_STRICT_FRAME_ANCESTORS;
      delete process.env.GT_FRAME_ANCESTORS;
      process.env.GT_STRICT_FRAME_ANCESTORS = 'true';
      try {
        const res = await request(app).get('/health');
        expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
      } finally {
        if (originalAncestors === undefined) delete process.env.GT_FRAME_ANCESTORS;
        else process.env.GT_FRAME_ANCESTORS = originalAncestors;
        if (originalStrict === undefined) delete process.env.GT_STRICT_FRAME_ANCESTORS;
        else process.env.GT_STRICT_FRAME_ANCESTORS = originalStrict;
      }
    });
  });

  describe('Task 4: Webhook callback SSRF & metadata blocking', () => {
    it('rejects cloud metadata and link-local targets by default', () => {
      const blockedUrls = [
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.170.2/v2/credentials',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://[fd00:ec2::254]/',
        'http://[fe80::1]/',
        'http://0.0.0.0:8000/hook',
        'http://[::ffff:169.254.169.254]/',
      ];

      for (const url of blockedUrls) {
        const res = validateCallbackConfig({ url });
        expect(res.valid).toBe(false);
        expect(res.error).toMatch(/blocked host/i);
      }
    });

    it('allows 127.0.0.1 by default for local bot compatibility', () => {
      const res = validateCallbackConfig({ url: 'http://127.0.0.1:8080/hook' });
      expect(res.valid).toBe(true);
      expect(res.config?.url).toBe('http://127.0.0.1:8080/hook');
    });

    it('rejects private IPs and localhost when blockPrivateIp is true', () => {
      const privateUrls = [
        'http://127.0.0.1:8080/hook',
        'http://10.0.0.5/hook',
        'http://192.168.1.10/hook',
        'http://172.16.0.1/hook',
        'http://[::1]:8080/hook',
        'http://localhost:8080/hook',
      ];

      for (const url of privateUrls) {
        const res = validateCallbackConfig({ url }, { blockPrivateIp: true });
        expect(res.valid).toBe(false);
        expect(res.error).toMatch(/blocked host/i);
      }
    });

    it('isBlockedCallbackHost rejects cloud metadata IPs even when passed resolved IP strings directly', () => {
      expect(isBlockedCallbackHost('169.254.169.254')).not.toBeNull();
      expect(isBlockedCallbackHost('0.0.0.0')).not.toBeNull();
      expect(isBlockedCallbackHost('fe80::1')).not.toBeNull();
      expect(isBlockedCallbackHost('fd00:ec2::254')).not.toBeNull();
      expect(isBlockedCallbackHost('::ffff:169.254.169.254')).not.toBeNull();
      expect(isBlockedCallbackHost('8.8.8.8')).toBeNull();
    });

    it('rejects trailing dot and IPv6 zone ID bypass attempts', () => {
      expect(isBlockedCallbackHost('metadata.google.internal.')).not.toBeNull();
      expect(isBlockedCallbackHost('metadata.goog.')).not.toBeNull();
      expect(isBlockedCallbackHost('localhost.', true)).not.toBeNull();
      expect(isBlockedCallbackHost('fe80::1%eth0')).not.toBeNull();
      expect(isBlockedCallbackHost('169.254.169.254.')).not.toBeNull();
    });
  });
});
