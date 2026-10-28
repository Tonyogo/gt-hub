# Agent Proxy Network Latency & Bandwidth Speedtest Design Specification

**Date**: 2026-10-28
**Status**: Approved in Brainstorming
**Scope**: Segmented Tunnel Latency/Jitter Benchmark, High-Entropy Download/Upload Bandwidth Speedtest, Outbound Target Connectivity Probe, Web UI Speedtest Panel, and `gt speedtest` CLI Command

---

## 1. Purpose & Goals

Provide built-in, zero-dependency network performance benchmarking for any connected `gt` Agent node across both the **Web UI (`TerminalProxyView`)** and the **`gt` CLI (`gt speedtest <node>`)**:

1. **Segmented Latency & Jitter (`Client ↔ Hub ↔ Agent`)**:
   - Measure total round-trip latency (`Total RTT`), Hub-to-Agent tunnel latency (`Hub ↔ Agent RTT`), derived Client-to-Hub latency (`Client ↔ Hub RTT`), and network jitter (`Jitter`, `Min`, `Max` in `ms`).
2. **True Physical Bandwidth Speedtest (`Download` & `Upload`)**:
   - Stream high-entropy (incompressible) binary payloads over the exact same `TerminalProxyBridge` + `0x05`/`0x06` binary frame pipeline used by real HTTP proxy traffic so `perMessageDeflate` compression cannot artificially inflate results.
   - Measure real-time and aggregate throughput in both `Mbps` (megabits/sec) and `MB/s` (megabytes/sec).
3. **Agent Outbound Target Probe**:
   - Test HTTP/HTTPS reachability and response latency (`ms`) from the Agent node to preset public endpoints (Cloudflare, GitHub, Google, NPM Registry) or user-supplied URLs.

---

## 2. Protocol & Backend Architecture

### 2.1 High-Entropy Incompressible Buffer & Internal Speedtest Streams (`src/agent/handlers/proxyHandler.ts`)

1. **High-Entropy 32KB Chunk Generator**:
   - Allocate a single 32KB random buffer via `crypto.randomBytes(32 * 1024)` per `ProxyHandler` instance.
   - Mutate 4 bytes per emitted chunk (rolling counter XOR) so consecutive chunks cannot be deduplicated by zlib/deflate while requiring near-zero CPU overhead.
2. **Internal Speedtest URL Handling in `ProxyHandler.handleHttpStart`**:
   - Intercepts target URLs starting with `http://internal.speedtest/` (used internally by Hub's `/api/proxy/:hostId/speedtest/*` routes):
     - **`GET http://internal.speedtest/download?bytes=<size>`**:
       - Clamps `bytes` between `64 * 1024` (64KB) and `256 * 1024 * 1024` (256MB), default `16 * 1024 * 1024` (16MB).
       - Immediately sends `proxy_http_headers` (`statusCode: 200`, `content-type: application/octet-stream`, `content-length: String(bytes)`, `cache-control: no-store`).
       - Streams `PROXY_HTTP_RES_BODY (0x06)` 32KB high-entropy chunks asynchronously, pausing whenever `getBufferedAmount() > HIGH_WATERMARK_BUFFERED_AMOUNT (4MB)` and respecting `proxy_http_abort` cancellation.
       - Sends `proxy_http_end` when all bytes are emitted.
     - **`POST http://internal.speedtest/upload`**:
       - Tracks `receivedBytes` and `startTime = Date.now()` as `PROXY_HTTP_REQ_BODY (0x05)` frames arrive.
       - When `proxy_http_req_end` arrives, responds with `200 OK` (`content-type: application/json`) and body `JSON.stringify({ receivedBytes, agentDurationMs: Math.max(1, Date.now() - startTime) })`.

### 2.2 Control Signaling RPCs (`proxy_net_ping` & `proxy_net_probe`)

1. **Tunnel Ping (`proxy_net_ping` / `proxy_net_ping_res`)**:
   - Hub → Agent: `{ "type": "proxy_net_ping", "reqId": "ping-..." }`
   - Agent → Hub: `{ "type": "proxy_net_ping_res", "reqId": "ping-...", "agentTimestamp": 1730000000000 }`
   - Hub measures elapsed time using `process.hrtime.bigint()` to compute `hubAgentRttMs` with `0.01ms` precision.
2. **Outbound Target Probe (`proxy_net_probe` / `proxy_net_probe_res`)**:
   - Hub → Agent:
     ```json
     {
       "type": "proxy_net_probe",
       "reqId": "probe-...",
       "targets": ["https://1.1.1.1/cdn-cgi/trace", "https://api.github.com"],
       "timeoutMs": 8000
     }
     ```
   - Agent → Hub:
     ```json
     {
       "type": "proxy_net_probe_res",
       "reqId": "probe-...",
       "success": true,
       "results": [
         { "url": "https://1.1.1.1/cdn-cgi/trace", "ok": true, "statusCode": 200, "latencyMs": 18 },
         { "url": "https://api.github.com", "ok": true, "statusCode": 200, "latencyMs": 45 }
       ]
     }
     ```

### 2.3 Hub Speedtest Routes (`src/terminal/routes/proxyRoutes.ts`)

1. **`GET /api/proxy/:hostId/speedtest/ping`**:
   - Calls `terminalProxyBridge.pingAgent(hostId, 10000)`.
   - Returns `200 { hubAgentRttMs: number, timestamp: number }` (or `404` / `502`).
2. **`GET /api/proxy/:hostId/speedtest/download`**:
   - Reads `?bytes=` query parameter (default `16777216`).
   - Delegates to `terminalProxyBridge.handleHttpProxyRequest(req, res, { hostId, targetUrl: 'http://internal.speedtest/download?bytes=' + bytes, timeoutMs: 120000 })`.
3. **`POST /api/proxy/:hostId/speedtest/upload`**:
   - Delegates to `terminalProxyBridge.handleHttpProxyRequest(req, res, { hostId, targetUrl: 'http://internal.speedtest/upload', timeoutMs: 120000 })`.
4. **`POST /api/proxy/:hostId/speedtest/probe`**:
   - Parses JSON body (manually or from stream since `/api/proxy` is mounted before `express.json()`) for `{ targets?: string[]; timeoutMs?: number }`.
   - Calls `terminalProxyBridge.probeTargets(hostId, targets, timeoutMs)` and returns `200 { results: TargetProbeResult[] }`.

---

## 3. Frontend Design (`TerminalProxyView.tsx`)

Extend `mode` state in `frontend/src/components/terminal/TerminalProxyView.tsx`:
```ts
const [mode, setMode] = useState<'port' | 'request' | 'speedtest'>('port');
```
Add a 3rd mode button (`data-testid="proxy-mode-speedtest"`) with `Zap` or `Gauge` icon labeled `t('proxy.speedtestMode', '网络测速')`.

### Speedtest Panel Features
1. **Controls Bar**:
   - Payload size selector (`data-testid="speedtest-size-select"`): `1 MB`, `4 MB`, `16 MB` (default), `32 MB`, `64 MB`.
   - `Start Speedtest` / `Stop` button (`data-testid="speedtest-start-btn"`).
2. **4-Card Metric Grid**:
   - **Latency (Total RTT)**: Average `ms` + segmented subtitle `Client↔Hub: X ms | Hub↔Agent: Y ms`.
   - **Jitter**: `ms` + `Min / Max ms`.
   - **Download Speed**: `Mbps` primary display + `MB/s` secondary display + progress bar (`0% - 100%`).
   - **Upload Speed**: `Mbps` primary display + `MB/s` secondary display + progress bar (`0% - 100%`).
3. **Outbound Connectivity Probe Section**:
   - Preset targets list (`Cloudflare 1.1.1.1`, `GitHub API`, `Google 204`, `NPM Registry`) + custom URL input (`data-testid="speedtest-custom-probe-input"`) and `Probe Targets` button (`data-testid="speedtest-probe-btn"`).
   - Displays status badge (`200 OK` / `Failed`) and latency bar (`ms`) for each target.

---

## 4. Client CLI Design (`gt speedtest`)

Register `gt speedtest <node>` in `src/client/index.ts` and implement `runSpeedtest` / `handleSpeedtestCommand` in `src/client/commands/proxy.ts`:

```bash
gt speedtest <node> [--size <mb>] [--pings <count>] [--target <url...>] [--json]
```
- **Default Options**: `--size 16` (MB), `--pings 5`.
- **Execution Steps**:
  1. Resolve `<node>` via `resolveHost`.
  2. Run `pings` sequential requests to `GET /api/proxy/:hostId/speedtest/ping`, computing `avgTotalRttMs`, `avgHubAgentRttMs`, `avgClientHubRttMs`, `minRttMs`, `maxRttMs`, and `jitterMs` (mean absolute difference between consecutive RTT samples).
  3. Stream download from `GET /api/proxy/:hostId/speedtest/download?bytes=<sizeBytes>`, measuring elapsed time and calculating `downloadMbps` (`(bytes * 8) / (seconds * 1_000_000)`) and `downloadMBps` (`bytes / (seconds * 1024 * 1024)`).
  4. Stream upload of `<sizeBytes>` high-entropy bytes to `POST /api/proxy/:hostId/speedtest/upload`, calculating `uploadMbps` and `uploadMBps`.
  5. Run outbound target probe via `POST /api/proxy/:hostId/speedtest/probe`.
  6. Output formatted summary table or `--json` structured report.

---

## 5. Testing Strategy

Create `tests/proxySpeedtest.test.ts` verifying:
1. `GET /api/proxy/:hostId/speedtest/ping` returns accurate `hubAgentRttMs`.
2. `GET /api/proxy/:hostId/speedtest/download?bytes=262144` streams exactly `262,144` high-entropy bytes and respects mid-stream client abort.
3. `POST /api/proxy/:hostId/speedtest/upload` streams uploaded bytes to Agent and returns `{ receivedBytes: 262144, agentDurationMs: ... }`.
4. `POST /api/proxy/:hostId/speedtest/probe` probes a local test HTTP server URL and an unreachable URL, returning accurate status codes and latency measurements.
5. CLI `runSpeedtest` executes the full benchmark (ping + download + upload + probe) and returns structured metrics.
6. Frontend `TerminalProxyView` renders the `speedtest` mode tab and controls.
