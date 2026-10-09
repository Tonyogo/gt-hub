import http from 'http';
import https from 'https';
import url from 'url';

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
  // 1. Exact match on id or name
  const exact = hosts.find(h => h.id === cleanInput || (h.name && h.name.toLowerCase() === cleanInput.toLowerCase()));
  if (exact) return { id: exact.id, name: exact.name || exact.id };

  // 2. Prefix match on id or name
  const matches = hosts.filter(h => {
    const idHit = h.id && h.id.toLowerCase().startsWith(cleanInput.toLowerCase());
    const nameHit = h.name && h.name.toLowerCase().startsWith(cleanInput.toLowerCase());
    return idHit || nameHit;
  });

  if (matches.length === 1) {
    return { id: matches[0].id, name: matches[0].name || matches[0].id };
  }
  if (matches.length > 1) {
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

export function quoteShellArg(arg: string): string {
  if (typeof arg !== 'string') return '';
  if (/^[a-zA-Z0-9_.\-\/=:@]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function resolveWebSocketUrl(serverUrl: string, metadata: Record<string, any> = {}): string {
  let wsUrl = serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    wsUrl = `ws://${wsUrl}`;
  }
  wsUrl = wsUrl.replace(/\/+$/, '');
  const cleanMeta = { ...metadata };
  delete cleanMeta.key;
  delete cleanMeta['x-admin-key'];
  const query = new URLSearchParams(cleanMeta);
  const qs = query.toString();
  return qs ? `${wsUrl}/api/terminal/agent-ws?${qs}` : `${wsUrl}/api/terminal/agent-ws`;
}

export function parseControlMessage(msgStr: string): any {
  if (typeof msgStr !== 'string') return null;
  const trimmed = msgStr.trim();
  if (trimmed.startsWith('JSON:')) {
    try {
      return JSON.parse(trimmed.slice(5));
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
}: {
  serverUrl: string;
  endpoint: string;
  method?: string;
  body?: any;
  apiKey?: string;
}): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const normalizedUrl = serverUrl.startsWith('http://') || serverUrl.startsWith('https://')
      ? serverUrl
      : `http://${serverUrl}`;
    const serverParsed = new url.URL(normalizedUrl);
    const isHttps = serverParsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const [epPath, epQuery] = endpoint.split('?');
    const basePath = serverParsed.pathname.replace(/\/+$/, '');
    const finalPathname = (basePath + '/' + epPath.replace(/^\/+/, '')).replace(/\/+/g, '/');
    const finalSearch = epQuery ? `?${epQuery}` : '';

    const headers: Record<string, any> = { 'Accept': 'application/json' };
    if (apiKey) {
      headers['x-admin-key'] = apiKey;
    }

    let payload: string | null = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const reqOptions = {
      protocol: serverParsed.protocol,
      hostname: serverParsed.hostname,
      port: serverParsed.port || (isHttps ? 443 : 80),
      path: `${finalPathname}${finalSearch}`,
      method: method.toUpperCase(),
      headers,
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode || 0, data: json });
      });
    });

    req.on('error', (err) => { reject(err); });
    if (payload) req.write(payload);
    req.end();
  });
}
