# Agent Proxy Network Latency & Bandwidth Speedtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end segmented latency/jitter benchmarking, high-entropy download/upload bandwidth speedtesting, and outbound target connectivity probing across Agent (`ProxyHandler`), Hub (`/api/proxy/:hostId/speedtest/*`), Web UI (`TerminalProxyView`), and CLI (`gt speedtest <node>`).

**Architecture:** We extend `ProxyHandler` with `proxy_net_ping` and `proxy_net_probe` RPCs plus built-in `http://internal.speedtest/download` and `http://internal.speedtest/upload` virtual streams backed by a 32KB high-entropy random buffer. On the Hub, `TerminalProxyBridge` and `proxyRoutes.ts` expose `/api/proxy/:hostId/speedtest/{ping,download,upload,probe}`. On the client side, `TerminalProxyView.tsx` adds a 3rd `speedtest` mode tab and `src/client/commands/proxy.ts` adds `gt speedtest <node>`.

**Tech Stack:** TypeScript, Node.js (`crypto`, `http`, `https`), Express, React 18, Tailwind CSS, Commander.js, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-proxy-speedtest-design.md`

## Global Constraints

- Speedtest download/upload payloads MUST use high-entropy random bytes (`crypto.randomBytes(32 * 1024)` with per-chunk counter mutation) so `perMessageDeflate` cannot compress them and inflate measured bandwidth.
- Download size (`bytes`) MUST be clamped to `[64 * 1024, 256 * 1024 * 1024]` (64KB to 256MB), default `16 * 1024 * 1024` (16MB).
- Internal speedtest streams MUST respect `HIGH_WATERMARK_BUFFERED_AMOUNT` (`4MB`) backpressure and immediate cancellation on `proxy_http_abort` or `destroyAll()`.
- Always run targeted tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

1. **Incompressibility of download stream**: Running `zlib.deflateSync` on a 64KB slice of the speedtest download stream must yield compressed size `>= 60KB` (proving `perMessageDeflate` will not skew bandwidth metrics).
2. **Client abort during large speedtest download**: If a client aborts a 64MB download after receiving 128KB, `proxy_http_abort` must stop the Agent's internal download loop immediately without leaking timers or sending remaining chunks.
3. **Agent disconnect while `pingAgent` or `probeTargets` RPC is pending**: `terminalProxyBridge.handleAgentDisconnected(hostId)` must immediately resolve pending ping/probe promises with `{ success: false, status: 502, error: 'Agent disconnected' }`.
4. **JSON body parsing on `POST /api/proxy/:hostId/speedtest/probe`**: Because `/api/proxy` is mounted before `express.json()`, the `/speedtest/probe` route must safely read and parse the incoming request stream when `req.body` is not pre-populated.
5. **Zero-division protection in throughput calculation**: When fast local loopback transfers complete in `< 1ms`, elapsed duration must be clamped to `Math.max(1, durationMs)` so `Mbps` and `MB/s` never become `Infinity` or `NaN`.

---

### Task 1: Agent & Hub Speedtest Engine (`ping`, `probe`, and `internal.speedtest` Streams)

**Files:**
- Modify: `src/agent/handlers/proxyHandler.ts`
- Modify: `src/terminal/services/terminalProxyBridge.ts`
- Modify: `src/terminal/routes/proxyRoutes.ts`
- Test: `tests/proxySpeedtest.test.ts`

**Interfaces:**
- Consumes: `ProxyHandler` in `src/agent/handlers/proxyHandler.ts`, `TerminalProxyBridge` in `src/terminal/services/terminalProxyBridge.ts`
- Produces:
  - In `src/agent/handlers/proxyHandler.ts`:
    ```ts
    export interface TargetProbeResult {
      url: string;
      ok: boolean;
      statusCode?: number;
      latencyMs: number;
      error?: string;
    }
    export const DEFAULT_PROBE_TARGETS: string[];
    export function probeOutboundTarget(url: string, timeoutMs?: number): Promise<TargetProbeResult>;
    ```
    And handles:
    - `proxy_net_ping` -> `proxy_net_ping_res { reqId, agentTimestamp }`
    - `proxy_net_probe` -> `proxy_net_probe_res { reqId, success: true, results: TargetProbeResult[] }`
    - `http://internal.speedtest/download?bytes=<n>` and `http://internal.speedtest/upload` inside `handleHttpStart`.
  - In `src/terminal/services/terminalProxyBridge.ts`:
    ```ts
    public pingAgent(
      hostId: string,
      timeoutMs?: number
    ): Promise<{ success: boolean; status?: number; hubAgentRttMs?: number; agentTimestamp?: number; error?: string }>;
    public probeTargets(
      hostId: string,
      targets?: string[],
      timeoutMs?: number
    ): Promise<{ success: boolean; status?: number; results?: TargetProbeResult[]; error?: string }>;
    ```
  - In `src/terminal/routes/proxyRoutes.ts`:
    - `GET /:hostId/speedtest/ping`
    - `GET /:hostId/speedtest/download`
    - `POST /:hostId/speedtest/upload`
    - `POST /:hostId/speedtest/probe`

- [x] **Step 1: Write the failing test in `tests/proxySpeedtest.test.ts`**

Create `tests/proxySpeedtest.test.ts` testing:
1. `GET /api/proxy/:hostId/speedtest/ping` returns `200` with `hubAgentRttMs >= 0` and `timestamp`.
2. `GET /api/proxy/:hostId/speedtest/download?bytes=262144` streams `262,144` high-entropy bytes (verifying `zlib.deflateSync(buf).length > 250000`) and cleans up immediately when a client aborts mid-download.
3. `POST /api/proxy/:hostId/speedtest/upload` receives streamed binary chunks and returns `200 { receivedBytes: 262144, agentDurationMs: ... }`.
4. `POST /api/proxy/:hostId/speedtest/probe` probes a live local HTTP test server URL and a closed port URL, returning `ok: true, statusCode: 200, latencyMs` for the live target and `ok: false, error` for the unreachable target.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxySpeedtest.test.ts`
Expected: FAIL with 404 on `/api/proxy/:hostId/speedtest/ping`.

- [x] **Step 3: Implement speedtest handlers in `proxyHandler.ts`, `terminalProxyBridge.ts`, and `proxyRoutes.ts`**

1. In `src/agent/handlers/proxyHandler.ts`:
   - Add `DEFAULT_PROBE_TARGETS = ['https://1.1.1.1/cdn-cgi/trace', 'https://api.github.com', 'https://www.google.com/generate_204', 'https://registry.npmjs.org/-/ping']`.
   - Implement `probeOutboundTarget(url: string, timeoutMs = 8000): Promise<TargetProbeResult>` using `http.request`/`https.request` (`method: 'GET'`, `headers: { 'User-Agent': 'gt-agent-probe/1.0' }`), measuring `Date.now() - start` upon `'response'`, destroying `res` immediately after headers, and handling timeout/error cleanly.
   - Handle `proxy_net_ping` and `proxy_net_probe` in `handleControlMessage`.
   - In `handleHttpStart`: if `parsedUrl.hostname === 'internal.speedtest'`:
     - For `/download`: clamp `bytes` (`65536..268435456`, default `16777216`), send `proxy_http_headers` (`200`, `application/octet-stream`), and run an async chunk loop sending 32KB high-entropy slices (with backpressure pause when `getBufferedAmount() > HIGH_WATERMARK_BUFFERED_AMOUNT` and abort check when removed from `activeHttpRequests`).
     - For `/upload`: record `receivedBytes` in `activeHttpRequests` on `0x05` frames, and on `proxy_http_req_end` emit `proxy_http_headers` (`200`, `application/json`), `0x06` JSON payload `{ receivedBytes, agentDurationMs }`, and `proxy_http_end`.
2. In `src/terminal/services/terminalProxyBridge.ts`:
   - Add `pendingPingRpcs` and `pendingProbeRpcs` maps, implement `pingAgent` (using `Number(process.hrtime.bigint() - startNs) / 1e6`) and `probeTargets`, handle `proxy_net_ping_res` and `proxy_net_probe_res` in `handleAgentControlMessage`, and clean them up in `handleAgentDisconnected`.
3. In `src/terminal/routes/proxyRoutes.ts`:
   - Mount `GET /:hostId/speedtest/ping`, `GET /:hostId/speedtest/download`, `POST /:hostId/speedtest/upload`, and `POST /:hostId/speedtest/probe` (reading JSON request stream if `req.body` is undefined).

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxySpeedtest.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/agent/handlers/proxyHandler.ts src/terminal/services/terminalProxyBridge.ts src/terminal/routes/proxyRoutes.ts tests/proxySpeedtest.test.ts
git commit -m "feat(proxy): add speedtest ping, download, upload, and outbound probe endpoints"
```

---

### Task 2: CLI `gt speedtest` Command & Benchmark Runner

**Files:**
- Modify: `src/client/commands/proxy.ts`
- Modify: `src/client/index.ts`
- Modify: `tests/proxySpeedtest.test.ts`

**Interfaces:**
- Consumes: `/api/proxy/:hostId/speedtest/{ping,download,upload,probe}` from Task 1
- Produces:
  - In `src/client/commands/proxy.ts`:
    ```ts
    export interface SpeedtestReport {
      hostId: string;
      latency: {
        samples: number;
        avgTotalRttMs: number;
        avgHubAgentRttMs: number;
        avgClientHubRttMs: number;
        minRttMs: number;
        maxRttMs: number;
        jitterMs: number;
      };
      download: {
        bytes: number;
        durationMs: number;
        mbps: number;
        mbPerSec: number;
      };
      upload: {
        bytes: number;
        durationMs: number;
        mbps: number;
        mbPerSec: number;
      };
      probes: TargetProbeResult[];
    }
    export function runSpeedtestBenchmark(options: {
      serverUrl: string;
      apiKey: string;
      hostId: string;
      sizeBytes?: number;
      pings?: number;
      targets?: string[];
    }): Promise<SpeedtestReport>;
    export function handleSpeedtestCommand(options: {
      server: string;
      key: string;
      node: string;
      sizeMb?: number;
      pings?: number;
      targets?: string[];
      json?: boolean;
    }): Promise<void>;
    ```
  - CLI command `gt speedtest <node>` in `src/client/index.ts`.

- [x] **Step 1: Add `runSpeedtestBenchmark` test to `tests/proxySpeedtest.test.ts`**

Add a test in `tests/proxySpeedtest.test.ts` calling `runSpeedtestBenchmark({ serverUrl, apiKey, hostId: 'test-agent-speed', sizeBytes: 131072, pings: 3, targets: [localTargetUrl] })` and asserting that `latency`, `download`, `upload`, and `probes` contain valid positive numbers (`mbps > 0`, `mbPerSec > 0`, `probes[0].ok === true`).

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxySpeedtest.test.ts`
Expected: FAIL with `runSpeedtestBenchmark is not a function`.

- [x] **Step 3: Implement `runSpeedtestBenchmark` & `handleSpeedtestCommand` in `src/client/commands/proxy.ts` and register `gt speedtest` in `src/client/index.ts`**

1. In `src/client/commands/proxy.ts`:
   - Implement `runSpeedtestBenchmark`:
     - Execute `pings` sequential requests to `/api/proxy/${encodeURIComponent(hostId)}/speedtest/ping`, computing `avgTotalRttMs`, `avgHubAgentRttMs`, `avgClientHubRttMs`, `minRttMs`, `maxRttMs`, and `jitterMs`.
     - Stream `GET /api/proxy/${encodeURIComponent(hostId)}/speedtest/download?bytes=${sizeBytes}`, counting received bytes and elapsed time (`durationMs`), computing `mbps = Number(((bytes * 8) / (durationSec * 1_000_000)).toFixed(2))` and `mbPerSec = Number((bytes / (durationSec * 1024 * 1024)).toFixed(2))`.
     - Stream `sizeBytes` of random bytes via `POST /api/proxy/${encodeURIComponent(hostId)}/speedtest/upload`, computing `mbps` and `mbPerSec`.
     - Call `POST /api/proxy/${encodeURIComponent(hostId)}/speedtest/probe` with `{ targets }`.
   - Implement `handleSpeedtestCommand`: resolves host via `resolveHost`, runs `runSpeedtestBenchmark`, prints JSON if `options.json` is true, or prints a formatted report.
2. In `src/client/index.ts`:
   - Export `runSpeedtestBenchmark` and `handleSpeedtestCommand`.
   - Register `program.command('speedtest <node>')` with `--size <mb>`, `--pings <count>`, `--target <url...>`, `--json`, `-s`, `-k`, `-c`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxySpeedtest.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/client/commands/proxy.ts src/client/index.ts tests/proxySpeedtest.test.ts
git commit -m "feat(cli): add gt speedtest command and benchmark runner"
```

---

### Task 3: Frontend Web UI Speedtest Panel (`TerminalProxyView.tsx`)

**Files:**
- Modify: `frontend/src/components/terminal/TerminalProxyView.tsx`
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Modify: `frontend/src/i18n/translations.ts`
- Modify: `tests/proxyUi.test.ts`

**Interfaces:**
- Consumes: `/api/proxy/:hostId/speedtest/{ping,download,upload,probe}`
- Produces:
  - 3rd mode tab (`speedtest`) in `frontend/src/components/terminal/TerminalProxyView.tsx` with interactive latency, jitter, download/upload speed cards, and outbound target connectivity prober.

- [x] **Step 1: Add Speedtest UI assertions to `tests/proxyUi.test.ts`**

Extend `tests/proxyUi.test.ts` to verify that `TerminalProxyView.tsx` includes:
- Mode `'speedtest'` and button `data-testid="proxy-mode-speedtest"`
- Size selector `data-testid="speedtest-size-select"` and start button `data-testid="speedtest-start-btn"`
- Calls to `/speedtest/ping`, `/speedtest/download`, `/speedtest/upload`, and `/speedtest/probe`
- Probe controls `data-testid="speedtest-custom-probe-input"` and `data-testid="speedtest-probe-btn"`

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyUi.test.ts`
Expected: FAIL on missing `proxy-mode-speedtest`.

- [x] **Step 3: Implement Speedtest mode in `TerminalProxyView.tsx` and update i18n files**

1. Update `frontend/src/i18n/locales/zh.ts`, `frontend/src/i18n/locales/en.ts`, and `frontend/src/i18n/translations.ts` with speedtest translation keys (`speedtestMode`, `startSpeedtest`, `stopSpeedtest`, `totalRtt`, `jitter`, `downloadSpeed`, `uploadSpeed`, `outboundProbe`, `probeNow`, etc.).
2. In `frontend/src/components/terminal/TerminalProxyView.tsx`:
   - Extend `mode` state to `'port' | 'request' | 'speedtest'`.
   - Add `data-testid="proxy-mode-speedtest"` button in the mode switcher bar, plus a button to copy `gt speedtest <hostId>`.
   - Implement the Speedtest view:
     - Payload size selector (`1 MB`, `4 MB`, `16 MB`, `32 MB`, `64 MB`) and Start/Stop button (`AbortController` support).
     - 4 metric cards: **Total RTT** (with `Client↔Hub` and `Hub↔Agent` breakdown), **Jitter** (with `Min / Max`), **Download Speed** (`Mbps` + `MB/s` + progress bar), **Upload Speed** (`Mbps` + `MB/s` + progress bar).
     - Outbound Target Probe section with preset targets + custom target input (`data-testid="speedtest-custom-probe-input"`) and `Probe` button (`data-testid="speedtest-probe-btn"`).

- [x] **Step 4: Run full build and all proxy test suites**

Run: `npm run build && npm test -- tests/proxyHandler.test.ts tests/proxyHub.test.ts tests/proxyCli.test.ts tests/proxyPhase2.test.ts tests/proxySpeedtest.test.ts tests/proxyUi.test.ts`
Expected: Full build succeeds and all 6 test suites PASS.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalProxyView.tsx frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts frontend/src/i18n/translations.ts tests/proxyUi.test.ts docs/superpowers/specs/2026-10-28-agent-proxy-speedtest-design.md docs/superpowers/plans/2026-10-28-agent-proxy-speedtest.md
git commit -m "feat(frontend): add network latency and bandwidth speedtest panel to TerminalProxyView"
```
