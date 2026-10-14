# Security and Permissions Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `gt-hub` against security risks by enforcing production secret key checks, eliminating long-lived credentials from URLs via short-lived one-time tickets, and establishing Agent execution boundaries with `--permission-mode <default | bypass>`.

**Architecture:**
- Introduce a startup security validator that strictly rejects empty `GT_KEY` in `NODE_ENV=production` unless explicitly overridden via `GT_ALLOW_INSECURE_NO_AUTH=true`.
- Implement an in-memory, single-use, 30-second Auth Ticket Manager with `POST /api/auth/ticket` endpoint to authenticate browser WebSockets and SSE log streams without URL credential leakage.
- Implement an Agent `PathGuard` supporting `default` (sensitive path blacklist + optional workspace boundary) and `bypass` (unrestricted access) modes via `--permission-mode <default | bypass>`.
- Update frontend connection lifecycles to mint fresh tickets for initial connects and reconnects.

**Tech Stack:** Node.js, TypeScript, Express, WebSocket (`ws`), React 18, Jest, crypto (`randomBytes`, `timingSafeEqual`).

**Spec:** `docs/superpowers/specs/2026-10-14-security-and-permissions-hardening-design.md`

## Global Constraints

- Never break backward compatibility for existing `gt` CLI or remote agents connecting via `x-admin-key` HTTP headers.
- Ticket lifetime strictly capped at 30 seconds (`30000ms`); consumed tickets must be deleted immediately upon validation.
- All path checks in Agent `PathGuard` must resolve symlinks via `fs.realpathSync` to prevent symlink bypasses.
- Permission mode parameter must strictly follow `--permission-mode <default | bypass>` and environment variable `GT_PERMISSION_MODE=default|bypass`.
- All automated tests must run clean under `npm test` with `--detectOpenHandles --forceExit`.

## Review Focus

1. **Reconnection Race / Expired Ticket:** When a WebSocket connection disconnects after hours, reconnect logic must mint a new ticket rather than reusing the expired initial ticket.
2. **Symlink Escape in Agent:** Creating or resolving a symlink pointing to `~/.ssh/id_rsa` or `/etc/shadow` must be detected and blocked in `default` mode.
3. **Empty Secret in Production:** Missing or whitespace-only `GT_KEY` when `NODE_ENV=production` must terminate process with exit code 1 unless `GT_ALLOW_INSECURE_NO_AUTH=true`.
4. **Single-Use Ticket Double Spend:** A ticket must fail validation if presented a second time (e.g. concurrent replay attack).
5. **No Long-Lived Key in Browser URLs:** WebSocket URLs and SSE URLs in browser network monitor must contain only `ticket=` and never `x-admin-key=` or `key=`.

---

### Task 1: Production Secret Key Lifecycle Check & Security Config Validator

**Files:**
- Create: `src/server/config/securityValidator.ts`
- Modify: `src/server/index.ts:1-18`
- Test: `tests/securityConfig.test.ts`

**Interfaces:**
- Consumes: `config.adminSecretKey`, `process.env.NODE_ENV`, `process.env.GT_ALLOW_INSECURE_NO_AUTH`
- Produces: `validateSecurityConfig(options?: { nodeEnv?: string; secretKey?: string; allowInsecure?: boolean; exitHandler?: (code: number) => void }): { valid: boolean; warning?: string; error?: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/securityConfig.test.ts`:
```typescript
import { validateSecurityConfig } from '../src/server/config/securityValidator';

describe('validateSecurityConfig', () => {
  it('fails in production mode when secretKey is empty and allowInsecure is not set', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: '',
      allowInsecure: false,
      exitHandler: (code) => { exitCode = code; },
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/GT_KEY is required in production/i);
    expect(exitCode).toBe(1);
  });

  it('allows empty secretKey in production if allowInsecure is true and emits warning', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: '',
      allowInsecure: true,
      exitHandler: (code) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(res.warning).toMatch(/GT_ALLOW_INSECURE_NO_AUTH/i);
    expect(exitCode).toBeNull();
  });

  it('passes in production mode when secretKey is provided', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: 'strong-secret-key',
      allowInsecure: false,
      exitHandler: (code) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(exitCode).toBeNull();
  });

  it('passes in development/test mode even when secretKey is empty', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'development',
      secretKey: '',
      allowInsecure: false,
      exitHandler: (code) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(exitCode).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/securityConfig.test.ts`
Expected: FAIL with "Cannot find module '../src/server/config/securityValidator'"

- [ ] **Step 3: Write minimal implementation**

Create `src/server/config/securityValidator.ts`:
```typescript
import logger from '../../utils/logger';

export interface SecurityValidationOptions {
  nodeEnv?: string;
  secretKey?: string;
  allowInsecure?: boolean;
  exitHandler?: (code: number) => void;
}

export interface SecurityValidationResult {
  valid: boolean;
  warning?: string;
  error?: string;
}

export function validateSecurityConfig(options: SecurityValidationOptions = {}): SecurityValidationResult {
  const nodeEnv = options.nodeEnv !== undefined ? options.nodeEnv : process.env.NODE_ENV;
  const secretKey = (options.secretKey !== undefined ? options.secretKey : (process.env.GT_KEY || '')).trim();
  const allowInsecure = options.allowInsecure !== undefined
    ? options.allowInsecure
    : process.env.GT_ALLOW_INSECURE_NO_AUTH === 'true';
  const exitHandler = options.exitHandler || ((code: number) => process.exit(code));

  const isProduction = nodeEnv === 'production';

  if (isProduction && !secretKey) {
    if (allowInsecure) {
      const warning = '[Security] WARNING: Running in production without GT_KEY! Insecure access explicitly enabled via GT_ALLOW_INSECURE_NO_AUTH=true.';
      logger.warn(warning);
      return { valid: true, warning };
    }

    const error = '[Security] FATAL: GT_KEY is required in production mode. Set GT_KEY in your environment, or set GT_ALLOW_INSECURE_NO_AUTH=true to explicitly allow unauthenticated access.';
    logger.error(error);
    exitHandler(1);
    return { valid: false, error };
  }

  return { valid: true };
}
```

Update `src/server/index.ts`:
```typescript
import http from 'http';
import app from './app';
import config from './config/default';
import logger from '../utils/logger';
import { setupTerminalWebSocket } from '../terminal/routes/terminalWs';
import { validateSecurityConfig } from './config/securityValidator';

const server = http.createServer(app);
setupTerminalWebSocket(server);

if (process.env.NODE_ENV !== 'test') {
  validateSecurityConfig({
    secretKey: String(config.adminSecretKey || ''),
  });

  server.listen(config.port, () => {
    logger.info(`gt-hub server is running on port ${config.port}`);
    logger.info(`WebSocket endpoints enabled: /api/terminal/ws, /api/terminal/agent-ws, /api/terminal/exec-ws`);
  });
}

export { server, app };
export default server;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/securityConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/config/securityValidator.ts src/server/index.ts tests/securityConfig.test.ts
git commit -m "feat(security): validate secret key lifecycle on server startup

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: One-Time Auth Ticket Manager & Ticket Minting API

**Files:**
- Create: `src/server/modules/auth/ticketManager.ts`
- Modify: `src/server/modules/auth/authController.ts:1-38`, `src/server/modules/auth/authRoutes.ts:1-10`
- Test: `tests/ticketManager.test.ts`, `tests/authTicketRoutes.test.ts`

**Interfaces:**
- Consumes: `crypto.randomBytes`, `adminAuthMiddleware`
- Produces:
  - `ticketManager.createTicket(metadata?: Record<string, any>, ttlMs?: number): string`
  - `ticketManager.consumeTicket(ticket: string): boolean`
  - `ticketManager.reset(): void`
  - `POST /api/auth/ticket` returning `{ success: boolean, ticket: string, expiresIn: number }`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/ticketManager.test.ts`:
```typescript
import { TicketManager } from '../src/server/modules/auth/ticketManager';

describe('TicketManager', () => {
  let manager: TicketManager;

  beforeEach(() => {
    manager = new TicketManager({ sweepIntervalMs: 0 }); // disable automatic background timer in tests
  });

  afterEach(() => {
    manager.destroy();
  });

  it('generates a 48-character hex ticket and consumes it successfully once', () => {
    const ticket = manager.createTicket();
    expect(ticket).toBeDefined();
    expect(ticket.length).toBe(48);

    // First consumption succeeds
    expect(manager.consumeTicket(ticket)).toBe(true);

    // Second consumption must fail (single-use token)
    expect(manager.consumeTicket(ticket)).toBe(false);
  });

  it('rejects nonexistent or empty tickets', () => {
    expect(manager.consumeTicket('')).toBe(false);
    expect(manager.consumeTicket('non-existent-ticket')).toBe(false);
  });

  it('rejects expired tickets', () => {
    const ticket = manager.createTicket({}, 10); // 10ms TTL
    expect(ticket).toBeDefined();

    // Fast-forward time
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 100;
      expect(manager.consumeTicket(ticket)).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('purges expired tickets on sweep', () => {
    manager.createTicket({}, 10);
    expect(manager.size()).toBe(1);

    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 100;
      manager.sweep();
      expect(manager.size()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
```

Create `tests/authTicketRoutes.test.ts`:
```typescript
import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('POST /api/auth/ticket', () => {
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    ticketManager.reset();
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  it('returns 401 when x-admin-key is missing and auth is required', async () => {
    config.adminSecretKey = 'test-secret-key';
    const res = await request(app).post('/api/auth/ticket');
    expect(res.status).toBe(401);
  });

  it('issues ticket when valid x-admin-key header is provided', async () => {
    config.adminSecretKey = 'test-secret-key';
    const res = await request(app)
      .post('/api/auth/ticket')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.ticket.length).toBe(48);
    expect(res.body.expiresIn).toBe(30);

    // Can be consumed by ticketManager
    expect(ticketManager.consumeTicket(res.body.ticket)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ticketManager.test.ts tests/authTicketRoutes.test.ts`
Expected: FAIL with missing modules/methods.

- [ ] **Step 3: Write implementation**

Create `src/server/modules/auth/ticketManager.ts`:
```typescript
import crypto from 'crypto';

export interface TicketEntry {
  ticket: string;
  createdAt: number;
  expiresAt: number;
  metadata?: Record<string, any>;
}

export interface TicketManagerOptions {
  defaultTtlMs?: number;
  sweepIntervalMs?: number;
}

export class TicketManager {
  private tickets: Map<string, TicketEntry> = new Map();
  private defaultTtlMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: TicketManagerOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs || 30000; // 30s default
    const sweepInterval = options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : 60000;
    if (sweepInterval > 0) {
      this.timer = setInterval(() => this.sweep(), sweepInterval);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  public createTicket(metadata?: Record<string, any>, ttlMs?: number): string {
    const ticket = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const effectiveTtl = ttlMs || this.defaultTtlMs;
    this.tickets.set(ticket, {
      ticket,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      metadata,
    });
    return ticket;
  }

  public consumeTicket(ticket: string): boolean {
    if (!ticket || typeof ticket !== 'string') return false;
    const entry = this.tickets.get(ticket);
    if (!entry) return false;

    // Immediately remove from map (single-use)
    this.tickets.delete(ticket);

    // Validate expiration
    if (Date.now() > entry.expiresAt) {
      return false;
    }
    return true;
  }

  public sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets.entries()) {
      if (now > entry.expiresAt) {
        this.tickets.delete(ticket);
      }
    }
  }

  public size(): number {
    return this.tickets.size;
  }

  public reset(): void {
    this.tickets.clear();
  }

  public destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tickets.clear();
  }
}

export const ticketManager = new TicketManager();
export default ticketManager;
```

Update `src/server/modules/auth/authController.ts`:
```typescript
import { Request, Response } from 'express';
import config from '../../config/default';
import { safeCompareSecret } from '../../../shared/utils/security';
import { ticketManager } from './ticketManager';

export class AuthController {
  static getStatus(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ authRequired: false, authenticated: true });
      return;
    }

    const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
    const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;
    const authenticated = safeCompareSecret(providedKey, secretKey);

    res.status(200).json({
      authRequired: true,
      authenticated,
    });
  }

  static login(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ success: true });
      return;
    }

    const { key } = req.body || {};
    if (safeCompareSecret(key, secretKey)) {
      res.status(200).json({ success: true });
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
    }
  }

  static createTicket(req: Request, res: Response): void {
    const ticket = ticketManager.createTicket();
    res.status(200).json({
      success: true,
      ticket,
      expiresIn: 30,
    });
  }
}
```

Update `src/server/modules/auth/authRoutes.ts`:
```typescript
import { Router } from 'express';
import { AuthController } from './authController';
import adminAuthMiddleware from '../../middlewares/adminAuth';

const router = Router();

router.get('/status', AuthController.getStatus);
router.post('/login', AuthController.login);
router.post('/ticket', adminAuthMiddleware, AuthController.createTicket);

export default router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/ticketManager.test.ts tests/authTicketRoutes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/auth/ticketManager.ts src/server/modules/auth/authController.ts src/server/modules/auth/authRoutes.ts tests/ticketManager.test.ts tests/authTicketRoutes.test.ts
git commit -m "feat(auth): implement single-use auth ticket manager and endpoint

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: WebSocket Handshake & SSE Logs Ticket Authentication

**Files:**
- Modify: `src/terminal/routes/terminalWs.ts:26-42`
- Modify: `src/terminal/controllers/terminalLogController.ts:5-34`
- Test: `tests/terminalWsTicketAuth.test.ts`, `tests/terminalLogTicketAuth.test.ts`

**Interfaces:**
- Consumes: `ticketManager.consumeTicket(ticket)`, `safeCompareSecret()`
- Produces: Support for `?ticket=<ticket>` during upgrade and SSE requests; backward compatibility with headers and query keys.

- [ ] **Step 1: Write the failing tests**

Create `tests/terminalWsTicketAuth.test.ts`:
```typescript
import http from 'http';
import WebSocket from 'ws';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('Terminal WebSocket Ticket Auth', () => {
  let server: http.Server;
  let port: number;
  const originalKey = config.adminSecretKey;

  beforeAll((done) => {
    config.adminSecretKey = 'hub-secret-test';
    server = http.createServer(app);
    setupTerminalWebSocket(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    config.adminSecretKey = originalKey;
    server.close(done);
  });

  beforeEach(() => {
    ticketManager.reset();
  });

  it('accepts connection with valid one-time ticket and consumes it', (done) => {
    const ticket = ticketManager.createTicket();
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?ticket=${ticket}&hostId=test-node`);

    ws.on('open', () => {
      ws.close();
      // Ticket should be consumed now
      expect(ticketManager.consumeTicket(ticket)).toBe(false);
      done();
    });

    ws.on('error', (err) => {
      done(err);
    });
  });

  it('rejects connection with invalid or already consumed ticket', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?ticket=invalid-ticket-123&hostId=test-node`);

    ws.on('open', () => {
      ws.close();
      done(new Error('Should have been rejected'));
    });

    ws.on('error', () => {
      // Expected rejection
      done();
    });
  });

  it('still accepts connection with valid x-admin-key header (CLI compatibility)', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?hostId=test-node`, {
      headers: { 'x-admin-key': 'hub-secret-test' },
    });

    ws.on('open', () => {
      ws.close();
      done();
    });

    ws.on('error', (err) => {
      done(err);
    });
  });
});
```

Create `tests/terminalLogTicketAuth.test.ts`:
```typescript
import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('GET /api/terminal/logs Ticket Auth', () => {
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    config.adminSecretKey = 'hub-secret-test';
    ticketManager.reset();
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  it('accepts SSE request with valid ticket', async () => {
    const ticket = ticketManager.createTicket();
    const res = await request(app)
      .get(`/api/terminal/logs?stream=true&ticket=${ticket}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(ticketManager.consumeTicket(ticket)).toBe(false);
  });

  it('rejects SSE request with invalid ticket when admin key is set', async () => {
    const res = await request(app)
      .get('/api/terminal/logs?stream=true&ticket=invalid-ticket');

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/terminalWsTicketAuth.test.ts tests/terminalLogTicketAuth.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Update `src/terminal/routes/terminalWs.ts`:
Lines 26-42:
```typescript
    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
      const ticketParam = parsedUrl.searchParams.get('ticket');
      let isAuthorized = false;

      // 1. Ticket validation (preferred for browser connections)
      if (ticketParam && ticketManager.consumeTicket(ticketParam)) {
        isAuthorized = true;
      }

      // 2. Header validation (standard for CLI & non-browser clients)
      if (!isAuthorized && req.headers['x-admin-key']) {
        const headerKey = Array.isArray(req.headers['x-admin-key'])
          ? req.headers['x-admin-key'][0]
          : req.headers['x-admin-key'];
        if (safeCompareSecret(headerKey, secretKey)) {
          isAuthorized = true;
        }
      }

      // 3. Fallback query parameter validation (backward compatibility)
      if (!isAuthorized) {
        const queryKey = parsedUrl.searchParams.get('x-admin-key') || parsedUrl.searchParams.get('key');
        if (queryKey && safeCompareSecret(queryKey, secretKey)) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        logger.warn(`[TerminalWS] Unauthorized WebSocket connection attempt rejected (${reqUrl})`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
```
Import `ticketManager` at top of `src/terminal/routes/terminalWs.ts`:
```typescript
import { ticketManager } from '../../server/modules/auth/ticketManager';
```

Update `src/terminal/controllers/terminalLogController.ts`:
Add ticket validation before streaming:
```typescript
import { Request, Response } from 'express';
import terminalLogService from '../services/terminalLogService';
import config from '../../server/config/default';
import { safeCompareSecret } from '../../shared/utils/security';
import { ticketManager } from '../../server/modules/auth/ticketManager';

class TerminalLogController {
  public async getTerminalLogs(req: Request, res: Response): Promise<void> {
    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const ticketParam = req.query.ticket as string | undefined;
      let authorized = false;

      if (ticketParam && ticketManager.consumeTicket(ticketParam)) {
        authorized = true;
      } else {
        const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
        const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;
        if (safeCompareSecret(providedKey, secretKey)) {
          authorized = true;
        }
      }

      if (!authorized) {
        res.status(401).json({ error: 'Unauthorized: Invalid credentials or ticket' });
        return;
      }
    }

    const isStream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const logs = terminalLogService.getHistory();
      res.write('data: ' + JSON.stringify({ type: 'history', logs }) + '\n\n');

      const onLog = (log: any) => {
        res.write('data: ' + JSON.stringify({ type: 'log', log }) + '\n\n');
      };

      terminalLogService.on('log', onLog);

      req.on('close', () => {
        terminalLogService.off('log', onLog);
      });
    } else {
      res.json({ logs: terminalLogService.getHistory() });
    }
  }
}

export const terminalLogController = new TerminalLogController();
export default terminalLogController;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalWsTicketAuth.test.ts tests/terminalLogTicketAuth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/terminal/routes/terminalWs.ts src/terminal/controllers/terminalLogController.ts tests/terminalWsTicketAuth.test.ts tests/terminalLogTicketAuth.test.ts
git commit -m "feat(terminal): support short-lived ticket auth in websocket and logs routes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Agent Path Guard & Permission Modes (`default` vs `bypass`)

**Files:**
- Create: `src/agent/security/pathGuard.ts`
- Modify: `src/agent/handlers/fileRpcHandler.ts:20-105`
- Modify: `src/agent/daemon.ts:285-330`
- Modify: `src/client/index.ts:352-365`
- Test: `tests/agentPathGuard.test.ts`, `tests/agentFileRpcSecurity.test.ts`

**Interfaces:**
- Consumes: `resolveWorkingDir`
- Produces:
  - `checkPathPermission(targetPath: string, mode?: 'default' | 'bypass', workspace?: string): { allowed: boolean; reason?: string }`
  - `--permission-mode <default | bypass>` in `gt agent start`

- [ ] **Step 1: Write the failing tests**

Create `tests/agentPathGuard.test.ts`:
```typescript
import os from 'os';
import path from 'path';
import fs from 'fs';
import { checkPathPermission, PermissionMode } from '../src/agent/security/pathGuard';

describe('Agent PathGuard', () => {
  const home = os.homedir();

  it('blocks SSH keys in default mode', () => {
    const sshPath = path.join(home, '.ssh', 'id_rsa');
    const res = checkPathPermission(sshPath, 'default');
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/sensitive/i);
  });

  it('blocks agent credentials in default mode', () => {
    const configPath = path.join(home, '.gt', 'agent.json');
    const res = checkPathPermission(configPath, 'default');
    expect(res.allowed).toBe(false);
  });

  it('blocks /etc/shadow on unix systems in default mode', () => {
    if (os.platform() !== 'win32') {
      const res = checkPathPermission('/etc/shadow', 'default');
      expect(res.allowed).toBe(false);
    }
  });

  it('allows access to regular user files in default mode without workspace', () => {
    const regularPath = path.join(home, 'documents', 'project', 'file.txt');
    const res = checkPathPermission(regularPath, 'default');
    expect(res.allowed).toBe(true);
  });

  it('enforces workspace boundary when workspace is specified', () => {
    const workspace = path.join(home, 'my-workspace');
    const inside = path.join(workspace, 'sub', 'file.txt');
    const outside = path.join(home, 'other-dir', 'file.txt');

    expect(checkPathPermission(inside, 'default', workspace).allowed).toBe(true);
    const outsideRes = checkPathPermission(outside, 'default', workspace);
    expect(outsideRes.allowed).toBe(false);
    expect(outsideRes.reason).toMatch(/outside workspace/i);
  });

  it('allows all paths in bypass mode', () => {
    const sshPath = path.join(home, '.ssh', 'id_rsa');
    const res = checkPathPermission(sshPath, 'bypass');
    expect(res.allowed).toBe(true);
  });

  it('detects symlink pointing to sensitive path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-symlink-test-'));
    const symlinkPath = path.join(tempDir, 'fake-key');
    const targetPath = path.join(home, '.ssh', 'authorized_keys');

    try {
      fs.symlinkSync(targetPath, symlinkPath);
      const res = checkPathPermission(symlinkPath, 'default');
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/sensitive/i);
    } catch (err: any) {
      if (err.code !== 'EPERM') throw err; // Windows non-admin symlink skip
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });
});
```

Create `tests/agentFileRpcSecurity.test.ts`:
```typescript
import os from 'os';
import path from 'path';
import { handleFileRpc } from '../src/agent/handlers/fileRpcHandler';

describe('handleFileRpc Security Integration', () => {
  it('rejects read request to sensitive path in default mode', async () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');
    let sentMessage = '';
    const mockWs = {
      readyState: 1,
      send: (msg: string) => { sentMessage = msg; },
    };

    await handleFileRpc({
      reqId: 'test-req-1',
      action: 'read',
      path: sshPath,
      permissionMode: 'default',
    }, mockWs);

    expect(sentMessage).toContain('file_rpc_res');
    const data = JSON.parse(sentMessage.slice(5));
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/SecurityException/i);
  });

  it('permits read request in bypass mode', async () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'non_existent_file_xyz');
    let sentMessage = '';
    const mockWs = {
      readyState: 1,
      send: (msg: string) => { sentMessage = msg; },
    };

    await handleFileRpc({
      reqId: 'test-req-2',
      action: 'read',
      path: sshPath,
      permissionMode: 'bypass',
    }, mockWs);

    const data = JSON.parse(sentMessage.slice(5));
    // Should fail with File not found, NOT SecurityException
    expect(data.error).not.toMatch(/SecurityException/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agentPathGuard.test.ts tests/agentFileRpcSecurity.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/agent/security/pathGuard.ts`:
```typescript
import path from 'path';
import fs from 'fs';
import os from 'os';

export type PermissionMode = 'default' | 'bypass';

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
}

export function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function checkPathPermission(
  targetPath: string,
  mode: PermissionMode = 'default',
  workspace?: string
): PathCheckResult {
  if (mode === 'bypass') {
    return { allowed: true };
  }

  const resolved = path.resolve(targetPath);
  const home = os.homedir();

  // Resolve symlinks to target real path if exists
  let realTarget = resolved;
  try {
    if (fs.existsSync(resolved)) {
      realTarget = fs.realpathSync(resolved);
    } else {
      // If target file doesn't exist yet, check real path of closest parent directory
      let parent = path.dirname(resolved);
      while (parent && !fs.existsSync(parent) && parent !== path.dirname(parent)) {
        parent = path.dirname(parent);
      }
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        realTarget = path.join(realParent, path.relative(parent, resolved));
      }
    }
  } catch {
    // Keep resolved if realpath fails
  }

  const pathsToCheck = [resolved, realTarget];

  for (const checkPath of pathsToCheck) {
    // 1. SSH & GPG Keys
    const sshDir = path.join(home, '.ssh');
    if (isSubpath(sshDir, checkPath) || checkPath === sshDir) {
      return { allowed: false, reason: 'Access to sensitive SSH credentials directory is restricted' };
    }
    const gpgDir = path.join(home, '.gnupg');
    if (isSubpath(gpgDir, checkPath) || checkPath === gpgDir) {
      return { allowed: false, reason: 'Access to sensitive GPG credentials directory is restricted' };
    }

    // 2. Agent Config Files
    const gtDir = path.join(home, '.gt');
    const agentJson = path.join(gtDir, 'agent.json');
    const configJson = path.join(gtDir, 'config.json');
    if (checkPath === agentJson || checkPath === configJson) {
      return { allowed: false, reason: 'Modification or inspection of agent credentials is restricted' };
    }

    // 3. Unix system sensitive paths
    if (os.platform() !== 'win32') {
      const sensitiveFiles = [
        '/etc/shadow',
        '/etc/gshadow',
        '/etc/sudoers',
      ];
      for (const f of sensitiveFiles) {
        if (checkPath === f) {
          return { allowed: false, reason: `Access to system sensitive file ${f} is restricted` };
        }
      }
      if (checkPath.startsWith('/etc/sudoers.d') || checkPath.startsWith('/etc/pam.d')) {
        return { allowed: false, reason: 'Access to sudoers or PAM configuration is restricted' };
      }
    }

    // 4. Windows system credentials
    if (os.platform() === 'win32') {
      const lower = checkPath.toLowerCase();
      if (lower.includes('\\system32\\config\\sam') || lower.includes('\\system32\\config\\system')) {
        return { allowed: false, reason: 'Access to Windows system security accounts manager is restricted' };
      }
    }
  }

  // 5. Workspace restriction (if configured)
  if (workspace) {
    const resolvedWorkspace = path.resolve(workspace);
    if (!isSubpath(resolvedWorkspace, resolved) && !isSubpath(resolvedWorkspace, realTarget)) {
      return { allowed: false, reason: `Path "${resolved}" is outside configured workspace "${resolvedWorkspace}"` };
    }
  }

  return { allowed: true };
}
```

Update `src/agent/handlers/fileRpcHandler.ts`:
Wrap file operations with `checkPathPermission`:
```typescript
import fs from 'fs';
import path from 'path';
import { resolveWorkingDir } from '../tasks/taskManager';
import { checkPathPermission, PermissionMode } from '../security/pathGuard';

export async function handleFileRpc(control: any, targetWs: any): Promise<void> {
  const { reqId, action, path: targetPath, params = {}, permissionMode, workspace } = control;
  const reply = (success: boolean, data: any = null, error: string | null = null) => {
    const isOpen = targetWs && (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));
    if (isOpen) {
      targetWs.send(`JSON:${JSON.stringify({
        type: 'file_rpc_res',
        reqId,
        success,
        data,
        error,
      })}`);
    }
  };

  try {
    const resolvedPath = resolveWorkingDir(targetPath);
    const mode: PermissionMode = permissionMode || (process.env.GT_PERMISSION_MODE as PermissionMode) || 'default';
    const effectiveWorkspace = workspace || process.env.GT_AGENT_WORKSPACE;

    const permCheck = checkPathPermission(resolvedPath, mode, effectiveWorkspace);
    if (!permCheck.allowed) {
      return reply(false, null, `SecurityException: ${permCheck.reason}`);
    }

    if (action === 'rename' && params.newPath) {
      const newResolved = resolveWorkingDir(params.newPath);
      const newCheck = checkPathPermission(newResolved, mode, effectiveWorkspace);
      if (!newCheck.allowed) {
        return reply(false, null, `SecurityException: ${newCheck.reason}`);
      }
    }

    // Existing actions (list, read, write, mkdir, rename, delete) follow...
```

Update `src/agent/daemon.ts` and `src/client/index.ts`:
In `src/client/index.ts`:
```typescript
  agentCmd
    .command('start')
    .description('Start the local agent daemon in background')
    .option('-s, --server <url>', 'Override target Hub URL')
    .option('-k, --key <secret>', 'Override Hub admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('-p, --permission-mode <mode>', 'Permission mode: default or bypass', 'default')
    .option('-w, --workspace <path>', 'Restrict file operations to workspace directory')
    .option('--internal-daemon', 'Internal daemon flag')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      const args = ['start'];
      if (opts.permissionMode) args.push(`--permission-mode=${opts.permissionMode}`);
      if (opts.workspace) args.push(`--workspace=${opts.workspace}`);
      if (opts.internalDaemon) args.push('--internal-daemon');
      await runAgent(args, { server: eff.server, key: eff.key, context: eff.context });
    });
```
In `src/agent/daemon.ts`, pass `permissionMode` and `workspace` into options when parsing and into `handleFileRpc`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agentPathGuard.test.ts tests/agentFileRpcSecurity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/security/pathGuard.ts src/agent/handlers/fileRpcHandler.ts src/agent/daemon.ts src/client/index.ts tests/agentPathGuard.test.ts tests/agentFileRpcSecurity.test.ts
git commit -m "feat(agent): implement PathGuard with default and bypass permission modes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Frontend Ticket Integration & Query Key Removal

**Files:**
- Modify: `frontend/src/utils/apiClient.ts`
- Modify: `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/components/TerminalLogsView.tsx`
- Modify: `frontend/src/components/terminal/TerminalFileManagerView.tsx`
- Test: `tests/frontendTicketAuth.test.ts`

**Interfaces:**
- Consumes: `POST /api/auth/ticket`, `apiFetch`
- Produces: `requestAuthTicket(): Promise<string | null>`; WebSocket and SSE queries using `ticket=` instead of `x-admin-key=`.

- [ ] **Step 1: Write the failing tests**

Create `tests/frontendTicketAuth.test.ts`:
```typescript
import { requestAuthTicket } from '../frontend/src/utils/apiClient';

describe('Frontend Auth Ticket Utility', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches ticket from /api/auth/ticket with x-admin-key header', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};

    global.fetch = jest.fn().mockImplementation((url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init?.headers || {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, ticket: 'test-mock-ticket-48char', expiresIn: 30 }),
      });
    });

    const ticket = await requestAuthTicket('my-secret-key');
    expect(ticket).toBe('test-mock-ticket-48char');
    expect(capturedUrl).toContain('/api/auth/ticket');
    expect(capturedHeaders['x-admin-key']).toBe('my-secret-key');
  });

  it('returns null if no secret key is provided and server reports success false/unauthorized', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: false,
        status: 401,
      });
    });

    const ticket = await requestAuthTicket('');
    expect(ticket).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendTicketAuth.test.ts`
Expected: FAIL with "requestAuthTicket is not exported"

- [ ] **Step 3: Write implementation**

Update `frontend/src/utils/apiClient.ts`:
Add `requestAuthTicket`:
```typescript
export async function requestAuthTicket(adminKey?: string): Promise<string | null> {
  const key = adminKey || (typeof window !== 'undefined' ? localStorage.getItem('gt_admin_key') : '') || '';
  try {
    const headers: Record<string, string> = {};
    if (key) {
      headers['x-admin-key'] = key;
    }
    const res = await fetch('/api/auth/ticket', {
      method: 'POST',
      headers,
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data && data.success && data.ticket) {
      return data.ticket;
    }
    return null;
  } catch {
    return null;
  }
}
```

Update `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`:
Use `requestAuthTicket` when establishing WebSocket:
```typescript
    const ticket = adminKey ? await requestAuthTicket(adminKey) : null;
    const ticketParam = ticket ? `ticket=${encodeURIComponent(ticket)}` : (adminKey ? `x-admin-key=${encodeURIComponent(adminKey)}` : '');
    const wsUrl = `${protocol}//${host}/api/terminal/ws?${ticketParam ? ticketParam + '&' : ''}hostId=${encodeURIComponent(activeHostId)}`;
```

Update `frontend/src/components/WebTerminalView.tsx`:
Replace direct `x-admin-key` in WebSocket connection and reconnect with `requestAuthTicket`.

Update `frontend/src/components/TerminalLogsView.tsx`:
```typescript
    const ticket = adminKey ? await requestAuthTicket(adminKey) : null;
    const ticketParam = ticket ? `&ticket=${encodeURIComponent(ticket)}` : (adminKey ? `&x-admin-key=${encodeURIComponent(adminKey)}` : '');
    const streamUrl = `/api/terminal/logs?stream=true${ticketParam}`;
    const es = new EventSource(streamUrl);
```

Update `frontend/src/components/terminal/TerminalFileManagerView.tsx`:
For file downloads:
```typescript
    const ticket = adminKey ? await requestAuthTicket(adminKey) : null;
    if (ticket) {
      params.set('ticket', ticket);
      params.delete('x-admin-key');
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/frontendTicketAuth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/apiClient.ts frontend/src/components/terminal/hooks/useTerminalWebSocket.ts frontend/src/components/WebTerminalView.tsx frontend/src/components/TerminalLogsView.tsx frontend/src/components/terminal/TerminalFileManagerView.tsx tests/frontendTicketAuth.test.ts
git commit -m "feat(frontend): integrate short-lived ticket auth and remove keys from urls

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Full Verification, Test Suites & Production Build

**Files:**
- Verify: all test suites
- Build: frontend, backend, CLI bundle

- [ ] **Step 1: Run complete test suite**

Run: `npm test`
Expected: PASS with 116+ passed test suites, 0 failed.

- [ ] **Step 2: Run complete production build**

Run: `npm run build`
Expected:
1. `version:gen` succeeds.
2. `build:frontend` succeeds via Vite & tsc.
3. `build:backend` succeeds via tsc.
4. `build:gt` bundles `dist/gt.js`.

- [ ] **Step 3: Commit build verification**

```bash
git commit --allow-empty -m "chore: verify test suites and production build for security hardening

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
