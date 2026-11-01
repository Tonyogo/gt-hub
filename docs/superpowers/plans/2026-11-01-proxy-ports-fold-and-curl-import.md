# Network Proxy Single-Row Port Folding & cURL Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance `TerminalProxyView` so that (1) discovered listening ports wrap and collapse to a single row by default when overflowing with an expand/collapse toggle, and (2) the HTTP Request Debugger supports pasting/importing copied `curl` commands into Method, URL, Headers, Body, and TLS Insecure fields.

**Architecture:** Extract a pure, unit-testable `parseCurlCommand(raw: string): ParsedCurlRequest | null` utility in `frontend/src/utils/curlParser.ts` that handles shell quoting (`'...'`, `"..."`, `$'...'`), multiline continuations (`\`, `^`), methods (`-X`, `-I`, `-G`), headers (`-H`, `-A`, `-e`, `-b`, `-u`), payloads (`-d`, `--data*`, `--json`), and `-k`/`--insecure`. In `TerminalProxyView.tsx`, add single-row height clamping (`max-h-[30px] overflow-hidden`) with `ResizeObserver` overflow detection (`scrollHeight > clientHeight + 4`) for listening ports, plus dual-entry cURL import (direct paste into URL input and a collapsible "Import cURL" panel).

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Jest

**Spec:** In-chat bounded design approved in session (2026-11-01)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/curlParser.test.ts tests/proxyUi.test.ts`
- Supported HTTP debugger methods in `TerminalProxyView`: `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'`
- Preserve all existing `data-testid` attributes in `TerminalProxyView.tsx`
- Listening ports must default to collapsed (`isPortsExpanded = false`) and reset to collapsed when `activeHostId` changes

## Review Focus

- Chrome DevTools "Copy as cURL (bash)" uses `$'...'` ANSI-C quoting with `\n` / `\'` escapes and `\` line continuations; `parseCurlCommand` must unescape these accurately
- Windows CMD "Copy as cURL (cmd)" uses `^` line continuations and escaped `\"`; `parseCurlCommand` should strip `^` continuations cleanly
- When a `curl` command includes `-d` / `--data-raw` / `--json` without an explicit `-X` / `--request`, `method` must default to `'POST'` (unless `-G` / `--get` is also present)
- Multiple `-d` flags in a single `curl` command should be joined with `&`, and valid JSON bodies should be pretty-printed with `JSON.stringify(parsed, null, 2)`
- Pasting a regular `http://` or `https://` URL into the URL input must NOT be intercepted by the cURL paste handler (`isCurlCommandText` only triggers when input starts with `curl `)

---

### Task 1: Create `curlParser.ts` Utility & Unit Tests

**Files:**
- Create: `frontend/src/utils/curlParser.ts`
- Test: `tests/curlParser.test.ts`

**Interfaces:**
- Produces:
  - `export interface ParsedCurlRequest { method: string; url: string; headers: Record<string, string>; body: string; insecure: boolean; }`
  - `export function isCurlCommandText(input: string): boolean`
  - `export function parseCurlCommand(raw: string): ParsedCurlRequest | null`

- [x] **Step 1: Write the failing unit tests in `tests/curlParser.test.ts`**

Create `tests/curlParser.test.ts` covering standard cURL flags, Chrome DevTools `$'...'` multiline syntax, implicit POST on data flags, Basic Auth `-u`, `--json`, `-k`/`--insecure`, and non-curl rejection:

```typescript
import { isCurlCommandText, parseCurlCommand } from '../frontend/src/utils/curlParser';

describe('curlParser utility', () => {
  it('identifies valid curl command strings via isCurlCommandText', () => {
    expect(isCurlCommandText('curl https://api.example.com/v1')).toBe(true);
    expect(isCurlCommandText('  curl -X POST http://127.0.0.1:8080/login ')).toBe(true);
    expect(isCurlCommandText('curl.exe "http://localhost:3000"')).toBe(true);
    expect(isCurlCommandText('http://127.0.0.1:3000/api')).toBe(false);
    expect(isCurlCommandText('')).toBe(false);
  });

  it('parses Chrome DevTools multiline bash curl with ANSI-C $ quoting, headers, body, and --insecure', () => {
    const cmd = `curl 'https://127.0.0.1:8443/api/v1/tasks' \\
  -H 'Accept: application/json' \\
  -H $'Content-Type: application/json; charset=UTF-8' \\
  -H 'Authorization: Bearer secret-token' \\
  --data-raw $'{"name":"demo","count":3}' \\
  --compressed \\
  --insecure`;

    const parsed = parseCurlCommand(cmd);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('POST');
    expect(parsed!.url).toBe('https://127.0.0.1:8443/api/v1/tasks');
    expect(parsed!.insecure).toBe(true);
    expect(parsed!.headers['Accept']).toBe('application/json');
    expect(parsed!.headers['Content-Type']).toBe('application/json; charset=UTF-8');
    expect(parsed!.headers['Authorization']).toBe('Bearer secret-token');
    expect(JSON.parse(parsed!.body)).toEqual({ name: 'demo', count: 3 });
  });

  it('parses explicit -X/--request, -I/--head, -u Basic auth, -b cookie, -A user-agent, and --json', () => {
    const putCmd = `curl -X PUT --url "http://localhost:3000/items/42" -u admin:123456 -A "CustomAgent/1.0" -b "sid=abc" -d "status=active" -k`;
    const parsedPut = parseCurlCommand(putCmd);
    expect(parsedPut).not.toBeNull();
    expect(parsedPut!.method).toBe('PUT');
    expect(parsedPut!.url).toBe('http://localhost:3000/items/42');
    expect(parsedPut!.insecure).toBe(true);
    expect(parsedPut!.headers['User-Agent']).toBe('CustomAgent/1.0');
    expect(parsedPut!.headers['Cookie']).toBe('sid=abc');
    expect(parsedPut!.headers['Authorization']).toBe(`Basic ${Buffer.from('admin:123456').toString('base64')}`);
    expect(parsedPut!.body).toBe('status=active');

    const headCmd = `curl -I https://example.com/health`;
    const parsedHead = parseCurlCommand(headCmd);
    expect(parsedHead?.method).toBe('HEAD');
    expect(parsedHead?.url).toBe('https://example.com/health');

    const jsonCmd = `curl --json '{"hello":"world"}' http://localhost:4000/webhook`;
    const parsedJson = parseCurlCommand(jsonCmd);
    expect(parsedJson?.method).toBe('POST');
    expect(parsedJson?.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(parsedJson!.body)).toEqual({ hello: 'world' });
  });

  it('handles Windows CMD ^ line continuations and returns null on non-curl or URL-less input', () => {
    const winCmd = `curl "http://127.0.0.1:8000/api" ^\r\n  -H "X-Test: 1"`;
    const parsed = parseCurlCommand(winCmd);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('http://127.0.0.1:8000/api');
    expect(parsed!.headers['X-Test']).toBe('1');

    expect(parseCurlCommand('not a curl command')).toBeNull();
    expect(parseCurlCommand('curl -X POST')).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/curlParser.test.ts`
Expected: FAIL with `Cannot find module '../frontend/src/utils/curlParser'`

- [x] **Step 3: Implement `frontend/src/utils/curlParser.ts`**

Implement `isCurlCommandText` and `parseCurlCommand` in `frontend/src/utils/curlParser.ts`:
- `isCurlCommandText(input: string): boolean`: returns `true` when `input.trim()` matches `/^curl(?:\.exe)?\s+/i`.
- Shell tokenizer supporting:
  - Backslash `\` + newline and Windows `^` + newline continuations outside single quotes
  - Single-quoted strings `'...'` (literal)
  - Double-quoted strings `"..."` (unescaping `\"`, `\\`, `\$`, `` \` ``)
  - ANSI-C `$'...'` strings (unescaping `\n`, `\r`, `\t`, `\'`, `\"`, `\\`, `\xHH`, `\uHHHH`)
- Flag extraction:
  - `-X` / `--request` (or attached `-XPOST`), `--request=<METHOD>`
  - `-H` / `--header`, `--header=<HEADER>`
  - `-d` / `--data` / `--data-raw` / `--data-ascii` / `--data-binary` / `--data-urlencode`
  - `--json` (adds `Content-Type: application/json` and `Accept: application/json` if not already set, appends body)
  - `-u` / `--user` (encodes Basic auth via `btoa` or `Buffer.from(...).toString('base64')`)
  - `-A` / `--user-agent`, `-e` / `--referer`, `-b` / `--cookie`
  - `-I` / `--head` -> `HEAD`, `-G` / `--get` -> `GET`
  - `-k` / `--insecure` -> `insecure = true`
  - `--url` -> target URL
  - Ignore no-arg flags like `-s`, `-S`, `-v`, `-i`, `-L`, `--location`, `--compressed`, `--globoff`
  - Skip 1-arg flags like `-o`, `--output`, `-w`, `--write-out`, `-m`, `--max-time`, `--connect-timeout`, `-x`, `--proxy`, `--cacert`, `--cert`, `--key`
  - If URL lacks `http://` or `https://` protocol, prepend `http://`
  - Format body with `JSON.stringify(JSON.parse(body), null, 2)` if valid JSON

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/curlParser.test.ts`
Expected: PASS

---

### Task 2: Add Single-Row Port Folding & cURL Import UI in `TerminalProxyView`

**Files:**
- Modify: `frontend/src/i18n/locales/zh.ts:435-472`
- Modify: `frontend/src/i18n/locales/en.ts:433-470`
- Modify: `frontend/src/components/terminal/TerminalProxyView.tsx`
- Test: `tests/proxyUi.test.ts`

**Interfaces:**
- Consumes: `isCurlCommandText`, `parseCurlCommand` from `../../utils/curlParser`
- Produces:
  - Single-row port folding container with `ref={portsContainerRef}`, `max-h-[30px] overflow-hidden` when collapsed, and toggle button `data-testid="proxy-ports-expand-btn"`
  - HTTP Request Debugger cURL import toggle button `data-testid="proxy-import-curl-btn"`, collapsible panel with textarea `data-testid="proxy-curl-input"` and confirm button `data-testid="proxy-curl-apply-btn"`, plus direct `onPaste` auto-import on `data-testid="proxy-request-url-input"`

- [x] **Step 1: Write the failing test in `tests/proxyUi.test.ts`**

Add assertions to `tests/proxyUi.test.ts`:

```typescript
  it('verifies TerminalProxyView.tsx implements single-row port folding and cURL import in HTTP debugger', () => {
    const content = fs.readFileSync(proxyViewPath, 'utf-8');

    // Single-row port folding
    expect(content).toContain('isPortsExpanded');
    expect(content).toContain('isPortsOverflowing');
    expect(content).toContain('portsContainerRef');
    expect(content).toContain('data-testid="proxy-ports-expand-btn"');
    expect(content).toContain('max-h-[30px]');

    // cURL paste & import in HTTP Request Debugger
    expect(content).toContain('parseCurlCommand');
    expect(content).toContain('isCurlCommandText');
    expect(content).toContain('data-testid="proxy-import-curl-btn"');
    expect(content).toContain('data-testid="proxy-curl-input"');
    expect(content).toContain('data-testid="proxy-curl-apply-btn"');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyUi.test.ts`
Expected: FAIL with missing `isPortsExpanded` / `data-testid="proxy-ports-expand-btn"`

- [x] **Step 3: Add locale keys and implement port folding & cURL import in `TerminalProxyView.tsx`**

1. In `frontend/src/i18n/locales/zh.ts` and `en.ts` under `proxy`, add:
   - `expandPorts`: `'展开全部'` / `'Show All'`
   - `collapsePorts`: `'收起'` / `'Collapse'`
   - `importCurl`: `'导入 cURL'` / `'Import cURL'`
   - `curlPlaceholder`: `'粘贴复制的 curl 命令 (支持浏览器 DevTools / Postman 多行格式)...'` / `'Paste copied curl command here (supports DevTools / Postman multiline format)...'`
   - `parseCurlBtn`: `'解析并填入'` / `'Parse & Fill'`
   - `curlImported`: `'已从 cURL 导入请求配置'` / `'Imported request from cURL'`
   - `curlParseError`: `'无法解析 cURL 命令，请检查格式'` / `'Failed to parse cURL command'`
2. In `frontend/src/components/terminal/TerminalProxyView.tsx`:
   - Import `isCurlCommandText, parseCurlCommand` from `../../utils/curlParser`.
   - Add state for port folding:
     ```tsx
     const [isPortsExpanded, setIsPortsExpanded] = useState<boolean>(false);
     const [isPortsOverflowing, setIsPortsOverflowing] = useState<boolean>(false);
     const portsContainerRef = useRef<HTMLDivElement>(null);
     ```
   - Reset `setIsPortsExpanded(false)` when `activeHostId` changes.
   - Add a `useEffect` that measures `portsContainerRef.current` via `ResizeObserver` and whenever `listeningPorts` or `isPortsExpanded` changes:
     When `!isPortsExpanded`, set `isPortsOverflowing(el.scrollHeight > el.clientHeight + 4)`.
   - Render the port list container with `ref={portsContainerRef}` and class:
     ```tsx
     className={`flex items-center flex-wrap gap-1.5 transition-all duration-150 ${
       isPortsExpanded ? 'max-h-40 overflow-y-auto pr-1' : 'max-h-[30px] overflow-hidden'
     }`}
     ```
   - When `listeningPorts.length > 0 && (isPortsOverflowing || isPortsExpanded)`, render the toggle button `data-testid="proxy-ports-expand-btn"` in the listening ports header row (next to the refresh button or on the right side of the port pills row) showing `ChevronUp` + `t('proxy.collapsePorts', '收起')` when expanded, or `ChevronDown` + `${t('proxy.expandPorts', '展开全部')} (${listeningPorts.length})` when collapsed.
   - Add cURL import state and handler:
     ```tsx
     const [showCurlImport, setShowCurlImport] = useState<boolean>(false);
     const [curlInputText, setCurlInputText] = useState<string>('');
     ```
   - Implement `applyCurlCommand(rawText: string): boolean`:
     - Calls `parseCurlCommand(rawText)`. If `null`, shows error toast `t('proxy.curlParseError', '无法解析 cURL 命令，请检查格式')` and returns `false`.
     - Normalizes `parsed.method` against `['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']` (fallback `'GET'`).
     - Sets `method`, `requestUrl`, `insecure`, `customHeaders` (formatted as `Key: Value` lines), and `requestBody`.
     - If `Object.keys(parsed.headers).length > 0 || Boolean(parsed.body) || parsed.insecure || (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD')`, sets `setShowAdvancedRequest(true)`.
     - Closes `showCurlImport`, clears `curlInputText`, shows success toast `t('proxy.curlImported', '已从 cURL 导入请求配置')`, and returns `true`.
   - On `data-testid="proxy-request-url-input"`, add `onPaste`:
     ```tsx
     onPaste={(e) => {
       const pasted = e.clipboardData?.getData('text') || '';
       if (isCurlCommandText(pasted)) {
         e.preventDefault();
         applyCurlCommand(pasted);
       }
     }}
     ```
   - In the HTTP Request Debugger header bar, add the `data-testid="proxy-import-curl-btn"` button (with `Terminal` icon and `t('proxy.importCurl', '导入 cURL')`) beside the `Headers / Body / TLS` toggle button.
   - When `showCurlImport` is true, render a compact panel with `textarea` (`data-testid="proxy-curl-input"`, supporting direct paste auto-import or manual edit) and a confirm button (`data-testid="proxy-curl-apply-btn"`).

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/curlParser.test.ts tests/proxyUi.test.ts && npm run build:frontend`
Expected: PASS (all unit tests in both suites pass, frontend Vite build succeeds)
