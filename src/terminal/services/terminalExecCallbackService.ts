import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import { sliceBufferUtf8Safe } from '../../agent/tasks/taskManager';
import { terminalHostManager } from './terminalHostManager';
import terminalLogService from './terminalLogService';

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

export function validateCallbackConfig(raw: unknown): {
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
      await new Promise((resolve) => setTimeout(resolve, delay));
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

        const reqOptions = {
          method,
          hostname: urlObj.hostname,
          port: urlObj.port ? parseInt(urlObj.port, 10) : isHttps ? 443 : 80,
          path: urlObj.pathname + urlObj.search,
          headers,
          timeout: timeoutMs,
        };

        const req = client.request(reqOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
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
