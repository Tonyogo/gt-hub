# Terminal Host Selector Server & Node Uptime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the GT-Hub server's current uptime and each online agent node's current uptime inside the terminal host selector dropdown.

**Architecture:** Extend `GET /api/terminal/hosts` in `TerminalHostController` to include `serverStartTime` and `serverUptimeMs` derived from `process.uptime()`, and ensure `TerminalHostManager.registerAgent` guarantees a valid `startTime` for every online node. On the frontend, add a `formatUptime` helper in `timeHelpers.ts`, add zh/en locale entries, and render server uptime in the dropdown header and per-node uptime in each online host row of `TerminalHostSelector.tsx`.

**Tech Stack:** Node.js, Express, TypeScript, React 18, Tailwind CSS, Jest.

**Spec:** In-chat bounded design approved by user (conversation 2026-10-27).

## Global Constraints

- Preserve backward compatibility for `GET /api/terminal/hosts` (`hosts` array and `timezone` field remain intact).
- Offline nodes in `TerminalHostSelector` must continue displaying their relative offline time (`formatRelativeTime(h.lastSeen, lang)`).
- Online nodes without an explicit `startTime` from the API must gracefully fall back to `h.lastSeen` on the frontend so no blank or `NaN` text ever appears.
- Clock skew where `startTime > currentNow` must clamp to `0` (`< 1m`) rather than rendering negative durations.

## Review Focus

1. **Clock Skew / Future Timestamps**: If an agent's clock is slightly ahead of the browser's `Date.now()`, `formatUptime` must clamp elapsed time to `0` and return `'< 1m'`.
2. **Invalid or Missing Timestamps**: `formatUptime(0)`, `formatUptime(NaN)`, or `formatUptime(-100)` must return `''` so callers can safely omit the label.
3. **Legacy Agent Without `startTime` Parameter**: When an agent registers without `startTime` (or transitions from offline to online without `startTime`), `TerminalHostManager` defaults `startTime` to `Date.now()`, and preserve existing `startTime` on subsequent heartbeats (`touchAgent`) when `metadata.startTime` is undefined.
4. **Offline Host Display Preservation**: An offline host that still has a historical `startTime` property must display its offline relative time (`lastSeen`), never online uptime.
5. **Narrow Viewport Dropdown Header Layout**: When both "Clear Offline" and "Add Node" buttons are shown alongside server uptime in the dropdown header, the header uses `flex-wrap` so text is not clipped.

---

### Task 1: Backend Server Uptime & Host `startTime` Fallback

**Files:**
- Modify: `src/terminal/controllers/terminalHostController.ts:6-11`
- Modify: `src/terminal/services/terminalHostManager.ts:638-667`
- Test: `tests/terminalHostsApi.test.ts`
- Test: `tests/terminalHostManager.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/terminal/hosts` JSON response: `{ hosts: ManagedHost[], timezone: string, serverStartTime: number, serverUptimeMs: number }`
  - `TerminalHostManager.registerAgent`: sets `host.startTime = metadata.startTime ?? Date.now()` on initial registration and when transitioning from `'offline'` to `'online'` without explicit `metadata.startTime`.

- [x] **Step 1: Write failing tests in `tests/terminalHostsApi.test.ts` and `tests/terminalHostManager.test.ts`**

In `tests/terminalHostsApi.test.ts`, add a test verifying `serverStartTime` and `serverUptimeMs` on `GET /api/terminal/hosts`:

```typescript
  test('returns serverStartTime and serverUptimeMs in GET /api/terminal/hosts', async () => {
    const res = await request(app)
      .get('/api/terminal/hosts')
      .set('x-admin-key', key);

    expect(res.status).toBe(200);
    expect(typeof res.body.serverStartTime).toBe('number');
    expect(res.body.serverStartTime).toBeGreaterThan(0);
    expect(res.body.serverStartTime).toBeLessThanOrEqual(Date.now());
    expect(typeof res.body.serverUptimeMs).toBe('number');
    expect(res.body.serverUptimeMs).toBeGreaterThanOrEqual(0);
  });
```

In `tests/terminalHostManager.test.ts`, add a test verifying default `startTime` assignment and offline-to-online transition fallback:

```typescript
  test('defaults startTime to Date.now() when omitted on registration or offline reconnect', () => {
    const mockWs = { readyState: 1, send: jest.fn() };
    const before = Date.now();
    const res = manager.registerAgent({
      hostId: 'agent-default-starttime',
      name: 'Default-StartTime-Node',
      agentWs: mockWs,
    });
    const after = Date.now();
    expect(res.host?.startTime).toBeGreaterThanOrEqual(before);
    expect(res.host?.startTime).toBeLessThanOrEqual(after);

    // Backdate startTime, mark offline, then reconnect without startTime
    const hostRef = manager.getHost('agent-default-starttime')!;
    hostRef.startTime = before - 60000;
    manager.unregisterAgent('agent-default-starttime');

    const reconnectBefore = Date.now();
    manager.registerAgent({
      hostId: 'agent-default-starttime',
      name: 'Default-StartTime-Node',
      agentWs: mockWs,
    });
    expect(manager.getHost('agent-default-starttime')?.startTime).toBeGreaterThanOrEqual(reconnectBefore);
  });
```

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/terminalHostsApi.test.ts tests/terminalHostManager.test.ts`
Expected: FAIL (`res.body.serverStartTime` is `undefined` and `res.host?.startTime` is `undefined`).

- [x] **Step 3: Implement server uptime fields in `src/terminal/controllers/terminalHostController.ts` and `startTime` fallback in `src/terminal/services/terminalHostManager.ts`**

In `src/terminal/controllers/terminalHostController.ts`, update `getHosts(req: Request, res: Response)`:
```typescript
  public async getHosts(req: Request, res: Response): Promise<void> {
    const hosts = terminalHostManager.getHosts();
    const serverUptimeMs = Math.floor(process.uptime() * 1000);
    const serverStartTime = Date.now() - serverUptimeMs;
    res.json({
      hosts,
      timezone: config.timeZone,
      serverStartTime,
      serverUptimeMs,
    });
  }
```

In `src/terminal/services/terminalHostManager.ts`, update step 3 of `registerAgent`:
- When `!host`, set `startTime: metadata.startTime ?? Date.now()`.
- When `host` already exists, capture `const wasOffline = host.status === 'offline';` before setting `host.status = 'online'`. If `metadata.startTime !== undefined`, set `host.startTime = metadata.startTime`; else if `wasOffline || host.startTime === undefined`, set `host.startTime = Date.now()`.

- [x] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/terminalHostsApi.test.ts tests/terminalHostManager.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/terminal/controllers/terminalHostController.ts src/terminal/services/terminalHostManager.ts tests/terminalHostsApi.test.ts tests/terminalHostManager.test.ts
git commit -m "feat(terminal): return serverStartTime in hosts API and default host startTime"
```

---

### Task 2: Frontend `formatUptime` Helper & i18n Translations

**Files:**
- Modify: `frontend/src/utils/timeHelpers.ts:1-70`
- Modify: `frontend/src/i18n/locales/zh.ts:75-105`
- Modify: `frontend/src/i18n/locales/en.ts:73-103`
- Test: `tests/timeHelpers.test.ts`

**Interfaces:**
- Produces:
  - `formatUptime(startTime: number, lang?: 'zh' | 'en', currentNow?: number): string` in `frontend/src/utils/timeHelpers.ts`
  - Locale keys under `webTerminal.hostSelector`:
    - `zh`: `serverUptime: "服务运行 {uptime}"`, `serverStartedAt: "服务启动时间: "`, `nodeUptime: "在线 {uptime}"`, `nodeOnlineAt: "节点上线时间: "`
    - `en`: `serverUptime: "Server up {uptime}"`, `serverStartedAt: "Server started: "`, `nodeUptime: "Up {uptime}"`, `nodeOnlineAt: "Online since: "`

- [x] **Step 1: Write failing unit tests for `formatUptime` in `tests/timeHelpers.test.ts`**

Add a `describe('formatUptime', ...)` block in `tests/timeHelpers.test.ts`:

```typescript
  describe('formatUptime', () => {
    it('returns empty string for invalid or non-positive timestamps', () => {
      expect(formatUptime(0)).toBe('');
      expect(formatUptime(NaN)).toBe('');
      expect(formatUptime(-500)).toBe('');
    });

    it('clamps future timestamps (clock skew) to < 1m', () => {
      const now = 1700000000000;
      expect(formatUptime(now + 30000, 'zh', now)).toBe('< 1m');
      expect(formatUptime(now + 30000, 'en', now)).toBe('< 1m');
    });

    it('formats sub-minute, minute, hour, and multi-day durations accurately', () => {
      const now = 1700000000000;
      // 45 seconds -> < 1m
      expect(formatUptime(now - 45 * 1000, 'zh', now)).toBe('< 1m');
      // 25 minutes -> 25m
      expect(formatUptime(now - 25 * 60 * 1000, 'zh', now)).toBe('25m');
      // Exact 2 hours -> 2h
      expect(formatUptime(now - 2 * 3600 * 1000, 'zh', now)).toBe('2h');
      // 5 hours 20 minutes -> 5h 20m
      expect(formatUptime(now - (5 * 3600 + 20 * 60) * 1000, 'en', now)).toBe('5h 20m');
      // Exact 3 days -> 3d
      expect(formatUptime(now - 3 * 86400 * 1000, 'zh', now)).toBe('3d');
      // 3 days 12 hours -> 3d 12h
      expect(formatUptime(now - (3 * 86400 + 12 * 3600) * 1000, 'en', now)).toBe('3d 12h');
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/timeHelpers.test.ts`
Expected: FAIL (`formatUptime` is not exported from `../frontend/src/utils/timeHelpers`).

- [x] **Step 3: Implement `formatUptime` in `frontend/src/utils/timeHelpers.ts` and add locale strings in `zh.ts` and `en.ts`**

In `frontend/src/utils/timeHelpers.ts`, implement and export `formatUptime`:
```typescript
export function formatUptime(
  startTime: number,
  _lang: 'zh' | 'en' = 'zh',
  currentNow: number = Date.now()
): string {
  if (!startTime || isNaN(startTime) || startTime <= 0) return '';
  const diffMs = Math.max(0, currentNow - startTime);
  const totalMin = Math.floor(diffMs / 60000);
  if (totalMin < 1) return '< 1m';

  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 1) return `${totalMin}m`;

  const totalDays = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (totalDays < 1) {
    return remMin > 0 ? `${totalHours}h ${remMin}m` : `${totalHours}h`;
  }

  return remHours > 0 ? `${totalDays}d ${remHours}h` : `${totalDays}d`;
}
```

In `frontend/src/i18n/locales/en.ts` and `frontend/src/i18n/locales/zh.ts`, add `serverUptime`, `serverStartedAt`, `nodeUptime`, and `nodeOnlineAt` under `webTerminal.hostSelector` with the exact strings from the Interfaces block above.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/timeHelpers.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/timeHelpers.ts frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts tests/timeHelpers.test.ts
git commit -m "feat(frontend): add formatUptime helper and hostSelector uptime translations"
```

---

### Task 3: Render Server & Node Uptime in `TerminalHostSelector`

**Files:**
- Modify: `frontend/src/components/terminal/TerminalHostSelector.tsx:17-31,53-65,137-160,368-493`
- Test: `tests/terminalHostSelector.test.ts`

**Interfaces:**
- Consumes:
  - `formatUptime` from `../../utils/timeHelpers`
  - `serverStartTime` from `GET /api/terminal/hosts`
  - `startTime?: number` on `ManagedHostItem`
  - `webTerminal.hostSelector.{serverUptime,serverStartedAt,nodeUptime,nodeOnlineAt}` translations

- [x] **Step 1: Write failing tests in `tests/terminalHostSelector.test.ts`**

Add tests in `tests/terminalHostSelector.test.ts` verifying that `TerminalHostSelector` tracks `serverStartTime`, formats server uptime in the dropdown header, and formats per-node uptime for online hosts while preserving `formatRelativeTime` for offline hosts:

```typescript
  test('displays server uptime in dropdown header and node uptime for online hosts', () => {
    expect(content).toContain('formatUptime');
    expect(content).toContain('serverStartTime');
    expect(content).toContain('webTerminal.hostSelector.serverUptime');
    expect(content).toContain('webTerminal.hostSelector.nodeUptime');
    expect(content).toContain('h.startTime || h.lastSeen');
  });

  test('i18n locales contain server and node uptime translations', () => {
    expect((zh as any).webTerminal.hostSelector.serverUptime).toBe('服务运行 {uptime}');
    expect((en as any).webTerminal.hostSelector.serverUptime).toBe('Server up {uptime}');
    expect((zh as any).webTerminal.hostSelector.nodeUptime).toBe('在线 {uptime}');
    expect((en as any).webTerminal.hostSelector.nodeUptime).toBe('Up {uptime}');
    expect((zh as any).webTerminal.hostSelector.serverStartedAt).toBeDefined();
    expect((en as any).webTerminal.hostSelector.serverStartedAt).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.nodeOnlineAt).toBeDefined();
    expect((en as any).webTerminal.hostSelector.nodeOnlineAt).toBeDefined();
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalHostSelector.test.ts`
Expected: FAIL (`expect(content).toContain('formatUptime')` fails).

- [x] **Step 3: Update `frontend/src/components/terminal/TerminalHostSelector.tsx`**

1. Import `formatUptime` alongside `formatRelativeTime` from `../../utils/timeHelpers`.
2. Add `startTime?: number;` to `ManagedHostItem`.
3. Add `serverStartTime` state initialized from `sessionStorage.getItem('cached_terminal_server_start_time')` (if valid number, else `null`), and update it in `fetchHosts` when `typeof data.serverStartTime === 'number'`.
4. Compute `serverUptimeText`:
   ```tsx
   const serverUptimeRaw = serverStartTime ? formatUptime(serverStartTime, lang) : '';
   const serverUptimeText = serverUptimeRaw
     ? t('webTerminal.hostSelector.serverUptime', { uptime: serverUptimeRaw }).replace('{uptime}', serverUptimeRaw)
     : '';
   ```
5. In the dropdown header (`popoverContent`), use `flex-wrap gap-1` on the top row and render `serverUptimeText` next to `hostsCount` with tooltip `serverStartedAt`:
   ```tsx
   <div className="flex flex-wrap items-center justify-between gap-1 text-xs px-1">
     <span className="font-semibold text-[var(--text-secondary)] flex items-center space-x-1.5 min-w-0">
       <Server className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
       <span>
         {t('webTerminal.hostSelector.hostsCount', {
           online: onlineCount.toString(),
           total: hosts.length.toString(),
         })
           .replace('{online}', onlineCount.toString())
           .replace('{total}', hosts.length.toString())}
       </span>
       {serverUptimeText && (
         <span
           className="text-[10px] font-normal text-[var(--text-muted)] font-mono truncate"
           title={
             serverStartTime
               ? `${t('webTerminal.hostSelector.serverStartedAt', '服务启动时间: ')}${new Date(serverStartTime).toLocaleString()}`
               : undefined
           }
         >
           · {serverUptimeText}
         </span>
       )}
     </span>
   ```
6. In `filteredHosts.map((h) => ...)`, compute `onlineSince = h.startTime || h.lastSeen`, `nodeUptimeRaw = isOnline && onlineSince ? formatUptime(nodeOnlineSince, lang) : ''`, and `nodeUptimeText = nodeUptimeRaw ? t('webTerminal.hostSelector.nodeUptime', { uptime: nodeUptimeRaw }).replace('{uptime}', nodeUptimeRaw) : ''`.
   - Set button `title` to `nodeOnlineAt` + `new Date(onlineSince).toLocaleString()` when `isOnline && onlineSince`, or `offlineAt` when `!isOnline && h.lastSeen`.
   - Render the subtitle line as:
     ```tsx
     <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">
       {isOnline
         ? `${h.ip} · ${h.platform}${nodeUptimeText ? ` · ${nodeUptimeText}` : ''}`
         : `${h.ip} · ${formatRelativeTime(h.lastSeen, lang)}`}
     </div>
     ```

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/terminalHostSelector.test.ts tests/timeHelpers.test.ts tests/terminalHostsApi.test.ts && npm run build:frontend`
Expected: PASS and clean frontend build.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalHostSelector.tsx tests/terminalHostSelector.test.ts
git commit -m "feat(frontend): display server and node uptime in terminal host selector"
```
