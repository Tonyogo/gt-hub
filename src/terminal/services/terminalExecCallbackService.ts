import http from 'http';
import https from 'https';
import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import { URL } from 'url';
import { sliceBufferUtf8Safe } from '../../agent/tasks/taskManager';
import { terminalHostManager } from './terminalHostManager';
import terminalLogService from './terminalLogService';

function checkIPv4(ip: string, blockPrivateIp: boolean): string | null {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return 'Invalid IPv4 address';
  }
  const [a, b] = parts;

  // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254, 169.254.170.2)
  if (a === 169 && b === 254) {
    return `Link-local/metadata IP (${ip}) is not allowed`;
  }

  // 0.0.0.0/8
  if (a === 0) {
    return `Current network IP (${ip}) is not allowed`;
  }

  if (blockPrivateIp) {
    // 127.0.0.0/8 (Loopback)
    if (a === 127) {
      return `Loopback IP (${ip}) is blocked by private IP policy`;
    }
    // 10.0.0.0/8 (Private)
    if (a === 10) {
      return `Private IP (${ip}) is blocked by private IP policy`;
    }
    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) {
      return `Private IP (${ip}) is blocked by private IP policy`;
    }
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) {
      return `Private IP (${ip}) is blocked by private IP policy`;
    }
  }

  return null;
}

function expandIPv6(ip: string): number[] | null {
  let cleanIp = ip;
  const lastColon = cleanIp.lastIndexOf(':');
  if (lastColon !== -1) {
    const possibleIpv4 = cleanIp.slice(lastColon + 1);
    if (net.isIPv4(possibleIpv4)) {
      const parts = possibleIpv4.split('.').map((p) => parseInt(p, 10));
      const hex1 = ((parts[0] << 8) | parts[1]).toString(16);
      const hex2 = ((parts[2] << 8) | parts[3]).toString(16);
      cleanIp = cleanIp.slice(0, lastColon) + `:${hex1}:${hex2}`;
    }
  }

  const doubleColon = cleanIp.indexOf('::');
  let leftPart: string[] = [];
  let rightPart: string[] = [];

  if (doubleColon !== -1) {
    const left = cleanIp.slice(0, doubleColon);
    const right = cleanIp.slice(doubleColon + 2);
    leftPart = left ? left.split(':') : [];
    rightPart = right ? right.split(':') : [];
    const missing = 8 - (leftPart.length + rightPart.length);
    if (missing < 0) return null;
    const middle = new Array(missing).fill('0');
    const full = [...leftPart, ...middle, ...rightPart];
    if (full.length !== 8) return null;
    return full.map((h) => parseInt(h || '0', 16));
  } else {
    const parts = cleanIp.split(':');
    if (parts.length !== 8) return null;
    return parts.map((h) => parseInt(h || '0', 16));
  }
}

function checkIPv6(ip: string, blockPrivateIp: boolean): string | null {
  const normalized = ip.toLowerCase();

  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1) {
    const embeddedIpv4 = normalized.slice(lastColon + 1);
    if (net.isIPv4(embeddedIpv4)) {
      const v4Blocked = checkIPv4(embeddedIpv4, blockPrivateIp);
      if (v4Blocked) return v4Blocked;
    }
  }

  const hextets = expandIPv6(normalized);
  if (!hextets) {
    return 'Invalid IPv6 address';
  }

  // Unspecified address (:: or 0:0:0:0:0:0:0:0)
  if (hextets.every((h) => h === 0)) {
    return `Unspecified IPv6 (${ip}) is not allowed`;
  }

  // AWS IPv6 metadata: fd00:ec2::254
  if (
    hextets[0] === 0xfd00 &&
    hextets[1] === 0x0ec2 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 0x0254
  ) {
    return `Cloud metadata IPv6 (${ip}) is not allowed`;
  }

  // Link-local: fe80::/10 (0xfe80 - 0xfebf)
  if (hextets[0] >= 0xfe80 && hextets[0] <= 0xfebf) {
    return `Link-local IPv6 (${ip}) is not allowed`;
  }

  // IPv4-mapped in hex form: ::ffff:a9fe:a9fe (169.254.169.254)
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const a = (hextets[6] >> 8) & 0xff;
    const b = hextets[6] & 0xff;
    const c = (hextets[7] >> 8) & 0xff;
    const d = hextets[7] & 0xff;
    const v4Blocked = checkIPv4(`${a}.${b}.${c}.${d}`, blockPrivateIp);
    if (v4Blocked) return v4Blocked;
  }

  if (blockPrivateIp) {
    // Loopback: ::1
    const isLoopback =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 1;
    if (isLoopback) {
      return `Loopback IPv6 (${ip}) is blocked by private IP policy`;
    }

    // Unique Local Address: fc00::/7 (0xfc00 - 0xfdff)
    if ((hextets[0] & 0xfe00) === 0xfc00) {
      return `Unique local IPv6 (${ip}) is blocked by private IP policy`;
    }
  }

  return null;
}

export function isBlockedCallbackHost(
  hostname: string,
  blockPrivateIp = process.env.GT_WEBHOOK_BLOCK_PRIVATE_IP === 'true',
): string | null {
  if (!hostname || typeof hostname !== 'string') {
    return 'Empty or invalid host';
  }

  const raw = hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .replace(/%.*$/, '')
    .toLowerCase();

  if (!raw) {
    return 'Empty or invalid host';
  }

  // Cloud metadata hostnames
  if (
    raw === 'metadata.google.internal' ||
    raw === 'metadata.goog' ||
    raw === 'instance-data' ||
    raw.endsWith('.metadata.google.internal') ||
    raw.endsWith('.metadata.goog')
  ) {
    return `Cloud metadata hostname (${raw}) is not allowed`;
  }

  // Localhost
  if (raw === 'localhost' || raw.endsWith('.localhost')) {
    if (blockPrivateIp) {
      return `Localhost (${raw}) is blocked by private IP policy`;
    }
    return null;
  }

  // Check IPv4
  if (net.isIPv4(raw)) {
    return checkIPv4(raw, blockPrivateIp);
  }

  // Check IPv6
  if (net.isIPv6(raw)) {
    return checkIPv6(raw, blockPrivateIp);
  }

  return null;
}

export interface ExecCallbackConfig {
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  secret?: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputBytes: number;
  context: any;
}

export interface HostSnapshot {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
}

export interface ExecCallbackPayload {
  event: 'exec.finished';
  timestamp: number;
  taskId: string;
  host: HostSnapshot;
  execution: {
    command: string;
    cwd: string;
    status: 'completed' | 'failed' | 'timeout' | 'killed';
    success: boolean;
    exitCode: number | null;
    startTime: number;
    endTime: number;
    durationMs: number;
    stdout: string;
    stderr: string;
    output: string;
    totalBytes: number;
    truncated: boolean;
  };
  context: any;
}

export function validateCallbackConfig(
  raw: unknown,
  options?: { blockPrivateIp?: boolean }
): {
  valid: boolean;
  config?: ExecCallbackConfig;
  error?: string;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'Callback config must be an object' };
  }

  const obj = raw as Record<string, any>;

  if (typeof obj.url !== 'string' || !obj.url.trim()) {
    return { valid: false, error: 'Field "callback.url" must be a non-empty string' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(obj.url.trim());
  } catch {
    return { valid: false, error: 'Field "callback.url" must be a valid URL' };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { valid: false, error: 'Field "callback.url" must use http or https protocol' };
  }

  const blockReason = isBlockedCallbackHost(parsedUrl.hostname, options?.blockPrivateIp);
  if (blockReason) {
    return { valid: false, error: `Field "callback.url" targets a blocked host: ${blockReason}` };
  }

  let method: 'POST' | 'PUT' = 'POST';
  if (obj.method !== undefined && obj.method !== null) {
    const m = String(obj.method).toUpperCase().trim();
    if (m !== 'POST' && m !== 'PUT') {
      return { valid: false, error: 'Field "callback.method" must be either POST or PUT' };
    }
    method = m as 'POST' | 'PUT';
  }

  const sanitizedHeaders: Record<string, string> = {};
  if (obj.headers !== undefined && obj.headers !== null) {
    if (typeof obj.headers !== 'object' || Array.isArray(obj.headers)) {
      return { valid: false, error: 'Field "callback.headers" must be a key-value object' };
    }
    const protectedHeaderPattern = /^(content-type|content-length|user-agent|host|connection|x-gt-.*)$/i;
    for (const [key, val] of Object.entries(obj.headers)) {
      if (typeof key === 'string' && !protectedHeaderPattern.test(key)) {
        sanitizedHeaders[key] = val !== undefined && val !== null ? String(val) : '';
      }
    }
  }

  let secret: string | undefined = undefined;
  if (typeof obj.secret === 'string' && obj.secret.length > 0) {
    secret = obj.secret;
  }

  const timeoutMs =
    typeof obj.timeoutMs === 'number' && !isNaN(obj.timeoutMs)
      ? Math.min(30000, Math.max(1000, Math.round(obj.timeoutMs)))
      : 10000;

  const maxRetries =
    typeof obj.maxRetries === 'number' && !isNaN(obj.maxRetries)
      ? Math.min(5, Math.max(0, Math.round(obj.maxRetries)))
      : 3;

  const maxOutputBytes =
    typeof obj.maxOutputBytes === 'number' && !isNaN(obj.maxOutputBytes)
      ? Math.min(1048576, Math.max(1024, Math.round(obj.maxOutputBytes)))
      : 65536;

  const context = obj.context !== undefined ? obj.context : null;

  return {
    valid: true,
    config: {
      url: obj.url.trim(),
      method,
      headers: sanitizedHeaders,
      ...(secret !== undefined ? { secret } : {}),
      timeoutMs,
      maxRetries,
      maxOutputBytes,
      context,
    },
  };
}

export function truncateUtf8Tail(
  text: string,
  maxBytes: number
): {
  text: string;
  truncated: boolean;
} {
  const safeText = text || '';
  const buf = Buffer.from(safeText, 'utf-8');
  if (buf.length <= maxBytes) {
    return { text: safeText, truncated: false };
  }

  const sliced = sliceBufferUtf8Safe(buf, buf.length - maxBytes);
  return { text: sliced, truncated: true };
}

interface PendingCallbackEntry {
  taskId: string;
  hostId: string;
  command: string;
  cwd?: string;
  startTime: number;
  callback: ExecCallbackConfig;
  hostSnapshot: HostSnapshot;
  ttlTimer?: NodeJS.Timeout;
}

export class TerminalExecCallbackService {
  private pendingCallbacks = new Map<string, PendingCallbackEntry>();
  private retryDelaysMs: number[];

  constructor(options?: { retryDelaysMs?: number[] }) {
    this.retryDelaysMs =
      options?.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : [1000, 5000, 15000, 30000, 60000];
  }

  public registerCallback(params: {
    taskId: string;
    hostId: string;
    command: string;
    cwd?: string;
    startTime?: number;
    taskTimeoutMs?: number;
    callback: ExecCallbackConfig;
  }): void {
    if (!params.taskId || !params.hostId || !params.callback) return;

    if (this.pendingCallbacks.has(params.taskId)) {
      const existing = this.pendingCallbacks.get(params.taskId);
      if (existing?.ttlTimer) {
        clearTimeout(existing.ttlTimer);
      }
    }

    const host = terminalHostManager.getHost(params.hostId);
    const hostSnapshot: HostSnapshot = {
      id: host?.id || params.hostId,
      name: host?.name || params.hostId,
      hostname: host?.hostname || params.hostId,
      ip: host?.ip || '0.0.0.0',
      platform: host?.platform || 'unknown',
    };

    const ttlMs = (params.taskTimeoutMs || 300000) + 120000;
    const ttlTimer = setTimeout(() => {
      this.pendingCallbacks.delete(params.taskId);
    }, ttlMs);
    if (ttlTimer.unref) ttlTimer.unref();

    this.pendingCallbacks.set(params.taskId, {
      taskId: params.taskId,
      hostId: params.hostId,
      command: params.command,
      cwd: params.cwd,
      startTime: params.startTime || Date.now(),
      callback: params.callback,
      hostSnapshot,
      ttlTimer,
    });
  }

  public hasPendingCallback(taskId: string): boolean {
    return this.pendingCallbacks.has(taskId);
  }

  public clearAll(): void {
    for (const entry of this.pendingCallbacks.values()) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    }
    this.pendingCallbacks.clear();
  }

  public async handleTaskFinished(hostId: string, event: any): Promise<boolean> {
    if (!event || !event.taskId) return false;
    const taskId = String(event.taskId);

    const entry = this.pendingCallbacks.get(taskId);
    if (!entry) return false;

    this.pendingCallbacks.delete(taskId);
    if (entry.ttlTimer) {
      clearTimeout(entry.ttlTimer);
    }

    const currentHost = terminalHostManager.getHost(hostId);
    const hostSnapshot: HostSnapshot = {
      id: currentHost?.id || entry.hostSnapshot.id,
      name: currentHost?.name || entry.hostSnapshot.name,
      hostname: currentHost?.hostname || entry.hostSnapshot.hostname,
      ip: currentHost?.ip || entry.hostSnapshot.ip,
      platform: currentHost?.platform || entry.hostSnapshot.platform,
    };

    const maxBytes = entry.callback.maxOutputBytes;
    const truncStdout = truncateUtf8Tail(event.stdout ?? '', maxBytes);
    const truncStderr = truncateUtf8Tail(event.stderr ?? '', maxBytes);
    const truncOutput = truncateUtf8Tail(event.output ?? '', maxBytes);
    const isTruncated = truncStdout.truncated || truncStderr.truncated || truncOutput.truncated;

    const status = event.status || (event.exitCode === 0 ? 'completed' : 'failed');
    const success = status === 'completed' && event.exitCode === 0;
    const startTime = event.startTime || entry.startTime;
    const endTime = event.endTime || Date.now();
    const durationMs =
      event.durationMs !== undefined ? event.durationMs : Math.max(0, endTime - startTime);
    const totalBytes =
      event.totalBytes !== undefined
        ? event.totalBytes
        : Buffer.byteLength(event.output || '', 'utf-8');

    const payload: ExecCallbackPayload = {
      event: 'exec.finished',
      timestamp: Date.now(),
      taskId: entry.taskId,
      host: hostSnapshot,
      execution: {
        command: event.command || entry.command,
        cwd: event.cwd || entry.cwd || '',
        status,
        success,
        exitCode: event.exitCode !== undefined ? event.exitCode : null,
        startTime,
        endTime,
        durationMs,
        stdout: truncStdout.text,
        stderr: truncStderr.text,
        output: truncOutput.text,
        totalBytes,
        truncated: isTruncated,
      },
      context: entry.callback.context !== undefined ? entry.callback.context : null,
    };

    return await this.deliverWithRetry(entry, payload);
  }

  private async deliverWithRetry(
    entry: PendingCallbackEntry,
    payload: ExecCallbackPayload
  ): Promise<boolean> {
    const maxRetries = entry.callback.maxRetries;
    const maxAttempts = 1 + maxRetries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      payload.timestamp = Date.now();
      const rawBody = JSON.stringify(payload);
      const bodyBuffer = Buffer.from(rawBody, 'utf-8');

      const headers: Record<string, string> = {
        ...entry.callback.headers,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(bodyBuffer.length),
        'user-agent': 'gt-hub-webhook/1.0',
        'x-gt-event': 'exec.finished',
        'x-gt-task-id': entry.taskId,
        'x-gt-timestamp': String(payload.timestamp),
        'x-gt-delivery-attempt': String(attempt),
      };

      if (entry.callback.secret) {
        const hmac = crypto.createHmac('sha256', entry.callback.secret);
        hmac.update(`${payload.timestamp}.${rawBody}`);
        headers['x-gt-signature-256'] = `sha256=${hmac.digest('hex')}`;
      }

      const outcome = await this.sendHttpRequest(
        entry.callback.url,
        entry.callback.method,
        headers,
        bodyBuffer,
        entry.callback.timeoutMs
      );

      if (outcome.success) {
        terminalLogService.addLog(
          'info',
          `[ExecCallback] Webhook delivered for task ${entry.taskId} to ${entry.callback.url} (status: ${outcome.statusCode}, attempt: ${attempt})`
        );
        return true;
      }

      if (
        outcome.statusCode &&
        outcome.statusCode >= 400 &&
        outcome.statusCode < 500 &&
        outcome.statusCode !== 408 &&
        outcome.statusCode !== 429
      ) {
        terminalLogService.addLog(
          'error',
          `[ExecCallback] Webhook delivery client error ${outcome.statusCode} for task ${entry.taskId} to ${entry.callback.url} (no retry)`
        );
        return false;
      }

      if (attempt >= maxAttempts) {
        terminalLogService.addLog(
          'error',
          `[ExecCallback] Webhook delivery failed after ${attempt} attempts for task ${entry.taskId} to ${entry.callback.url}: ${outcome.error || 'HTTP ' + outcome.statusCode}`
        );
        return false;
      }

      const delay =
        this.retryDelaysMs[attempt - 1] ??
        this.retryDelaysMs[this.retryDelaysMs.length - 1] ??
        1000;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
    }

    return false;
  }

  private sendHttpRequest(
    urlStr: string,
    method: 'POST' | 'PUT',
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(urlStr);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOptions: http.RequestOptions = {
          method,
          hostname: urlObj.hostname,
          port: urlObj.port ? parseInt(urlObj.port, 10) : isHttps ? 443 : 80,
          path: urlObj.pathname + urlObj.search,
          headers,
          timeout: timeoutMs,
          lookup: (hostname: string, opts: any, callback: any) => {
            dns.lookup(hostname, opts, (err, address, family) => {
              if (err) {
                return callback(err, address, family);
              }
              const addrs = Array.isArray(address) ? address : [{ address, family }];
              for (const item of addrs) {
                const targetIp = typeof item === 'string' ? item : item?.address;
                if (targetIp) {
                  const blocked = isBlockedCallbackHost(targetIp);
                  if (blocked) {
                    return callback(new Error(`Webhook host resolved to blocked IP (${targetIp}): ${blocked}`));
                  }
                }
              }
              callback(null, address, family);
            });
          },
        };

        const req = client.request(reqOptions, (res) => {
          res.resume();
          res.on('end', () => {
            const statusCode = res.statusCode || 0;
            if (statusCode >= 200 && statusCode < 300) {
              resolve({ success: true, statusCode });
            } else {
              resolve({
                success: false,
                statusCode,
                error: `HTTP ${statusCode}`,
              });
            }
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
        });

        req.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });

        req.write(body);
        req.end();
      } catch (err: any) {
        resolve({ success: false, error: err.message });
      }
    });
  }
}

export const terminalExecCallbackService = new TerminalExecCallbackService();
export default terminalExecCallbackService;
