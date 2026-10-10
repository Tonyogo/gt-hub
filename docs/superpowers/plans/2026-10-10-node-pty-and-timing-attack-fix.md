# Node-pty Build Fix & Timing Attack Security Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `node-pty` native build issues in `terminalService` so that all unit tests pass, and replace string equality comparisons in all authentication paths with constant-time comparisons using `crypto.timingSafeEqual` to prevent timing attacks.

**Architecture:** 
1. Allow `node-pty` script execution in `package.json` and wrap `node-pty` loading in `terminalService.ts` with lazy/dynamic resolution and descriptive error reporting to prevent module-level import crashes in environments lacking C++ bindings.
2. Introduce a dedicated `src/shared/utils/security.ts` module providing a SHA-256 fixed-length digest comparison via `crypto.timingSafeEqual`.
3. Refactor all authentication guards (`adminAuthMiddleware`, `AuthController.getStatus`, `AuthController.login`, and WebSocket upgrade in `terminalWs.ts`) to use `safeCompareSecret`.

**Tech Stack:** Node.js, TypeScript, Express, ws, Jest, Node.js built-in `crypto`.

**Spec:** In-chat bounded design agreed with user.

## Global Constraints

- Preserve complete backward compatibility for unauthenticated / empty `GT_KEY` development mode.
- Maintain existing query parameter compatibility (`x-admin-key`, `key`) while eliminating timing attack vulnerabilities.
- Zero extra external runtime dependencies (use Node.js built-in `crypto`).
- All 99+ test suites must pass (100% test success rate on `npm test`).

## Review Focus

1. **Undefined/Non-string Key Inputs**: Request headers or query parameters could be string arrays or undefined; `safeCompareSecret` must handle non-string types safely without throwing TypeError.
2. **Empty Expected Secret (Dev Mode)**: When `config.adminSecretKey` is empty or unset, all requests should be authorized without attempting `timingSafeEqual`.
3. **Different Length Secrets**: Direct `crypto.timingSafeEqual` throws an exception if buffers have different lengths; hashing both inputs with SHA-256 first guarantees identical 32-byte buffer length.
4. **Environment without C++ compiler**: `terminalService.ts` must fail gracefully with an informative error when `spawnTerminalSession` is invoked, rather than crashing at import time.
5. **WebSocket Upgrade Rejection**: WebSocket connections with mismatched keys must be safely terminated without leaking timing or socket resources.

---

### Task 1: Fix `node-pty` Native Build & Lazy Loading in `terminalService.ts`

**Files:**
- Modify: `package.json`
- Modify: `src/terminal/services/terminalService.ts:1-100`
- Test: `tests/terminalService.test.ts`
- Test: `tests/terminalZshEolEnv.test.ts`

**Interfaces:**
- Produces: `spawnTerminalSession(options?: TerminalSessionOptions): pty.IPty`
- Produces: `getDefaultShell(): string`

- [x] **Step 1: Update `package.json` with `allowScripts` configuration**

In `package.json`, ensure `node-pty` install script is permitted under `allowScripts`:
```json
  "allowScripts": {
    "node-pty@1.1.0": true
  }
```

- [x] **Step 2: Update `src/terminal/services/terminalService.ts` with lazy/safe loading**

Refactor `src/terminal/services/terminalService.ts` to replace top-level `import * as pty from 'node-pty'` with a lazy loader helper:
```typescript
let _cachedNodePty: any = null;

export function getNodePty(): any {
  if (_cachedNodePty) return _cachedNodePty;
  try {
    _cachedNodePty = require('node-pty');
    return _cachedNodePty;
  } catch (err: any) {
    throw new Error(
      `Failed to load native node-pty module. Please run 'npm rebuild node-pty'. Original error: ${err.message}`
    );
  }
}
```
And inside `spawnTerminalSession`:
```typescript
  const pty = getNodePty();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  return ptyProcess;
```

- [x] **Step 3: Run target tests to verify both pass**

Run: `npx jest tests/terminalService.test.ts tests/terminalZshEolEnv.test.ts`
Expected: PASS for both test suites.

- [x] **Step 4: Commit changes**

```bash
git add package.json src/terminal/services/terminalService.ts
git commit -m "fix(terminal): allow node-pty build and lazily load native pty module"
```

---

### Task 2: Implement Constant-Time Secret Comparison Utility

**Files:**
- Create: `src/shared/utils/security.ts`
- Create: `tests/securityTimingSafe.test.ts`

**Interfaces:**
- Produces: `safeCompareSecret(provided: unknown, expected: unknown): boolean`

- [x] **Step 1: Write unit tests for `safeCompareSecret`**

Create `tests/securityTimingSafe.test.ts`:
```typescript
import { safeCompareSecret } from '../src/shared/utils/security';

describe('safeCompareSecret', () => {
  it('returns true when expected secret is empty or unset (dev mode)', () => {
    expect(safeCompareSecret('any-key', '')).toBe(true);
    expect(safeCompareSecret('', '')).toBe(true);
    expect(safeCompareSecret(undefined, '')).toBe(true);
    expect(safeCompareSecret(null, '')).toBe(true);
  });

  it('returns true when provided secret exactly matches expected secret', () => {
    expect(safeCompareSecret('my-secret-key-123', 'my-secret-key-123')).toBe(true);
    expect(safeCompareSecret('k', 'k')).toBe(true);
  });

  it('returns false when provided secret does not match', () => {
    expect(safeCompareSecret('wrong-key', 'my-secret-key-123')).toBe(false);
    expect(safeCompareSecret('my-secret-key-124', 'my-secret-key-123')).toBe(false);
  });

  it('returns false when provided secret has different length', () => {
    expect(safeCompareSecret('short', 'much-longer-secret-key')).toBe(false);
    expect(safeCompareSecret('much-longer-secret-key', 'short')).toBe(false);
  });

  it('returns false when provided secret is invalid type', () => {
    expect(safeCompareSecret(undefined, 'my-secret')).toBe(false);
    expect(safeCompareSecret(null, 'my-secret')).toBe(false);
    expect(safeCompareSecret(12345, 'my-secret')).toBe(false);
    expect(safeCompareSecret(['key'], 'my-secret')).toBe(false);
    expect(safeCompareSecret({}, 'my-secret')).toBe(false);
  });

  it('returns false when expected is not a string but non-empty', () => {
    expect(safeCompareSecret('test', null)).toBe(false);
    expect(safeCompareSecret('test', undefined)).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails before implementation**

Run: `npx jest tests/securityTimingSafe.test.ts`
Expected: FAIL with "Cannot find module '../src/shared/utils/security'".

- [x] **Step 3: Implement `safeCompareSecret` in `src/shared/utils/security.ts`**

Create `src/shared/utils/security.ts`:
```typescript
import crypto from 'crypto';

/**
 * Performs a constant-time comparison of two secrets to prevent timing attacks.
 * Uses SHA-256 digests to ensure buffers passed to crypto.timingSafeEqual
 * always have identical lengths (32 bytes), regardless of input lengths.
 *
 * If expected is empty or not provided, auth is considered disabled and returns true.
 */
export function safeCompareSecret(provided: unknown, expected: unknown): boolean {
  if (expected === '' || expected === undefined || expected === null) {
    return true;
  }

  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }

  const hashA = crypto.createHash('sha256').update(provided).digest();
  const hashB = crypto.createHash('sha256').update(expected).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/securityTimingSafe.test.ts`
Expected: PASS with 6 passing tests.

- [x] **Step 5: Commit changes**

```bash
git add src/shared/utils/security.ts tests/securityTimingSafe.test.ts
git commit -m "feat(security): implement timing-safe secret comparison utility"
```

---

### Task 3: Apply `safeCompareSecret` to Authentication Endpoints and Middleware

**Files:**
- Modify: `src/server/middlewares/adminAuth.ts`
- Modify: `src/server/modules/auth/authController.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Test: `tests/authRoutes.test.ts`
- Test: `tests/terminalAuthGuardIntegration.test.ts`

**Interfaces:**
- Consumes: `safeCompareSecret(provided: unknown, expected: unknown): boolean` from `src/shared/utils/security`

- [x] **Step 1: Update `src/server/middlewares/adminAuth.ts`**

Update `adminAuthMiddleware`:
```typescript
import { Request, Response, NextFunction } from 'express';
import config from '../config/default';
import { safeCompareSecret } from '../../shared/utils/security';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secretKey = config.adminSecretKey;

  if (!secretKey) {
    return next();
  }

  const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
  const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;

  if (!safeCompareSecret(providedKey, secretKey)) {
    res.status(401).json({ error: 'Unauthorized: Invalid x-admin-key' });
    return;
  }

  next();
}

export default adminAuthMiddleware;
```

- [x] **Step 2: Update `src/server/modules/auth/authController.ts`**

Update `AuthController`:
```typescript
import { Request, Response } from 'express';
import config from '../../config/default';
import { safeCompareSecret } from '../../../shared/utils/security';

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
}
```

- [x] **Step 3: Update `src/terminal/routes/terminalWs.ts`**

In `src/terminal/routes/terminalWs.ts`, import `safeCompareSecret` and replace the upgrade check:
```typescript
import { safeCompareSecret } from '../../shared/utils/security';
...
    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
      const rawProvidedKey =
        req.headers['x-admin-key'] ||
        parsedUrl.searchParams.get('x-admin-key') ||
        parsedUrl.searchParams.get('key');
      const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;

      if (!safeCompareSecret(providedKey, secretKey)) {
        logger.warn(`[TerminalWS] Unauthorized WebSocket connection attempt rejected (${reqUrl})`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
```

- [x] **Step 4: Run auth integration tests**

Run: `npx jest tests/authRoutes.test.ts tests/terminalAuthGuardIntegration.test.ts tests/terminalWs.test.ts`
Expected: PASS for all auth and WS tests.

- [x] **Step 5: Commit changes**

```bash
git add src/server/middlewares/adminAuth.ts src/server/modules/auth/authController.ts src/terminal/routes/terminalWs.ts
git commit -m "fix(auth): protect against timing attacks using constant-time key comparisons"
```

---

### Task 4: Complete Validation & Build Check

**Files:**
- Test all suites
- Check TypeScript build & bundle

- [x] **Step 1: Run the full Jest test suite**

Run: `npm test`
Expected: 100% PASS on all suites (previously 2 failed, now 0 failed).

- [x] **Step 2: Run backend & CLI build**

Run: `npm run build:backend && npm run build:gt`
Expected: Clean exit code 0 with version metadata correctly generated.

- [x] **Step 3: Verify clean git status**

Run: `git status`
Expected: Clean working tree on branch `main`.
