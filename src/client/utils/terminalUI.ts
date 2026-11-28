import http from 'http';
import https from 'https';
import url from 'url';
import zlib from 'zlib';
import { quoteShellArg } from '../../shared/utils/shell';
import { isValidControlPayload } from '../../shared/protocol/binaryProtocol';

export { quoteShellArg };

export function exitWithError(message: string, code: number = 1): never {
  console.error(message.startsWith('Error:') || message.startsWith('[Error]') ? message : `Error: ${message}`);
  process.exit(code);
}

export function formatTemplate(template: string, items: any[] = []): string {
  if (typeof template !== 'string' || !template.trim()) return '';
  const isTable = /^table\s+/i.test(template.trim());
  const rawPattern = isTable ? template.trim().slice(5).trim() : template.trim();

  // Extract placeholder keys: {{.Field}}
  const keyMatches: Array<{ raw: string; key: string }> = [];
  const regex = /\{\{\s*\.([a-zA-Z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawPattern)) !== null) {
    keyMatches.push({ raw: match[0], key: match[1] });
  }

  const resolveVal = (item: any, key: string): string => {
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(item)) {
      if (k.toLowerCase() === lowerKey) {
        return v !== null && v !== undefined ? String(v) : '';
      }
    }
    // Fallback aliases
    if (lowerKey === 'taskid' && item.id) return String(item.id);
    if (lowerKey === 'id' && item.taskId) return String(item.taskId);
    if (lowerKey === 'exitcode' && item.exitCode !== undefined) return String(item.exitCode);
    return '';
  };

  if (!isTable) {
    return items.map((item) => {
      let line = rawPattern;
      for (const { raw, key } of keyMatches) {
        line = line.split(raw).join(resolveVal(item, key));
      }
      return line.replace(/\\t/g, '\t').replace(/\\n/g, '\n');
    }).join('\n');
  }

  // Table formatting
  const headerKeys = keyMatches.map(m => m.key);
  const headers = headerKeys.map(k => k.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase());

  const rows = items.map(item => headerKeys.map(k => resolveVal(item, k)));
  const allRows = [headers, ...rows];

  const colWidths = headers.map((_, colIdx) => {
    let max = 0;
    for (const row of allRows) {
      const len = (row[colIdx] || '').length;
      if (len > max) max = len;
    }
    return max;
  });

  return allRows.map((row) => {
    return row.map((cell, colIdx) => {
      if (colIdx === row.length - 1) return cell;
      return (cell || '').padEnd(colWidths[colIdx] + 3);
    }).join('').trimEnd();
  }).join('\n');
}

export function resolveTaskId(tasks: any[], input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Task identifier is required');
  }
  const cleanInput = input.trim();
  // 1. Exact match
  const exact = tasks.find(t => t.taskId === cleanInput);
  if (exact) return exact.taskId;

  // 2. Prefix match
  const matches = tasks.filter(t => t.taskId.startsWith(cleanInput) || t.taskId.includes(cleanInput));
  if (matches.length === 1) return matches[0].taskId;
  if (matches.length > 1) {
    const candidates = matches.map(m => `  - ${m.taskId}`).join('\n');
    throw new Error(`Ambiguous task identifier '${cleanInput}': matches multiple tasks:\n${candidates}`);
  }
  throw new Error(`No such task: '${cleanInput}'`);
}

export async function resolveHost(serverUrl: string, apiKey: string, input: string): Promise<{ id: string; name: string }> {
  if (!input || typeof input !== 'string') {
    throw new Error('Host identifier is required');
  }
  const cleanInput = input.trim();
  const res = await makeRequest({
    serverUrl,
    endpoint: '/api/terminal/hosts',
    method: 'GET',
    apiKey,
  });

  if (!res.data || !Array.isArray(res.data.hosts)) {
    throw new Error(`Failed to query hosts from server: ${res.data?.error || `HTTP ${res.status}`}`);
  }

  const hosts: any[] = res.data.hosts;
  const lowerInput = cleanInput.toLowerCase();
  // 1. Exact ID match
  const idMatch = hosts.find(h => h.id === cleanInput);
  if (idMatch) {
    return { id: idMatch.id, name: idMatch.name || idMatch.id };
  }

  // 2. Exact name match (case-sensitive first, then case-insensitive; reject ambiguous multiple online matches)
  const exactCaseNames = hosts.filter(h => h.name === cleanInput);
  const namePool = exactCaseNames.length > 0
    ? exactCaseNames
    : hosts.filter(h => h.name && h.name.toLowerCase() === lowerInput);

  if (namePool.length > 0) {
    const onlineMatches = namePool.filter(h => h.status === 'online');
    if (onlineMatches.length > 1) {
      const candidates = onlineMatches.map(m => `  - ${m.id} (${m.name || 'unnamed'})`).join('\n');
      throw new Error(`Ambiguous host identifier '${cleanInput}': matches multiple online hosts:\n${candidates}`);
    }
    const picked = onlineMatches[0] || namePool[0];
    return { id: picked.id, name: picked.name || picked.id };
  }

  // 3. Prefix match on id or name
  const matches = hosts.filter(h => {
    const idHit = h.id && h.id.toLowerCase().startsWith(lowerInput);
    const nameHit = h.name && h.name.toLowerCase().startsWith(lowerInput);
    return idHit || nameHit;
  });

  if (matches.length === 1) {
    return { id: matches[0].id, name: matches[0].name || matches[0].id };
  }
  if (matches.length > 1) {
    const onlineMatches = matches.filter(h => h.status === 'online');
    if (onlineMatches.length === 1) {
      return { id: onlineMatches[0].id, name: onlineMatches[0].name || onlineMatches[0].id };
    }
    const candidates = matches.map(m => `  - ${m.id} (${m.name || 'unnamed'})`).join('\n');
    throw new Error(`Ambiguous host identifier '${cleanInput}': matches multiple hosts:\n${candidates}`);
  }
  throw new Error(`No such host: '${cleanInput}'`);
}

export function isRemoteSpec(str: string): boolean {
  if (typeof str !== 'string') return false;
  // Exclude Windows drive letters: C:\ or D:/
  if (/^[a-zA-Z]:[\\/]/.test(str)) return false;
  const colonIdx = str.indexOf(':');
  return colonIdx > 0;
}

export function parseRemoteSpec(str: string): { host: string; path: string } {
  const colonIdx = str.indexOf(':');
  return {
    host: str.slice(0, colonIdx).trim(),
    path: str.slice(colonIdx + 1).trim() || '.',
  };
}

export function resolveEndpointUrl(
  serverUrl: string,
  endpoint: string,
  queryParams: Record<string, any> = {}
): string {
  const normalizedHttp = serverUrl.startsWith('http://') ||
    serverUrl.startsWith('https://') ||
    serverUrl.startsWith('ws://') ||
    serverUrl.startsWith('wss://')
    ? serverUrl
    : `http://${serverUrl}`;
  const parsed = new url.URL(normalizedHttp);
  parsed.search = '';
  parsed.hash = '';

  const [epPath, epQuery] = endpoint.split('?');
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}/${epPath.replace(/^\/+/, '')}`.replace(/\/+/g, '/');

  if (epQuery) {
    const epParams = new url.URLSearchParams(epQuery);
    for (const [k, v] of epParams.entries()) {
      parsed.searchParams.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== '') {
      parsed.searchParams.set(k, String(v));
    }
  }
  return parsed.toString();
}

export function resolveWsEndpointUrl(
  serverUrl: string,
  endpoint: string,
  queryParams: Record<string, any> = {}
): string {
  const safeParams: Record<string, any> = {};
  for (const [k, v] of Object.entries(queryParams)) {
    const lower = k.toLowerCase();
    if (
      lower !== 'key' &&
      lower !== 'x-admin-key' &&
      lower !== 'admin_key' &&
      lower !== 'ticket' &&
      lower !== 'timezone' &&
      v !== undefined &&
      v !== null &&
      v !== ''
    ) {
      safeParams[k] = v;
    }
  }
  const resolved = new url.URL(resolveEndpointUrl(serverUrl, endpoint, safeParams));
  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') {
    resolved.protocol = 'ws:';
  }
  return resolved.toString();
}

export function resolveWebSocketUrl(
  serverUrl: string,
  metadata: {
    hostId?: string;
    name?: string;
    hostname?: string;
    ip?: string;
    platform?: string;
    machineId?: string;
    version?: string;
    startTime?: number;
    [key: string]: any;
  } = {}
): string {
  return resolveWsEndpointUrl(serverUrl, '/api/terminal/agent-ws', metadata);
}

export function parseControlMessage(msgStr: string): any {
  if (typeof msgStr !== 'string') return null;
  const trimmed = msgStr.trim();
  if (trimmed.startsWith('JSON:')) {
    try {
      const parsed = JSON.parse(trimmed.slice(5));
      if (isValidControlPayload(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function makeRequest({
  serverUrl,
  endpoint,
  method = 'GET',
  body = null,
  apiKey = '',
  timeoutMs = 30000,
}: {
  serverUrl: string;
  endpoint: string;
  method?: string;
  body?: any;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;

    const safeResolve = (result: { status: number; data: any }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const targetUrl = new url.URL(resolveEndpointUrl(serverUrl, endpoint));
    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers: Record<string, any> = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    };
    if (apiKey) {
      headers['x-admin-key'] = apiKey;
    }

    let payload: string | null = null;
    if (body !== null && body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const reqOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: method.toUpperCase(),
      headers,
    };

    const req = client.request(reqOptions, (res) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        if (!settled) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      res.on('error', (err) => {
        safeReject(err);
      });
      res.on('close', () => {
        if (!settled && !res.complete) {
          safeReject(new Error(`Response closed prematurely (${method.toUpperCase()} ${endpoint})`));
        }
      });
      res.on('end', () => {
        if (settled) return;
        if (!res.complete) {
          safeReject(new Error(`Response ended prematurely (${method.toUpperCase()} ${endpoint})`));
          return;
        }
        const rawBuf = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        const finish = (decodedBuf: Buffer) => {
          const text = decodedBuf.toString('utf-8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
          safeResolve({ status: res.statusCode || 0, data: json });
        };

        if (rawBuf.length === 0) {
          finish(rawBuf);
          return;
        }
        if (encoding.includes('gzip')) {
          zlib.gunzip(rawBuf, (err, unzipped) => {
            finish(err ? rawBuf : unzipped);
          });
          return;
        }
        if (encoding.includes('deflate')) {
          zlib.inflate(rawBuf, (err, inflated) => {
            if (!err) {
              finish(inflated);
              return;
            }
            zlib.inflateRaw(rawBuf, (rawErr, rawInflated) => {
              finish(rawErr ? rawBuf : rawInflated);
            });
          });
          return;
        }
        finish(rawBuf);
      });
    });

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms (${method.toUpperCase()} ${endpoint})`);
        try { req.destroy(timeoutErr); } catch {}
        safeReject(timeoutErr);
      });
    }
    req.on('error', (err) => {
      safeReject(err);
    });
    req.on('close', () => {
      if (!responseStarted && !settled) {
        safeReject(new Error(`Connection closed prematurely (${method.toUpperCase()} ${endpoint})`));
      }
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}
