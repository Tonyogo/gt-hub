# gt Script Port Alignment and Error Exit Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `scripts/gt.js` default server URL and help documentation with the Hub backend port (`8000`), introduce centralized error exit handling, and add regression tests.

**Architecture:**
- Define `DEFAULT_SERVER_URL = 'http://localhost:8000'` in `scripts/gt.js`.
- Replace legacy `3000` port occurrences in CLI help documentation and `ConfigStore.getEffectiveConfig()` default fallback.
- Standardize error formatting and exit operations via `exitWithError(message, code)`.
- Add regression tests in `tests/gtConfig.test.ts` to assert that default resolution without config or env produces `http://localhost:8000` and `--help` displays `http://localhost:8000`.

**Tech Stack:** Node.js, JavaScript, TypeScript, Jest.

**Spec:** In-chat approved bounded design for Phase 1 (Port Alignment and Error Exit Normalization).

## Global Constraints

- Do not break backward compatibility with existing `TERMINAL_SERVER`, `GEMINI_PROXY_URL`, or `ADMIN_SECRET_KEY` environment variables.
- Maintain exact stderr outputs expected by existing regression tests (e.g. `tests/gtCli.test.ts`, `tests/gtAgentDaemon.test.ts`).
- All 89 Jest test suites (533+ tests) must pass cleanly after changes.

## Review Focus

1. **Clean environment without config or env vars**: When neither `TERMINAL_SERVER` nor `~/.gt/config.json` exists, `gt` must connect to `http://localhost:8000` instead of `3000`.
2. **Help output consistency**: `gt --help` and `gt -h` must display `http://localhost:8000` in both options description and examples.
3. **Explicit CLI override precedence**: `--server <url>` or `-s <url>` must continue to override the default `http://localhost:8000`.
4. **Environment variable precedence**: `TERMINAL_SERVER` and `GEMINI_PROXY_URL` must continue to take precedence over the default `http://localhost:8000`.
5. **No unintended process exits in required modules**: `exitWithError` must cleanly exit with the provided status code without side effects.

---

### Task 1: Update Default Server Port and Help Output in `scripts/gt.js`

**Files:**
- Modify: `scripts/gt.js:150-250`, `scripts/gt.js:965-985`
- Test: `tests/gtConfig.test.ts`

**Interfaces:**
- Produces: `DEFAULT_SERVER_URL` constant (`'http://localhost:8000'`), updated `printHelp()`, updated `ConfigStore.getEffectiveConfig()`, `exitWithError()`.
- Consumes: `ConfigStore`, `process.env`.

- [x] **Step 1: Define `DEFAULT_SERVER_URL` and `exitWithError` in `scripts/gt.js`**

Add near `VERSION`:
```javascript
const DEFAULT_SERVER_URL = 'http://localhost:8000';

function exitWithError(message, code = 1) {
  console.error(message.startsWith('Error:') || message.startsWith('[Error]') ? message : `Error: ${message}`);
  process.exit(code);
}
```

- [x] **Step 2: Update `printHelp` in `scripts/gt.js`**

Replace occurrences of `http://localhost:3000` in `printHelp()`:
```javascript
  -s, --server <url>              Hub server URL (Default: env TERMINAL_SERVER or http://localhost:8000)
```
and under `Examples:`:
```javascript
  gt login http://localhost:8000 secret
```

- [x] **Step 3: Update `ConfigStore.getEffectiveConfig` in `scripts/gt.js`**

In `ConfigStore.getEffectiveConfig(cliOpts = {})`:
```javascript
    const server = (cliOpts && cliOpts.server) ||
      process.env.TERMINAL_SERVER ||
      process.env.GEMINI_PROXY_URL ||
      stored.server ||
      DEFAULT_SERVER_URL;
```

- [x] **Step 4: Verify syntax and help output**

Run:
```bash
node -c scripts/gt.js
node scripts/gt.js --help | grep "8000"
```
Expected: Help menu prints `http://localhost:8000` in options and examples without syntax errors.

---

### Task 2: Add Regression Tests in `tests/gtConfig.test.ts`

**Files:**
- Modify: `tests/gtConfig.test.ts`

**Interfaces:**
- Produces: Regression tests for default server URL and help output.
- Consumes: `scripts/gt.js` CLI execution via `execFile`.

- [x] **Step 1: Write test cases in `tests/gtConfig.test.ts`**

Add to `tests/gtConfig.test.ts`:
```typescript
  it('displays default server port 8000 in help menu', async () => {
    const res = await runGt(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('http://localhost:8000');
    expect(res.stdout).not.toContain('http://localhost:3000');
  });

  it('defaults effective server to port 8000 when unconfigured', async () => {
    // In an isolated execution without stored server or env var
    const checkScript = `
      const gt = require('${gtPath.replace(/\\/g, '/')}');
      const { server } = gt.ConfigStore.getEffectiveConfig();
      console.log('EFFECTIVE_SERVER=' + server);
    `;
    const res = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile('node', ['-e', checkScript], {
        env: {
          ...process.env,
          TERMINAL_SERVER: '',
          GEMINI_PROXY_URL: '',
          GT_CONFIG_DIR: path.join(os.tmpdir(), 'empty-gt-config-' + Date.now()),
        },
      }, (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
        });
      });
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('EFFECTIVE_SERVER=http://localhost:8000');
  });
```

- [x] **Step 2: Run `tests/gtConfig.test.ts`**

Run:
```bash
npx jest tests/gtConfig.test.ts
```
Expected: PASS with all tests passing.

---

### Task 3: Full Test Suite Verification & Commit

**Files:**
- Verify: `tests/*.test.ts`

- [x] **Step 1: Run full test suite**

Run:
```bash
npm test
```
Expected: 89 passed, 89 total.

- [x] **Step 2: Commit changes**

```bash
git add scripts/gt.js tests/gtConfig.test.ts docs/superpowers/plans/2026-10-09-gt-script-port-and-error-handling.md
git commit -m "fix(gt): align default hub port to 8000 and normalize error exit handling"
```

