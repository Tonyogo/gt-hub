#!/usr/bin/env node

/**
 * gt (Gemini Terminal) - Unified Docker-Style Terminal CLI & Agent
 * Client operations (hosts, exec, ps, logs, kill) and reverse agent daemon (agent).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const url = require('url');
const { spawn, execSync } = require('child_process');
function createWebSocketAdapter() {
  class NativeWebSocketAdapter {
    constructor(url, options = {}) {
      this._ws = new globalThis.WebSocket(url, options);
      this._ws.binaryType = 'arraybuffer';
      this._listeners = new Map();

      this._ws.addEventListener('open', (e) => this._emit('open', e));
      this._ws.addEventListener('close', (e) => this._emit('close', e.code, e.reason));
      this._ws.addEventListener('error', (e) => {
        this._emit('error', e.error || new Error(e.message || 'WebSocket error'));
      });
      this._ws.addEventListener('message', (e) => {
        let data = e.data;
        const isBinary = data instanceof ArrayBuffer;
        if (isBinary) {
          data = Buffer.from(data);
        }
        this._emit('message', data, isBinary);
      });
    }

    get readyState() {
      return this._ws.readyState;
    }

    send(data) {
      return this._ws.send(data);
    }

    close(code, reason) {
      if (code !== undefined) {
        return this._ws.close(code, reason);
      }
      return this._ws.close();
    }

    terminate() {
      return this._ws.close();
    }

    on(event, handler) {
      if (!this._listeners.has(event)) {
        this._listeners.set(event, []);
      }
      this._listeners.get(event).push(handler);
      return this;
    }

    once(event, handler) {
      const onceWrapper = (...args) => {
        this.off(event, onceWrapper);
        handler(...args);
      };
      onceWrapper.listener = handler;
      return this.on(event, onceWrapper);
    }

    off(event, handler) {
      const list = this._listeners.get(event);
      if (list) {
        const idx = list.findIndex((h) => h === handler || h.listener === handler);
        if (idx !== -1) list.splice(idx, 1);
      }
      return this;
    }

    removeListener(event, handler) {
      return this.off(event, handler);
    }

    _emit(event, ...args) {
      const handlers = (this._listeners.get(event) || []).slice();
      for (const h of handlers) {
        try {
          h(...args);
        } catch (err) {
          console.error(`[WebSocket error in ${event}]:`, err);
        }
      }
    }
  }

  NativeWebSocketAdapter.prototype.CONNECTING = NativeWebSocketAdapter.CONNECTING = 0;
  NativeWebSocketAdapter.prototype.OPEN = NativeWebSocketAdapter.OPEN = 1;
  NativeWebSocketAdapter.prototype.CLOSING = NativeWebSocketAdapter.CLOSING = 2;
  NativeWebSocketAdapter.prototype.CLOSED = NativeWebSocketAdapter.CLOSED = 3;

  return NativeWebSocketAdapter;
}

let WebSocketImpl = null;
try {
  WebSocketImpl = require('ws');
} catch {}

if (!WebSocketImpl && typeof globalThis.WebSocket !== 'undefined') {
  WebSocketImpl = createWebSocketAdapter();
}

const WebSocket = WebSocketImpl;
function tryRequirePty() {
  if (process.env.GT_DISABLE_NODE_PTY) return null;
  try {
    return require('node-pty');
  } catch {}
  try {
    const cwdReq = require('module').createRequire(path.join(process.cwd(), 'dummy.js'));
    return cwdReq('node-pty');
  } catch {}
  try {
    const candidatePaths = [
      process.env.NODE_PATH,
      '/usr/lib/node_modules',
      '/usr/local/lib/node_modules',
      process.env.HOME ? path.join(process.env.HOME, '.node_modules') : null,
      process.env.HOME ? path.join(process.env.HOME, 'node_modules') : null,
    ].filter(Boolean);
    for (const p of candidatePaths) {
      try {
        const req = require('module').createRequire(path.join(p, 'dummy.js'));
        const mod = req('node-pty');
        if (mod) return mod;
      } catch {}
    }
  } catch {}
  return null;
}

let pty = tryRequirePty();

let dotenv;
try {
  dotenv = require('dotenv');
} catch {}

// Version metadata
const VERSION = '1.0.0';

// Auto-load .env from working directory
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    if (dotenv && typeof dotenv.config === 'function') {
      dotenv.config({ path: envPath });
    } else {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '').trim();
        }
      }
    }
  } catch {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '').trim();
      }
    }
  }
}

function printHelp() {
  console.log(`
gt (Gemini Terminal) - Unified Docker-Style Terminal CLI

Usage:
  gt [GLOBAL_OPTIONS] COMMAND [ARGS...]

Agent Lifecycle Commands:
  run [-d] [NAME]                 Run reverse terminal agent (foreground or daemon)
  ps [-a] [-l|--local]            List connected hosts (default: remote; -l for local)
  logs [-f] [-n 50] [NAME]        View local agent daemon logs
  stop [NAME] [--all]             Stop running agent daemon(s)
  restart [NAME]                  Restart local agent daemon
  rm [NAME] [--all]               Remove stopped agent daemon record(s)
  prune [-l|--local] [-a|--all]   Remove offline remote nodes (or -l for local agents)

Remote Execution Commands:
  exec [OPTIONS] <node> <cmd...>  Execute a command on a remote host
  cp <src> <dest>                 Copy files between local and remote host
  task ls <node> [OPTIONS]        List recent tasks on a host
  task logs [-f] <node> [taskId]  View or follow task execution logs
  task kill <node> <taskId>       Terminate a running task on a remote host

Authentication & Config:
  login [SERVER] [KEY]            Verify and save admin credentials
  logout                          Remove stored credentials
  config <list|get|set>           Manage local client configuration settings

Exec Options:
  -i, --interactive       Keep STDIN open for live or piped input
  -t, --tty               Allocate a pseudo-TTY with raw terminal input
  -it                     Interactive pseudo-terminal session (like 'docker exec -it')
  -d, --detach            Run command in background and print task ID
  -w, --workdir <dir>     Working directory on remote host
  --timeout <ms>          Execution timeout in ms (Default: 300000 / 5 min)
  -e, --env <KEY=VAL>     Set remote environment variable (can be repeated)
  --verbose               Show execution header and duration footer banners
  --poll-interval <ms>    Polling interval for log stream in ms (Default: 500)

Global Options:
  -s, --server <url>              Hub server URL (Default: env TERMINAL_SERVER or http://localhost:3000)
  -k, --key <secret>              Admin secret key (Default: env ADMIN_SECRET_KEY)
  --json                          Output in JSON format
  --format <template>             Format output using Go/Docker template (e.g. 'table {{.ID}}\\t{{.Name}}')
  -v, --version                   Print version information
  -h, --help                      Show this help menu

Aliases & Compatibility:
  agent run [-d] [NAME]           Alias for 'gt run'
  agent ps [-a|--all]             Alias for 'gt ps -l'
  agent logs [-f] [-n 50] [NAME]  Alias for 'gt logs'
  agent stop [NAME] [--all]       Alias for 'gt stop'
  agent restart [NAME]            Alias for 'gt restart'
  agent rm [NAME] [--all]         Alias for 'gt rm'
  agent prune                     Alias for 'gt prune -l'
  kill <node> <taskId>            Shortcut for 'gt task kill'

Examples:
  gt login http://localhost:3000 secret
  gt logout
  gt run -d worker-1
  gt ps [-a|--all]
  gt ps -l
  gt logs -f worker-1
  gt stop worker-1
  gt prune -l
  gt exec my-server uptime
  gt exec -it my-server bash
  gt task logs -f my-server task-123
  gt kill my-server task-123
  gt cp local.txt my-server:/tmp/remote.txt
  gt agent run -d worker-1
`);
}

function makeRequest({ serverUrl, endpoint, method = 'GET', body = null, apiKey = '' }) {
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

    const headers = { 'Accept': 'application/json' };
    if (apiKey) {
      headers['x-admin-key'] = apiKey;
    }

    let payload = null;
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
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', (err) => { reject(err); });
    if (payload) req.write(payload);
    req.end();
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  if (diff < 10000) return 'Just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatTemplate(template, items = []) {
  if (typeof template !== 'string' || !template.trim()) return '';
  const isTable = /^table\s+/i.test(template.trim());
  const rawPattern = isTable ? template.trim().slice(5).trim() : template.trim();

  // Extract placeholder keys: {{.Field}}
  const keyMatches = [];
  const regex = /\{\{\s*\.([a-zA-Z0-9_]+)\s*\}\}/g;
  let match;
  while ((match = regex.exec(rawPattern)) !== null) {
    keyMatches.push({ raw: match[0], key: match[1] });
  }

  const resolveVal = (item, key) => {
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

function resolveTaskId(tasks, input) {
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

async function resolveHost(serverUrl, apiKey, input) {
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

  const hosts = res.data.hosts;
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

function isRemoteSpec(str) {
  if (typeof str !== 'string') return false;
  // Exclude Windows drive letters: C:\ or D:/
  if (/^[a-zA-Z]:[\\/]/.test(str)) return false;
  const colonIdx = str.indexOf(':');
  return colonIdx > 0;
}

function parseRemoteSpec(str) {
  const colonIdx = str.indexOf(':');
  return {
    host: str.slice(0, colonIdx).trim(),
    path: str.slice(colonIdx + 1).trim() || '.',
  };
}

function parseCpArgs(args) {
  if (!args || args.length < 2) {
    throw new Error('Usage: gt cp <src> <dest>');
  }
  const [srcArg, destArg] = args;
  const srcIsRemote = isRemoteSpec(srcArg);
  const destIsRemote = isRemoteSpec(destArg);

  if (!srcIsRemote && !destIsRemote) {
    throw new Error('Invalid arguments: at least one argument must be remote (<host>:<path>)');
  }
  if (srcIsRemote && destIsRemote) {
    throw new Error('Invalid arguments: cannot copy between two remote hosts directly');
  }

  const src = srcIsRemote
    ? { isRemote: true, ...parseRemoteSpec(srcArg) }
    : { isRemote: false, path: srcArg };

  const dest = destIsRemote
    ? { isRemote: true, ...parseRemoteSpec(destArg) }
    : { isRemote: false, path: destArg };

  return { src, dest };
}

async function uploadLocalFile({ serverUrl, apiKey, hostId, localPath, remotePath }) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Local file not found: ${localPath}`);
  }
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    throw new Error(`Directory upload is not supported in single-file cp: ${localPath}`);
  }

  const filename = path.basename(localPath);
  const fileContent = fs.readFileSync(localPath);
  const boundary = `----GtFormBoundary${crypto.randomBytes(8).toString('hex')}`;

  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, fileContent, tail]);

  const endpoint = `/api/terminal/files/upload?hostId=${encodeURIComponent(hostId)}&path=${encodeURIComponent(remotePath || '.')}`;

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

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': payload.length,
  };
  if (apiKey) {
    headers['x-admin-key'] = apiKey;
  }

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: serverParsed.protocol,
      hostname: serverParsed.hostname,
      port: serverParsed.port || (isHttps ? 443 : 80),
      path: `${finalPathname}${finalSearch}`,
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        if (res.statusCode >= 400 || (json && json.success === false)) {
          return reject(new Error(`Upload failed: ${json?.error || `HTTP ${res.statusCode}`}`));
        }
        console.log(`Successfully copied ${localPath} -> [${hostId}]:${remotePath} (${(stat.size / 1024).toFixed(1)} KB)`);
        resolve(0);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function downloadRemoteFile({ serverUrl, apiKey, hostId, remotePath, localPath }) {
  const endpoint = `/api/terminal/files/download?hostId=${encodeURIComponent(hostId)}&path=${encodeURIComponent(remotePath)}`;

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

  let destFile = localPath;
  if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
    destFile = path.join(localPath, path.basename(remotePath));
  } else if (localPath.endsWith('/') || localPath.endsWith('\\')) {
    fs.mkdirSync(localPath, { recursive: true });
    destFile = path.join(localPath, path.basename(remotePath));
  }

  const parentDir = path.dirname(destFile);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const partFile = `${destFile}.part`;

  const maxRetries = 10;
  let retryCount = 0;

  const executeDownload = (allowResume = true) => {
    return new Promise((resolve, reject) => {
      let isSettled = false;
      let attemptHandled = false;
      let writeStream = null;
      let req = null;
      let res = null;

      const safeCleanup = () => {
        if (res) {
          try {
            if (writeStream) res.unpipe(writeStream);
            res.removeAllListeners();
            res.destroy();
          } catch {}
          res = null;
        }
        if (req) {
          try {
            req.removeAllListeners();
            req.destroy();
          } catch {}
          req = null;
        }
        if (writeStream) {
          try {
            writeStream.removeAllListeners();
            writeStream.destroy();
          } catch {}
          writeStream = null;
        }
      };

      const handleRetryOrReject = (err) => {
        if (isSettled || attemptHandled) return;
        attemptHandled = true;
        safeCleanup();

        if (retryCount >= maxRetries) {
          isSettled = true;
          reject(new Error(`Download failed after ${maxRetries} retries: ${err.message}`));
          return;
        }

        retryCount++;
        const backoffMs = Math.min(500 * Math.pow(1.5, retryCount - 1), 3000);
        console.warn(`[gt cp] Transfer interrupted (${err.message}). Resuming in ${(backoffMs / 1000).toFixed(1)}s (retry ${retryCount}/${maxRetries})...`);
        setTimeout(() => {
          if (isSettled) return;
          executeDownload(true).then(resolve, reject);
        }, backoffMs);
      };

      const headers = {};
      if (apiKey) {
        headers['x-admin-key'] = apiKey;
      }

      let existingBytes = 0;
      if (allowResume && fs.existsSync(partFile)) {
        try {
          existingBytes = fs.statSync(partFile).size;
        } catch {
          existingBytes = 0;
        }
      }

      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`;
      }

      req = client.request({
        protocol: serverParsed.protocol,
        hostname: serverParsed.hostname,
        port: serverParsed.port || (isHttps ? 443 : 80),
        path: `${finalPathname}${finalSearch}`,
        method: 'GET',
        headers,
      }, (incomingRes) => {
        res = incomingRes;

        // If 416 (Range Not Satisfiable), our .part file might be corrupted or complete. Reset and redownload.
        if (res.statusCode === 416) {
          safeCleanup();
          try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch {}
          if (allowResume) {
            attemptHandled = true;
            return executeDownload(false).then(resolve, reject);
          }
          attemptHandled = true;
          isSettled = true;
          reject(new Error('Download failed: 416 Range Not Satisfiable'));
          return;
        }

        if (res.statusCode >= 400) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(data); } catch { json = { raw: data }; }
            const errorMsg = json?.error || `HTTP ${res.statusCode}`;

            // Transient server errors (500, 502, 503, 504) or rate limit (429) may be temporary (e.g. agent reconnecting).
            if (res.statusCode >= 500 || res.statusCode === 429) {
              handleRetryOrReject(new Error(errorMsg));
              return;
            }

            if (isSettled || attemptHandled) return;
            attemptHandled = true;
            isSettled = true;
            safeCleanup();
            reject(new Error(`Download failed: ${errorMsg}`));
          });
          res.on('error', (err) => {
            handleRetryOrReject(err);
          });
          return;
        }

        const isPartial = res.statusCode === 206;
        const writeFlags = isPartial ? 'a' : 'w';
        const currentExistingBytes = isPartial ? existingBytes : 0;

        let expectedTotal = null;
        if (isPartial && res.headers['content-range']) {
          const crMatch = res.headers['content-range'].match(/\/(\d+)/);
          if (crMatch) {
            expectedTotal = parseInt(crMatch[1], 10);
          }
        }
        if (res.headers['content-length']) {
          const sessionLen = parseInt(res.headers['content-length'], 10);
          if (expectedTotal === null && !isNaN(sessionLen)) {
            expectedTotal = currentExistingBytes + sessionLen;
          }
        }

        writeStream = fs.createWriteStream(partFile, { flags: writeFlags });

        let sessionBytes = 0;
        res.on('data', (chunk) => {
          sessionBytes += chunk.length;
        });

        res.pipe(writeStream);

        res.on('error', (err) => {
          handleRetryOrReject(err);
        });

        res.on('close', () => {
          if (!res?.complete && !isSettled) {
            handleRetryOrReject(new Error('Connection closed prematurely by server'));
          }
        });

        writeStream.on('finish', () => {
          if (isSettled || attemptHandled) return;

          let currentSize = 0;
          try {
            currentSize = fs.statSync(partFile).size;
          } catch {}

          if (!res?.complete || (expectedTotal !== null && currentSize !== expectedTotal)) {
            if (expectedTotal !== null && currentSize > expectedTotal) {
              // Corrupted .part file is larger than expected remote file: reset and redownload from scratch
              safeCleanup();
              try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch {}
              attemptHandled = true;
              executeDownload(false).then(resolve, reject);
              return;
            }
            handleRetryOrReject(new Error(`Incomplete download: received ${currentSize} bytes${expectedTotal !== null ? `/${expectedTotal}` : ''}`));
            return;
          }

          try {
            if (fs.existsSync(destFile)) {
              fs.unlinkSync(destFile);
            }
            fs.renameSync(partFile, destFile);
            attemptHandled = true;
            isSettled = true;
            safeCleanup();
            const totalBytes = currentSize;
            console.log(`Successfully copied [${hostId}]:${remotePath} -> ${destFile} (${(totalBytes / 1024).toFixed(1)} KB${isPartial ? ' [resumed]' : ''})`);
            resolve(0);
          } catch (renameErr) {
            attemptHandled = true;
            isSettled = true;
            safeCleanup();
            reject(new Error(`Failed to finalize local file: ${renameErr.message}`));
          }
        });

        writeStream.on('error', (err) => {
          if (isSettled || attemptHandled) return;
          attemptHandled = true;
          isSettled = true;
          safeCleanup();
          reject(new Error(`Failed to write local file: ${err.message}`));
        });
      });

      req.on('error', (err) => {
        handleRetryOrReject(err);
      });

      req.end();
    });
  };

  return executeDownload(true);
}

async function runCp(serverUrl, apiKey, args) {
  const { src, dest } = parseCpArgs(args);

  if (src.isRemote) {
    const resolved = await resolveHost(serverUrl, apiKey, src.host);
    return await downloadRemoteFile({
      serverUrl,
      apiKey,
      hostId: resolved.id,
      remotePath: src.path,
      localPath: dest.path,
    });
  } else {
    const resolved = await resolveHost(serverUrl, apiKey, dest.host);
    return await uploadLocalFile({
      serverUrl,
      apiKey,
      hostId: resolved.id,
      localPath: src.path,
      remotePath: dest.path,
    });
  }
}

// --------------------------------------------------------------------------
// Agent Daemon Subsystem (Embedded)
// --------------------------------------------------------------------------

const HANDSHAKE_TIMEOUT_MS = 4000;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 20000;

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getDefaultShell(options = {}) {
  if (options.shell) return options.shell;
  if (os.platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  if (fs.existsSync('/usr/bin/bash')) return '/usr/bin/bash';
  if (fs.existsSync('/bin/sh')) return '/bin/sh';
  return '/bin/sh';
}

function resolveWorkingDir(cwd) {
  const defaultDir = os.homedir() || process.env.HOME || process.cwd();
  if (!cwd || typeof cwd !== 'string') return defaultDir;
  let trimmed = cwd.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return defaultDir;
  const home = os.homedir() || process.env.HOME || defaultDir;
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(path.join(home, trimmed.slice(2)));
  }
  return path.resolve(trimmed);
}

function resolveWebSocketUrl(serverUrl, metadata = {}) {
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

function parseControlMessage(msgStr) {
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

class ConfigStore {
  static getConfigDir() {
    return process.env.GT_CONFIG_DIR || path.join(os.homedir(), '.gt');
  }

  static getConfigFile() {
    return path.join(this.getConfigDir(), 'config.json');
  }

  static load() {
    try {
      const p = this.getConfigFile();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}
    return {};
  }

  static save(data) {
    const dir = this.getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }

  static clear() {
    try {
      const file = this.getConfigFile();
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {}
  }

  static get(key) {
    const data = this.load();
    return data[key];
  }

  static getMachineId() {
    const config = this.load();
    if (config.machineId && typeof config.machineId === 'string' && config.machineId.length > 0) {
      return config.machineId;
    }
    const id = crypto.randomBytes(6).toString('hex');
    config.machineId = id;
    this.save(config);
    return id;
  }

  static set(key, val) {
    const data = this.load();
    if (val === undefined || val === null || val === '') {
      delete data[key];
    } else {
      data[key] = val;
    }
    this.save(data);
  }

  static getEffectiveConfig(cliOpts = {}) {
    const stored = this.load();
    const server = (cliOpts && cliOpts.server) ||
      process.env.TERMINAL_SERVER ||
      process.env.GEMINI_PROXY_URL ||
      stored.server ||
      'http://localhost:3000';
    const key = (cliOpts && cliOpts.key) ||
      process.env.ADMIN_SECRET_KEY ||
      stored.key ||
      '';
    return { server, key };
  }
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child) return;
  const pid = typeof child === 'number' ? child : child.pid;
  if (!pid) return;
  const isWindows = os.platform() === 'win32';
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch (e) {
    if (child && typeof child.kill === 'function') {
      try { child.kill(signal); } catch {}
    } else {
      try { process.kill(pid, signal); } catch {}
    }
  }
}

function killProcessTreeSync(pid, signal = 'SIGTERM') {
  if (!pid) return;
  const isWindows = os.platform() === 'win32';
  try {
    if (isWindows) {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch (e) {
    try { process.kill(pid, signal); } catch {}
  }
}

class AgentDaemonManager {
  static getAgentsDir() {
    const dir = path.join(ConfigStore.getConfigDir(), 'agents');
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    }
    return dir;
  }

  static sanitizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
  }

  static getStatusFile(name) {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const all = this.getAllAgents();
      if (all.length > 0) sName = all[0].name;
      else sName = 'agent';
    }
    return path.join(this.getAgentsDir(), `${sName}.json`);
  }

  static getLogFile(name) {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const all = this.getAllAgents();
      if (all.length > 0) sName = all[0].name;
      else sName = 'agent';
    }
    return path.join(this.getAgentsDir(), `${sName}.log`);
  }

  static isProcessAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  static getAgent(name) {
    const sName = this.sanitizeName(name);
    if (!sName) return null;
    const p = path.join(this.getAgentsDir(), `${sName}.json`);
    if (!fs.existsSync(p)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const alive = this.isProcessAlive(state.pid);
      return {
        name: sName,
        running: alive,
        stale: !alive,
        ...state,
      };
    } catch {
      return null;
    }
  }

  static getStatus(name) {
    const res = this.resolveTarget(name, 'status');
    if (res.agent) {
      return res.agent;
    }
    return { running: false };
  }

  static getAllAgents() {
    const dir = this.getAgentsDir();
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const list = [];
      for (const file of files) {
        const name = file.slice(0, -5);
        const agent = this.getAgent(name);
        if (agent) list.push(agent);
      }
      return list.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  static printAgentsTable(showAll = false) {
    const all = this.getAllAgents();
    if (all.length === 0) {
      console.log('No agent daemons found.');
      process.exit(0);
    }
    const displayed = showAll ? all : all.filter(a => a.running);
    const stoppedCount = all.filter(a => !a.running).length;

    if (displayed.length === 0) {
      if (stoppedCount > 0) {
        console.log(`No running agent daemons found. (${stoppedCount} stopped, use -a to show or 'gt agent prune' to clean up)`);
      } else {
        console.log('No agent daemons found.');
      }
      process.exit(0);
    }

    console.log(
      'NAME'.padEnd(20) +
      'STATUS'.padEnd(12) +
      'PID'.padEnd(10) +
      'TARGET HUB'.padEnd(30) +
      'STARTED'
    );
    console.log('-'.repeat(95));
    for (const a of displayed) {
      const statusStr = a.running ? 'Running' : 'Stopped';
      console.log(
        (a.name || '').padEnd(20) +
        statusStr.padEnd(12) +
        String(a.pid || '').padEnd(10) +
        (a.server || '').padEnd(30) +
        (a.startTime || '')
      );
    }

    if (!showAll && stoppedCount > 0) {
      console.log(`\n(${stoppedCount} stopped agent(s) hidden. Use 'gt agent ps -a' to view all or 'gt agent prune' to clean up)`);
    }

    process.exit(0);
  }

  static prune() {
    return this.removeAll();
  }

  static saveStatus(nameOrState, maybeState) {
    let name, state;
    if (typeof nameOrState === 'string') {
      name = nameOrState;
      state = maybeState || {};
    } else {
      state = nameOrState || {};
      name = state.name;
    }
    const sName = this.sanitizeName(name) || 'agent';
    const dir = this.getAgentsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${sName}.json`);
    const data = { name: sName, ...state };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }

  static clearStatus(name) {
    if (!name) return;
    const sName = this.sanitizeName(name);
    if (!sName) return;
    try {
      const p = path.join(this.getAgentsDir(), `${sName}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  static resolveTarget(name, actionName = 'operate') {
    if (name) {
      const sName = this.sanitizeName(name);
      const agent = this.getAgent(sName);
      if (!agent) {
        return { agent: null, error: `Error: Agent "${sName}" not found.` };
      }
      return { agent };
    }

    const all = this.getAllAgents();
    const running = all.filter(a => a.running);
    if (running.length === 1) {
      return { agent: running[0] };
    }
    if (running.length === 0) {
      if (all.length === 1) return { agent: all[0] };
      return { agent: null, error: `No active agent found to ${actionName}.` };
    }

    const names = running.map(a => `"${a.name}"`).join(', ');
    return {
      agent: null,
      error: `Error: Multiple running agents (${names}). Please specify agent NAME (e.g. gt ${actionName} <NAME>).`,
    };
  }

  static async stop(name) {
    const sName = this.sanitizeName(name);
    let agent = sName ? this.getAgent(sName) : null;
    if (!agent && !sName) {
      const resolved = this.resolveTarget(undefined, 'stop');
      if (resolved.agent) agent = resolved.agent;
    }
    if (!agent || !agent.running) {
      const display = sName || (agent ? agent.name : 'daemon');
      return { success: true, message: `Agent "${display}" is not running.` };
    }

    const realName = agent.name;
    const pid = agent.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}

    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!this.isProcessAlive(pid)) {
        return { success: true, pid, name: realName, message: `Agent "${realName}" (PID: ${pid}) stopped successfully.` };
      }
      await new Promise(r => setTimeout(r, 100));
    }

    killProcessTreeSync(pid, 'SIGKILL');
    return { success: true, pid, name: realName, message: `Agent "${realName}" (PID: ${pid}) forcibly terminated.` };
  }

  static async stopAll() {
    const all = this.getAllAgents();
    const running = all.filter(a => a.running);
    const results = [];
    for (const a of running) {
      results.push(await this.stop(a.name));
    }
    return results;
  }

  static remove(name, { removeLogs = false } = {}) {
    const sName = this.sanitizeName(name);
    const agent = this.getAgent(sName);
    if (agent && agent.running) {
      return { success: false, message: `Error: Cannot remove running agent "${sName}". Stop it first.` };
    }
    this.clearStatus(sName);
    if (removeLogs) {
      try {
        const lf = path.join(this.getAgentsDir(), `${sName}.log`);
        if (fs.existsSync(lf)) fs.unlinkSync(lf);
      } catch {}
    }
    return { success: true, message: `Agent "${sName}" removed.` };
  }

  static removeAll() {
    const all = this.getAllAgents();
    const removed = [];
    for (const a of all) {
      if (!a.running) {
        this.remove(a.name, { removeLogs: true });
        removed.push(a.name);
      }
    }
    return { removed };
  }

  static async getLogs(name, lines = 50, follow = false) {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const resolved = this.resolveTarget(undefined, 'logs');
      if (resolved.agent) sName = resolved.agent.name;
    }
    const logFile = path.join(this.getAgentsDir(), `${sName || 'agent'}.log`);
    if (!fs.existsSync(logFile)) {
      console.log(`No logs found for agent "${sName || 'daemon'}".`);
      return;
    }

    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const count = parseInt(lines, 10) || 50;
    const slice = allLines.slice(-count);
    if (slice.length > 0) {
      process.stdout.write(slice.join('\n') + '\n');
    }

    if (!follow) return;

    let currentSize = fs.statSync(logFile).size;
    const pollInterval = 200;

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        try {
          if (!fs.existsSync(logFile)) return;
          const newSize = fs.statSync(logFile).size;
          if (newSize > currentSize) {
            const stream = fs.createReadStream(logFile, {
              start: currentSize,
              end: newSize - 1,
              encoding: 'utf-8',
            });
            stream.on('data', chunk => process.stdout.write(chunk));
            currentSize = newSize;
          } else if (newSize < currentSize) {
            currentSize = newSize;
          }
        } catch {}
      }, pollInterval);

      const cleanup = () => {
        clearInterval(timer);
        resolve();
      };

      process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
      });
    });
  }
}

class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.MAX_TASKS = 100;
    this.MAX_BUFFER_SIZE = 5 * 1024 * 1024;
    this.TASK_TTL_MS = 24 * 60 * 60 * 1000;
  }

  pruneOldTasks() {
    const now = Date.now();
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== 'running' && (now - task.startTime > this.TASK_TTL_MS)) {
        this.tasks.delete(taskId);
      }
    }
    if (this.tasks.size > this.MAX_TASKS) {
      const sorted = Array.from(this.tasks.entries())
        .filter(([, t]) => t.status !== 'running')
        .sort((a, b) => a[1].startTime - b[1].startTime);
      while (this.tasks.size > this.MAX_TASKS && sorted.length > 0) {
        const [oldId] = sorted.shift();
        this.tasks.delete(oldId);
      }
    }
  }

  startTask({ taskId, command, cwd, timeoutMs = 300000, env = {}, stdin = null }) {
    this.pruneOldTasks();

    if (this.tasks.has(taskId)) {
      const existing = this.tasks.get(taskId);
      return { success: true, taskId, status: existing.status, startTime: existing.startTime };
    }

    let workingDir = resolveWorkingDir(cwd);
    if (cwd) {
      if (!fs.existsSync(workingDir)) {
        return {
          success: false,
          error: `Working directory does not exist: ${workingDir}`,
        };
      }
      try {
        const stat = fs.statSync(workingDir);
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: `Working directory is not a directory: ${workingDir}`,
          };
        }
      } catch (err) {
        return {
          success: false,
          error: `Cannot access working directory: ${err.message}`,
        };
      }
    } else {
      if (!fs.existsSync(workingDir)) {
        workingDir = process.cwd();
      }
    }

    const isWindows = os.platform() === 'win32';
    let shell = (env && env.SHELL && fs.existsSync(env.SHELL)) ? env.SHELL : getDefaultShell();
    if (!isWindows && !fs.existsSync(shell)) {
      if (fs.existsSync('/bin/bash')) shell = '/bin/bash';
      else if (fs.existsSync('/usr/bin/bash')) shell = '/usr/bin/bash';
      else if (fs.existsSync('/bin/sh')) shell = '/bin/sh';
    }
    const shellArgs = isWindows
      ? (shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command])
      : ['-c', command];

    const taskEnv = {
      ...process.env,
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    delete taskEnv.TMUX;
    delete taskEnv.TMUX_PANE;
    delete taskEnv.STY;
    delete taskEnv.WINDOW;
    delete taskEnv.TERM_SESSION_ID;

    let child = null;
    try {
      child = spawn(shell, shellArgs, {
        cwd: workingDir,
        env: taskEnv,
        stdio: [stdin !== null && stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: !isWindows,
      });
      if (child.stdin && stdin !== null && stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    } catch (err) {
      return { success: false, error: `Failed to spawn process: ${err.message}` };
    }

    const taskRecord = {
      taskId,
      command,
      cwd: workingDir,
      status: 'running',
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      stdout: '',
      stderr: '',
      output: '',
      totalBytes: 0,
      chunks: [],
      child,
      timeoutTimer: null,
      killTimer: null,
    };

    const appendChunk = (type, chunk) => {
      const text = chunk.toString('utf-8');
      const bytes = Buffer.byteLength(text, 'utf-8');
      const startOffset = taskRecord.totalBytes;
      const endOffset = startOffset + bytes;
      taskRecord.totalBytes = endOffset;
      taskRecord.chunks.push({ type, text, startOffset, endOffset });

      if (type === 'stdout') {
        taskRecord.stdout += text;
        if (taskRecord.stdout.length > this.MAX_BUFFER_SIZE) {
          taskRecord.stdout = taskRecord.stdout.slice(-this.MAX_BUFFER_SIZE);
        }
      } else {
        taskRecord.stderr += text;
        if (taskRecord.stderr.length > this.MAX_BUFFER_SIZE) {
          taskRecord.stderr = taskRecord.stderr.slice(-this.MAX_BUFFER_SIZE);
        }
      }
      taskRecord.output += text;
      if (taskRecord.output.length > this.MAX_BUFFER_SIZE) {
        taskRecord.output = taskRecord.output.slice(-this.MAX_BUFFER_SIZE);
      }

      while (taskRecord.chunks.length > 1 && taskRecord.totalBytes - taskRecord.chunks[0].startOffset > this.MAX_BUFFER_SIZE) {
        taskRecord.chunks.shift();
      }
    };

    child.stdout.on('data', (chunk) => appendChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => appendChunk('stderr', chunk));

    child.on('error', (err) => {
      let extra = '';
      if (err.code === 'ENOENT') {
        if (!fs.existsSync(workingDir)) {
          extra = ` (working directory "${workingDir}" not found)`;
        } else if (!fs.existsSync(shell)) {
          extra = ` (shell executable "${shell}" not found)`;
        }
      }
      appendChunk('stderr', Buffer.from(`\nProcess execution error: ${err.message}${extra}\n`));
      taskRecord.status = 'failed';
      taskRecord.endTime = Date.now();
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
    });

    child.on('close', (code, signal) => {
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
      if (taskRecord.killTimer) clearTimeout(taskRecord.killTimer);
      taskRecord.endTime = Date.now();
      taskRecord.child = null;

      if (taskRecord.status === 'running') {
        if (signal) {
          taskRecord.status = 'killed';
        } else {
          taskRecord.exitCode = code;
          taskRecord.status = code === 0 ? 'completed' : 'failed';
        }
      }
    });

    if (timeoutMs > 0) {
      taskRecord.timeoutTimer = setTimeout(() => {
        if (taskRecord.status === 'running' && taskRecord.child) {
          taskRecord.status = 'timeout';
          const timeoutMsg = `\n[Agent] Process timed out after ${timeoutMs}ms. Terminating...\n`;
          appendChunk('stderr', Buffer.from(timeoutMsg));
          killProcessTree(taskRecord.child, 'SIGTERM');
          if (taskRecord.killTimer) clearTimeout(taskRecord.killTimer);
          taskRecord.killTimer = setTimeout(() => {
            if (taskRecord.child) {
              killProcessTree(taskRecord.child, 'SIGKILL');
            }
          }, 1000);
          if (taskRecord.killTimer.unref) taskRecord.killTimer.unref();
        }
      }, timeoutMs);
      if (taskRecord.timeoutTimer.unref) taskRecord.timeoutTimer.unref();
    }

    this.tasks.set(taskId, taskRecord);
    return {
      success: true,
      taskId,
      status: 'running',
      command,
      cwd: workingDir,
      startTime: taskRecord.startTime,
    };
  }

  getTask(taskId, offset = 0) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `No such task: ${taskId}` };
    }

    const numOffset = Math.max(0, parseInt(offset, 10) || 0);
    const totalBytes = task.totalBytes !== undefined ? task.totalBytes : Buffer.byteLength(task.output, 'utf-8');

    let incStdout = '';
    let incStderr = '';
    let incOutput = '';

    if (numOffset === 0 && (!task.chunks || task.chunks.length === 0)) {
      incStdout = task.stdout;
      incStderr = task.stderr;
      incOutput = task.output;
    } else if (task.chunks && task.chunks.length > 0) {
      for (const chunk of task.chunks) {
        if (chunk.endOffset <= numOffset) {
          continue;
        }
        let chunkText = chunk.text;
        if (chunk.startOffset < numOffset) {
          const byteSliceStart = numOffset - chunk.startOffset;
          const buf = Buffer.from(chunk.text, 'utf-8');
          chunkText = buf.slice(byteSliceStart).toString('utf-8');
        }
        if (chunk.type === 'stdout') {
          incStdout += chunkText;
        } else if (chunk.type === 'stderr') {
          incStderr += chunkText;
        }
        incOutput += chunkText;
      }
    }

    return {
      success: true,
      taskId: task.taskId,
      status: task.status,
      exitCode: task.exitCode,
      stdout: incStdout,
      stderr: incStderr,
      output: incOutput,
      offset: totalBytes,
      outputOffset: totalBytes,
      totalBytes,
      durationMs: (task.endTime || Date.now()) - task.startTime,
      startTime: task.startTime,
      endTime: task.endTime,
    };
  }

  _killChild(child, signal = 'SIGTERM') {
    return killProcessTree(child, signal);
  }

  killTask(taskId, signal = 'SIGTERM') {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `No such task: ${taskId}` };
    }
    if (task.status !== 'running' || !task.child) {
      return { success: true, taskId, status: task.status, message: 'Task is not running' };
    }

    task.status = 'killed';
    killProcessTree(task.child, signal || 'SIGTERM');

    if (task.killTimer) clearTimeout(task.killTimer);
    task.killTimer = setTimeout(() => {
      if (task.child) {
        killProcessTree(task.child, 'SIGKILL');
      }
    }, 1000);
    if (task.killTimer.unref) task.killTimer.unref();

    return { success: true, taskId, status: 'killed', message: `Signal ${signal} sent` };
  }

  listTasks(limit = 20) {
    const list = Array.from(this.tasks.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit)
      .map((t) => ({
        taskId: t.taskId,
        command: t.command,
        cwd: t.cwd,
        status: t.status,
        exitCode: t.exitCode,
        durationMs: (t.endTime || Date.now()) - t.startTime,
        startTime: t.startTime,
        endTime: t.endTime,
      }));
    return { success: true, tasks: list };
  }
}

let _cachedHasPython3 = undefined;
function hasSystemPython3(forceRefresh = false) {
  if (!forceRefresh && _cachedHasPython3 !== undefined) return _cachedHasPython3;
  if (os.platform() === 'win32') {
    _cachedHasPython3 = false;
    return false;
  }
  try {
    const res = execSync('python3 -c "import pty; print(1)"', { stdio: 'pipe', timeout: 1000 });
    _cachedHasPython3 = res.toString().trim() === '1';
  } catch {
    _cachedHasPython3 = false;
  }
  return _cachedHasPython3;
}

class NodePtyDriver {
  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }) {
    this.onData = onData;
    this.onExit = onExit;
    const isWindows = os.platform() === 'win32';
    const shellArgs = isWindows
      ? (shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command])
      : ['-c', command];

    this.proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });

    this.proc.onData((data) => this.onData(data));
    this.proc.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
  }

  write(buf) {
    if (this.proc) {
      try {
        const str = Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
        this.proc.write(str);
      } catch {}
    }
  }

  resize(cols, rows) {
    if (this.proc && typeof this.proc.resize === 'function') {
      try {
        this.proc.resize(Math.max(10, cols || 80), Math.max(5, rows || 24));
      } catch {}
    }
  }

  kill(signal = 'SIGTERM') {
    if (this.proc) {
      try {
        this.proc.kill(signal);
      } catch {}
    }
  }
}

class PosixPtyDriver {
  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }) {
    this.onData = onData;
    this.onExit = onExit;
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));

    const pyScript = `
import os, sys, pty, termios, fcntl, struct, select, signal, atexit

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd_to_run = sys.argv[3:]

master, slave = pty.openpty()
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except:
    pass

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvp(cmd_to_run[0], cmd_to_run)
else:
    os.close(slave)
    def sig_resize(signum, frame):
        pass
    signal.signal(signal.SIGWINCH, sig_resize)

    def cleanup():
        try:
            os.killpg(pid, signal.SIGKILL)
        except:
            try:
                os.kill(pid, signal.SIGKILL)
            except:
                pass
    atexit.register(cleanup)

    def sig_cleanup(signum, frame):
        cleanup()
        sys.exit(128 + signum)
    signal.signal(signal.SIGTERM, sig_cleanup)
    signal.signal(signal.SIGINT, sig_cleanup)

    # Non-blocking IO loop between sys.stdin/stdout, ctl_fd, and master
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    stdin_fileno = sys.stdin.fileno()
    stdin_closed = False

    ctl_fd = 3
    ctl_closed = False
    try:
        fl_ctl = fcntl.fcntl(ctl_fd, fcntl.F_GETFL)
        fcntl.fcntl(ctl_fd, fcntl.F_SETFL, fl_ctl | os.O_NONBLOCK)
    except Exception:
        ctl_closed = True

    ctl_buf = ""

    while True:
        read_fds = [master]
        if not stdin_closed:
            read_fds.append(stdin_fileno)
        if not ctl_closed:
            read_fds.append(ctl_fd)
        try:
            r, w, x = select.select(read_fds, [], [], 0.05)
        except (InterruptedError, select.error):
            continue

        if not ctl_closed and ctl_fd in r:
            try:
                ctl_data = os.read(ctl_fd, 1024)
                if not ctl_data:
                    ctl_closed = True
                else:
                    ctl_buf += ctl_data.decode("utf-8", "replace")
                    while "\\n" in ctl_buf:
                        line, ctl_buf = ctl_buf.split("\\n", 1)
                        line = line.strip()
                        if line.startswith("RESIZE "):
                            parts = line.split()
                            if len(parts) >= 3:
                                try:
                                    new_cols, new_rows = int(parts[1]), int(parts[2])
                                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", new_rows, new_cols, 0, 0))
                                except Exception:
                                    pass
            except (OSError, EOFError):
                ctl_closed = True

        if not stdin_closed and stdin_fileno in r:
            try:
                data = os.read(stdin_fileno, 4096)
                if not data:
                    stdin_closed = True
                else:
                    os.write(master, data)
            except (OSError, EOFError):
                stdin_closed = True

        if master in r:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
                sys.stdout.flush()
            except (BlockingIOError, OSError):
                pass

        # Check child status
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            # Drain remaining
            try:
                while True:
                    data = os.read(master, 4096)
                    if not data: break
                    os.write(sys.stdout.fileno(), data)
                    sys.stdout.flush()
            except:
                pass
            if hasattr(os, "waitstatus_to_exitcode"):
                exit_code = os.waitstatus_to_exitcode(status)
            else:
                exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128 + os.WTERMSIG(status))
            sys.exit(exit_code)

    try:
        _, status = os.waitpid(pid, 0)
        if hasattr(os, "waitstatus_to_exitcode"):
            exit_code = os.waitstatus_to_exitcode(status)
        else:
            exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128 + os.WTERMSIG(status))
    except:
        exit_code = 0
    sys.exit(exit_code)
`;

    const trimmed = (command || '').trim();
    const isSimpleShell = ['bash', 'sh', 'zsh'].includes(trimmed) ||
      ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'].includes(trimmed);
    const targetArgs = isSimpleShell ? [trimmed, '-i'] : [shell, '-c', command];

    this.proc = spawn('python3', [
      '-c', pyScript,
      String(this.cols),
      String(this.rows),
      ...targetArgs
    ], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });

    this.ctlStream = this.proc.stdio && this.proc.stdio[3] ? this.proc.stdio[3] : null;

    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => this.onData(chunk));
    this.proc.on('close', (code, signal) => this.onExit(code, signal));
  }

  write(buf) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed && !this.proc.stdin.writableEnded) {
      try {
        const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        this.proc.stdin.write(buffer);
      } catch {}
    }
  }

  resize(cols, rows) {
    const targetCols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    const targetRows = Math.max(5, Math.min(200, Math.floor(rows || 24)));
    if (this.cols === targetCols && this.rows === targetRows) {
      const now = Date.now();
      if (!this._nudgeTimer && (!this._lastNudge || now - this._lastNudge > 1000)) {
        this._lastNudge = now;
        const nudgeRows = targetRows > 5 ? targetRows - 1 : targetRows + 1;
        if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
          try {
            this.ctlStream.write(`RESIZE ${targetCols} ${nudgeRows}\n`);
            this._nudgeTimer = setTimeout(() => {
              this._nudgeTimer = null;
              if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
                try {
                  this.ctlStream.write(`RESIZE ${targetCols} ${targetRows}\n`);
                } catch {}
              }
            }, 30);
          } catch {}
        }
      }
      return;
    }
    if (this._nudgeTimer) {
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = null;
    }
    this.cols = targetCols;
    this.rows = targetRows;
    if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
      try {
        this.ctlStream.write(`RESIZE ${this.cols} ${this.rows}\n`);
      } catch {}
    }
  }

  kill(signal = 'SIGTERM') {
    if (this.ctlStream) {
      try {
        this.ctlStream.end();
      } catch {}
    }
    if (this.proc) {
      killProcessTree(this.proc, signal);
    }
  }
}

class InteractivePipeDriver {
  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }) {
    this.onData = onData;
    this.onExit = onExit;
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));

    const isWindows = os.platform() === 'win32';
    const trimmed = (command || '').trim();
    const isSimpleShell = ['bash', 'sh', 'zsh'].includes(trimmed) ||
      ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'].includes(trimmed);

    let spawnCmd = shell;
    let spawnArgs = [];

    if (isWindows) {
      spawnArgs = shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command];
    } else {
      if (isSimpleShell) {
        spawnCmd = trimmed;
        spawnArgs = ['-i'];
      } else {
        spawnArgs = ['-c', command];
      }
    }

    this.proc = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
    });

    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => this.onData(chunk));
    this.proc.on('close', (code, signal) => this.onExit(code, signal));
  }

  write(buf) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) return;
    try {
      const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      // 规范化: 如果收到 Ctrl+C (0x03)，向进程发送 SIGINT
      if (buffer.length === 1 && buffer[0] === 0x03) {
        this.kill('SIGINT');
        return;
      }
      // 如果收到 Ctrl+D (0x04)，结束输入
      if (buffer.length === 1 && buffer[0] === 0x04) {
        this.proc.stdin.end();
        return;
      }

      // CR '\r' (0x0d) 转换为 LF '\n' (0x0a)
      const normalized = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        normalized[i] = buffer[i] === 0x0d ? 0x0a : buffer[i];
      }
      this.proc.stdin.write(normalized);
    } catch {}
  }

  resize(cols, rows) {
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));
  }

  kill(signal = 'SIGTERM') {
    if (this.proc) {
      killProcessTree(this.proc, signal);
    }
  }
}

class StreamSessionManager {
  constructor(sendFn) {
    this.send = sendFn;
    this.sessions = new Map();
  }

  startStream({ taskId, command, cwd, env = {}, cols = 80, rows = 24, timeoutMs = 0, tty = true, interactive = false, _forceFallback = false, _forcePipeFallback = false }) {
    const workingDir = resolveWorkingDir(cwd);
    if (cwd && !fs.existsSync(workingDir)) {
      const errMsg = Buffer.from(`\r\n\x1b[31m[Error] Working directory does not exist: ${workingDir}\x1b[0m\r\n`);
      this.send({ type: 'cmd_stream_data', taskId, data: errMsg.toString('base64') });
      this.send({ type: 'cmd_stream_exit', taskId, exitCode: 1, signal: null });
      return;
    }
    const shell = getDefaultShell();
    const taskEnv = {
      ...process.env,
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };

    let driver = null;
    let driverType = null;
    const canUseNodePty = Boolean(tty && pty && !_forceFallback && !_forcePipeFallback);

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
      this.send({
        type: 'cmd_stream_data',
        taskId,
        data: buf.toString('base64'),
      });
    };

    const onExit = (code, signal) => {
      const session = this.sessions.get(taskId);
      if (session && session.timeoutTimer) clearTimeout(session.timeoutTimer);
      this.sessions.delete(taskId);
      this.send({
        type: 'cmd_stream_exit',
        taskId,
        exitCode: code !== null && code !== undefined ? code : (signal ? 130 : 0),
        signal: signal || null,
      });
    };

    if (canUseNodePty) {
      // 1. Layer 1: NodePtyDriver
      try {
        driver = new NodePtyDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'node-pty';
      } catch (err) {
        driver = null;
      }
    }

    if (!driver && tty && !_forcePipeFallback && hasSystemPython3()) {
      // 2. Layer 2: PosixPtyDriver (轻量原生 POSIX PTY)
      try {
        driver = new PosixPtyDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'posix-pty';
      } catch (err) {
        driver = null;
      }
    }

    if (!driver) {
      // 3. Layer 3: InteractivePipeDriver (纯管道兜底)
      if (tty && (!pty || _forcePipeFallback)) {
        const warnMsg = Buffer.from('\r\n\x1b[33m[Warning] node-pty not available on agent; running in interactive pipe mode.\x1b[0m\r\n');
        this.send({ type: 'cmd_stream_data', taskId, data: warnMsg.toString('base64') });
      }
      try {
        driver = new InteractivePipeDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'pipe-fallback';
      } catch (err) {
        this.send({ type: 'cmd_stream_exit', taskId, exitCode: 1, signal: null });
        return;
      }
    }

    const session = {
      taskId,
      driverType,
      driver,
      isPty: driverType === 'node-pty' || driverType === 'posix-pty',
      proc: driver.proc,
      timeoutTimer: null,
    };

    if (timeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        this.kill(taskId, 'SIGTERM');
      }, timeoutMs);
    }

    this.sessions.set(taskId, session);
  }

  writeInput(taskId, base64Data) {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      const buf = Buffer.from(base64Data, 'base64');
      session.driver.write(buf);
    } catch {}
  }

  resize(taskId, cols, rows) {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      session.driver.resize(cols, rows);
    } catch {}
  }

  kill(taskId, signal = 'SIGTERM') {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      session.driver.kill(signal);
    } catch {}
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    this.sessions.delete(taskId);
  }

  killAll() {
    for (const taskId of Array.from(this.sessions.keys())) {
      this.kill(taskId, 'SIGTERM');
    }
  }
}

const taskManager = new TaskManager();

function handleFileRpc(control, targetWs) {
  const { reqId, action, path: targetPath, params = {} } = control;
  const reply = (success, data = null, error = null) => {
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(`JSON:${JSON.stringify({
        type: 'file_rpc_res',
        reqId,
        success,
        data,
        error
      })}`);
    }
  };

  try {
    const resolvedPath = resolveWorkingDir(targetPath);

    if (action === 'list') {
      if (!fs.existsSync(resolvedPath)) {
        return reply(false, null, `Path not found: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return reply(false, null, 'Target is not a directory');
      }
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        const full = path.join(resolvedPath, entry.name);
        try {
          const entryStat = fs.statSync(full);
          const isDir = entry.isDirectory();
          files.push({
            name: entry.name,
            path: full,
            isDirectory: isDir,
            size: isDir ? 0 : entryStat.size,
            updatedAt: entryStat.mtimeMs,
            extension: isDir ? '' : path.extname(entry.name).replace(/^\./, '').toLowerCase(),
          });
        } catch {}
      }
      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      const parsed = path.parse(resolvedPath);
      return reply(true, {
        currentPath: resolvedPath,
        parentPath: parsed.root === resolvedPath ? null : path.dirname(resolvedPath),
        separator: path.sep,
        files
      });
    }

    if (action === 'read') {
      if (!fs.existsSync(resolvedPath)) return reply(false, null, 'File not found');
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) return reply(false, null, 'Target is a directory');
      if (stat.size > 5 * 1024 * 1024) return reply(false, null, 'File exceeds 5MB preview limit');
      const buf = fs.readFileSync(resolvedPath);
      const isBinary = buf.slice(0, 1024).includes(0);
      return reply(true, {
        path: resolvedPath,
        size: stat.size,
        isBinary,
        content: isBinary ? '' : buf.toString('utf-8')
      });
    }

    if (action === 'write') {
      fs.writeFileSync(resolvedPath, params.content || '', 'utf-8');
      return reply(true, { success: true });
    }

    if (action === 'mkdir') {
      const full = path.join(resolvedPath, params.dirName || 'new-folder');
      fs.mkdirSync(full, { recursive: true });
      return reply(true, { success: true });
    }

    if (action === 'rename') {
      const newPath = resolveWorkingDir(params.newPath);
      fs.renameSync(resolvedPath, newPath);
      return reply(true, { success: true });
    }

    if (action === 'delete') {
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        fs.rmSync(resolvedPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolvedPath);
      }
      return reply(true, { success: true });
    }

    if (action === 'upload_chunk') {
      const full = path.join(resolvedPath, params.filename);
      const buf = Buffer.from(params.data || '', 'base64');
      fs.writeFileSync(full, buf);
      return reply(true, { success: true });
    }

    if (action === 'stat') {
      if (!fs.existsSync(resolvedPath)) return reply(false, null, 'File not found');
      const stat = fs.statSync(resolvedPath);
      return reply(true, {
        size: stat.size,
        mtime: stat.mtimeMs,
        isDirectory: stat.isDirectory(),
      });
    }

    if (action === 'download_chunk') {
      if (!fs.existsSync(resolvedPath)) return reply(false, null, 'File not found');
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) return reply(false, null, 'Target is a directory');

      const hasSliceParams = params && (params.offset !== undefined || params.length !== undefined);
      if (!hasSliceParams) {
        const buf = fs.readFileSync(resolvedPath);
        return reply(true, buf.toString('base64'));
      }

      const offset = Number(params.offset) || 0;
      const length = params.length !== undefined ? Number(params.length) : (stat.size - offset);

      if (isNaN(offset) || isNaN(length) || offset < 0 || length < 0 || offset > stat.size) {
        return reply(false, null, 'Invalid offset or length');
      }

      if (length === 0 || offset === stat.size) {
        return reply(true, { data: '', size: stat.size, offset, length: 0 });
      }

      const safeLength = Math.min(length, stat.size - offset);
      const fd = fs.openSync(resolvedPath, 'r');
      try {
        const buffer = Buffer.alloc(safeLength);
        const bytesRead = fs.readSync(fd, buffer, 0, safeLength, offset);
        const chunk = bytesRead < safeLength ? buffer.slice(0, bytesRead) : buffer;
        return reply(true, {
          data: chunk.toString('base64'),
          size: stat.size,
          offset,
          length: bytesRead,
        });
      } finally {
        fs.closeSync(fd);
      }
    }

    reply(false, null, `Unknown action: ${action}`);
  } catch (err) {
    reply(false, null, err.message);
  }
}

function handleCmdExec(control, targetWs) {
  const { reqId, action, taskId, command, cwd, timeoutMs, env, stdin, offset, signal, limit } = control;

  const reply = (success, data = null, error = null) => {
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(
        `JSON:${JSON.stringify({
          type: 'cmd_exec_res',
          reqId,
          taskId,
          success,
          data,
          error,
        })}`
      );
    }
  };

  try {
    if (action === 'start') {
      const res = taskManager.startTask({ taskId, command, cwd, timeoutMs, env, stdin });
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'poll' || action === 'status' || action === 'stream') {
      const res = taskManager.getTask(taskId, offset || 0);
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'kill') {
      const res = taskManager.killTask(taskId, signal);
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'list') {
      const res = taskManager.listTasks(limit);
      return reply(true, res);
    }

    reply(false, null, `Unknown cmd_exec action: ${action}`);
  } catch (err) {
    reply(false, null, err.message);
  }
}

async function runAgent(agentArgs = [], globalOpts = {}) {
  const firstArg = agentArgs[0];
  const subCmd = (firstArg && !firstArg.startsWith('-')) ? firstArg.toLowerCase() : null;

  const options = {};
  let positionalName = null;
  const knownSubCmds = ['start', 'restart', 'run', 'status', 'ps', 'stop', 'logs', 'rm', 'prune'];

  for (let i = 0; i < agentArgs.length; i++) {
    const arg = agentArgs[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx).trim();
        const v = arg.slice(eqIdx + 1).trim();
        options[k] = v;
      } else {
        const k = arg.slice(2).trim();
        if (i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) {
          options[k] = agentArgs[++i];
        } else {
          options[k] = true;
        }
      }
    } else if (arg.startsWith('-') && arg !== '-d') {
      const k = arg.slice(1);
      if (i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) {
        options[k] = agentArgs[++i];
      }
    } else if (!arg.startsWith('-')) {
      if (!knownSubCmds.includes(arg.toLowerCase()) && !positionalName) {
        positionalName = arg;
      }
    }
  }

  // Lifecycle subcommands that don't start the agent
  if (subCmd === 'ps') {
    const showAll = agentArgs.includes('-a') || agentArgs.includes('--all');
    AgentDaemonManager.printAgentsTable(showAll);
  }

  if (subCmd === 'prune') {
    const { removed } = AgentDaemonManager.prune();
    if (removed.length === 0) {
      console.log('No stopped agents to prune.');
    } else {
      console.log(`Pruned stopped agents: ${removed.join(', ')}`);
    }
    process.exit(0);
  }

  if (subCmd === 'status') {
    const all = AgentDaemonManager.getAllAgents();
    const running = all.filter(a => a.running);
    if (running.length === 0) {
      console.log('No background agent running.');
      process.exit(0);
    }
    console.log(
      'STATUS'.padEnd(12) +
      'PID'.padEnd(10) +
      'HOST NAME'.padEnd(25) +
      'TARGET HUB'.padEnd(30) +
      'STARTED'
    );
    console.log('-'.repeat(95));
    for (const status of running) {
      console.log(
        'Running'.padEnd(12) +
        String(status.pid).padEnd(10) +
        (status.name || '').padEnd(25) +
        (status.server || '').padEnd(30) +
        (status.startTime || '')
      );
    }
    process.exit(0);
  }

  if (subCmd === 'stop') {
    const hasAll = agentArgs.includes('--all') || agentArgs.includes('-a');
    if (hasAll) {
      const results = await AgentDaemonManager.stopAll();
      if (results.length === 0) {
        console.log('No running agents to stop.');
      } else {
        for (const r of results) {
          console.log(r.message);
        }
      }
      process.exit(0);
    }

    const resolved = AgentDaemonManager.resolveTarget(positionalName, 'stop');
    if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }

    const res = await AgentDaemonManager.stop(resolved.agent.name);
    console.log(res.message);
    process.exit(0);
  }

  if (subCmd === 'logs') {
    let lines = 50;
    let follow = false;
    let targetName = positionalName;
    const logArgs = agentArgs.slice(1);
    for (let i = 0; i < logArgs.length; i++) {
      const a = logArgs[i];
      if (a === '-f' || a === '--follow') {
        follow = true;
      } else if (a === '-n' || a === '--lines') {
        lines = parseInt(logArgs[++i], 10) || 50;
      } else if (a.startsWith('-n=')) {
        lines = parseInt(a.slice(3), 10) || 50;
      } else if (a.startsWith('--lines=')) {
        lines = parseInt(a.slice(8), 10) || 50;
      } else if (!a.startsWith('-') && !targetName) {
        targetName = a;
      }
    }
    const resolved = AgentDaemonManager.resolveTarget(targetName, 'logs');
    if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }
    await AgentDaemonManager.getLogs(resolved.agent.name, lines, follow);
    process.exit(0);
  }

  if (subCmd === 'rm') {
    const hasAll = agentArgs.includes('--all') || agentArgs.includes('-a');
    if (hasAll) {
      const { removed } = AgentDaemonManager.removeAll();
      if (removed.length === 0) {
        console.log('No stopped agents to remove.');
      } else {
        console.log(`Removed agents: ${removed.join(', ')}`);
      }
      process.exit(0);
    }

    let targetName = positionalName;
    if (!targetName) {
      const resolved = AgentDaemonManager.resolveTarget(undefined, 'remove');
      if (resolved.agent) {
        targetName = resolved.agent.name;
      } else {
        console.error('Error: Please specify agent NAME to remove (e.g. gt agent rm <NAME>).');
        process.exit(1);
      }
    }

    const res = AgentDaemonManager.remove(targetName, { removeLogs: true });
    if (!res.success) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(res.message);
    process.exit(0);
  }

  if (subCmd && !['start', 'restart', 'run'].includes(subCmd)) {
    console.error(`Error: Unknown agent subcommand: '${subCmd}'.`);
    console.error("Usage: gt agent [start|-d|status|ps|stop|restart|logs|rm] [OPTIONS]");
    process.exit(1);
  }

  const hostname = os.hostname();
  const sanitizedHostname = hostname.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';
  const defaultName = sanitizedHostname;

  let sanitizedName = options.name
    ? AgentDaemonManager.sanitizeName(options.name)
    : (positionalName ? AgentDaemonManager.sanitizeName(positionalName) : '');

  // If subcommand is restart and no name was explicitly given, resolve target dynamically
  if (subCmd === 'restart' && !sanitizedName) {
    const resolved = AgentDaemonManager.resolveTarget(undefined, 'restart');
    if (resolved.agent) {
      sanitizedName = resolved.agent.name;
    } else if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }
  }

  const hostName = sanitizedName || defaultName;

  const machineId = ConfigStore.getMachineId();
  let hostId = options.id || options.hostId;
  if (!hostId) {
    if (hostName === sanitizedHostname) {
      hostId = machineId;
    } else {
      hostId = `${machineId}-${hostName}`;
    }
  }

  if (subCmd === 'restart') {
    await AgentDaemonManager.stop(hostName);
  }

  // 1. Check for removed flags
  if ((globalOpts.cliServer !== null && globalOpts.cliServer !== undefined) || options.server || agentArgs.some(a => a === '-s' || a.startsWith('--server') || a.startsWith('-s='))) {
    console.error("Error: '--server' is removed. Please use 'gt auth login <server> <key>' to authenticate.");
    process.exit(1);
  }
  if ((globalOpts.cliKey !== null && globalOpts.cliKey !== undefined) || options.key || agentArgs.some(a => a === '-k' || a.startsWith('--key') || a.startsWith('-k='))) {
    console.error("Error: '--key' is removed. Please use 'gt auth login <server> <key>' to authenticate.");
    process.exit(1);
  }

  // 2. Enforce authentication from ConfigStore
  const stored = ConfigStore.load();
  const effectiveServer = process.env.TERMINAL_SERVER || process.env.GEMINI_PROXY_URL || stored.server;
  const effectiveKey = process.env.ADMIN_SECRET_KEY || stored.key;

  if (!effectiveServer || !effectiveKey) {
    console.error("Error: No authenticated server found. Please run 'gt auth login <server> <key>' first.");
    process.exit(1);
  }

  const serverArg = effectiveServer;
  const adminKey = effectiveKey;

  const isInternalDaemon = agentArgs.includes('--internal-daemon');
  const isDaemon = subCmd === 'start' || subCmd === 'restart' || agentArgs.includes('-d') || agentArgs.includes('--detach');

  if (!isInternalDaemon) {
    const current = AgentDaemonManager.getAgent(hostName);
    if (current && current.running) {
      console.error(`Error: Agent "${hostName}" is already running (PID: ${current.pid}). Use 'gt stop ${hostName}' or 'gt restart ${hostName}'.`);
      process.exit(1);
    }
  }

  if (isDaemon && !isInternalDaemon) {
    const cleanArgs = [];
    for (let i = 0; i < agentArgs.length; i++) {
      const a = agentArgs[i];
      if (knownSubCmds.includes(a.toLowerCase()) || a === '-d' || a === '--detach' || a === '--internal-daemon') {
        continue;
      }
      if (a === '--name' || a === '--id' || a === '--hostId') {
        i++;
        continue;
      }
      if (a.startsWith('--name=') || a.startsWith('--id=') || a.startsWith('--hostId=')) {
        continue;
      }
      if (a === positionalName) {
        continue;
      }
      cleanArgs.push(a);
    }
    cleanArgs.push(`--name=${hostName}`);
    cleanArgs.push(`--id=${hostId}`);

    const logFile = AgentDaemonManager.getLogFile(hostName);
    const logFd = fs.openSync(logFile, 'a', 0o600);

    const child = spawn(
      process.execPath,
      [path.resolve(__filename), 'agent', '--internal-daemon', ...cleanArgs],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      }
    );

    AgentDaemonManager.saveStatus(hostName, {
      pid: child.pid,
      name: hostName,
      id: hostId,
      server: effectiveServer,
      startTime: new Date().toISOString(),
      logFile: logFile,
    });

    child.unref();
    fs.closeSync(logFd);

    console.log(`Agent started in background (PID: ${child.pid}, Host: ${hostName})`);
    console.log(`Logs: ${logFile}`);
    console.log(`Run 'gt agent logs -f ${hostName}' to follow logs.`);
    console.log(`Run 'gt agent stop ${hostName}' to stop agent.`);
    process.exit(0);
  }

  if (!isDaemon && !isInternalDaemon) {
    AgentDaemonManager.saveStatus(hostName, {
      pid: process.pid,
      name: hostName,
      id: hostId,
      server: effectiveServer,
      startTime: new Date().toISOString(),
    });
    const cleanupFg = () => {
      AgentDaemonManager.clearStatus(hostName);
    };
    process.on('exit', cleanupFg);
    process.on('SIGINT', cleanupFg);
    process.on('SIGTERM', cleanupFg);
  }

  const platform = os.platform();
  const localIp = getLocalIp();

  if (fs.existsSync(envPath)) {
    console.log('[Agent] Loaded .env configuration');
  }

  console.log('---------------------------------------------------------');
  console.log(' Gemini Proxy Terminal Reverse Agent (gt agent)');
  console.log(` Host ID   : ${hostId}`);
  console.log(` Host Name : ${hostName} (${hostname})`);
  console.log(` IP / OS   : ${localIp} / ${platform}`);
  console.log(` Target Hub: ${serverArg}`);
  console.log('---------------------------------------------------------');

  let ptyProcess = null;
  let ws = null;
  let streamSessionManager = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isExiting = false;
  let connectTimeoutTimer = null;
  let heartbeatTimer = null;
  let heartbeatTimeoutTimer = null;
  const pendingOutputQueue = [];
  const maxPendingQueueBytes = 256 * 1024; // 256KB early buffer
  let pendingQueueBytes = 0;
  let lastNudgeTimestamp = 0;
  let nudgeRestoreTimer = null;

  function flushPendingOutput() {
    if (ws && ws.readyState === WebSocket.OPEN && pendingOutputQueue.length > 0) {
      while (pendingOutputQueue.length > 0) {
        const chunk = pendingOutputQueue.shift();
        pendingQueueBytes -= chunk.length;
        try {
          ws.send(chunk);
        } catch {
          break;
        }
      }
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
        } catch {}

        if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = setTimeout(() => {
          console.warn(
            `[Agent] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS / 1000}s) on ${serverArg}. Terminating dead connection...`
          );
          if (ws) {
            try { ws.terminate(); } catch {}
          }
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function onHeartbeatActivity() {
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function spawnPty() {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }

    const shell = getDefaultShell(options);
    const cwd = process.env.HOME || process.cwd();
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM_PROGRAM: 'gemini-proxy-agent',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN || '1',
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.STY;
    delete env.WINDOW;
    delete env.TERM_SESSION_ID;

    const cols = 80;
    const rows = 24;

    const sendToWs = (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      if (ws && ws.readyState === WebSocket.OPEN && pendingOutputQueue.length === 0) {
        try {
          ws.send(buf);
          return;
        } catch {}
      }
      pendingOutputQueue.push(buf);
      pendingQueueBytes += buf.length;
      while (pendingQueueBytes > maxPendingQueueBytes && pendingOutputQueue.length > 0) {
        const dropped = pendingOutputQueue.shift();
        pendingQueueBytes -= dropped.length;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        flushPendingOutput();
      }
    };

    // 1. Layer 1: node-pty (C++ native addon)
    if (pty) {
      try {
        const proc = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env,
        });

        proc.onData((data) => {
          sendToWs(data);
        });

        proc.onExit(({ exitCode }) => {
          console.log(`[PTY] Shell exited with code: ${exitCode}`);
          ptyProcess = null;
          if (!isExiting) {
            setTimeout(spawnPty, 500);
          }
        });

        ptyProcess = proc;
        console.log(`[PTY] Shell spawned via node-pty: ${shell} (pid=${ptyProcess.pid})`);
        return;
      } catch (err) {
        console.warn(`[PTY] node-pty spawn failed: ${err.message}, attempting fallback...`);
        ptyProcess = null;
      }
    }

    // 2. Layer 2: PosixPtyDriver (Python 3 system PTY fallback)
    if (!ptyProcess && hasSystemPython3()) {
      try {
        const driver = new PosixPtyDriver({
          command: shell,
          shell,
          cwd,
          env,
          cols,
          rows,
          onData: (data) => {
            sendToWs(data);
          },
          onExit: (code) => {
            console.log(`[PTY] Shell (PosixPty) exited with code: ${code}`);
            ptyProcess = null;
            if (!isExiting) {
              setTimeout(spawnPty, 500);
            }
          },
        });

        ptyProcess = {
          pid: driver.proc ? driver.proc.pid : 0,
          cols,
          rows,
          write: (data) => driver.write(data),
          resize: (c, r) => {
            ptyProcess.cols = c;
            ptyProcess.rows = r;
            driver.resize(c, r);
          },
          kill: (sig) => driver.kill(sig),
        };

        console.log(`[PTY] Shell spawned via PosixPty (Python 3): ${shell} (pid=${ptyProcess.pid})`);
        return;
      } catch (err) {
        console.warn(`[PTY] PosixPty fallback failed: ${err.message}, attempting pipe fallback...`);
        ptyProcess = null;
      }
    }

    // 3. Layer 3: InteractivePipeDriver (Pure Pipe Fallback)
    if (!ptyProcess) {
      try {
        const driver = new InteractivePipeDriver({
          command: shell,
          shell,
          cwd,
          env,
          cols,
          rows,
          onData: (data) => {
            sendToWs(data);
          },
          onExit: (code) => {
            console.log(`[PTY] Shell (InteractivePipe) exited with code: ${code}`);
            ptyProcess = null;
            if (!isExiting) {
              setTimeout(spawnPty, 500);
            }
          },
        });

        ptyProcess = {
          pid: driver.proc ? driver.proc.pid : 0,
          cols,
          rows,
          write: (data) => driver.write(data),
          resize: (c, r) => {
            ptyProcess.cols = c;
            ptyProcess.rows = r;
            driver.resize(c, r);
          },
          kill: (sig) => driver.kill(sig),
        };

        console.log(`[PTY] Shell spawned via InteractivePipe: ${shell} (pid=${ptyProcess.pid})`);
        sendToWs(Buffer.from('\r\n\x1b[33m[Notice] node-pty not available on agent; running in interactive pipe fallback mode.\x1b[0m\r\n'));
        return;
      } catch (err) {
        console.error(`[PTY] All PTY drivers failed to spawn shell: ${err.message}`);
        ptyProcess = null;
        sendToWs(Buffer.from(`\r\n\x1b[31m[Error] Failed to spawn shell on agent: ${err.message}\x1b[0m\r\n`));
      }
    }
  }

  function connect() {
    if (isExiting) return;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();

    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {}
      ws = null;
    }

    const targetWsUrl = resolveWebSocketUrl(serverArg, {
      hostId,
      name: hostName,
      hostname,
      ip: localIp,
      platform,
    });
    console.log(`[Agent] Connecting to ${targetWsUrl.split('?')[0]}...`);

    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = setTimeout(() => {
      console.warn(`[Agent] Connection to ${serverArg} timed out (${HANDSHAKE_TIMEOUT_MS / 1000}s)`);
      if (ws) {
        try { ws.terminate(); } catch {}
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws = new WebSocket(targetWsUrl, {
      headers: { 'x-admin-key': adminKey },
    });

    ws.on('upgrade', (response) => {
      if (ws && ws._socket && typeof ws._socket.setKeepAlive === 'function') {
        ws._socket.setKeepAlive(true, 10000);
      }
    });

    ws.on('open', () => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      console.log(`[Agent] Connected and registered successfully! Reverse tunnel is active.`);

      startHeartbeat();

      const isFirstSpawn = !ptyProcess;
      if (!ptyProcess) {
        spawnPty();
      }

      try {
        streamSessionManager = new StreamSessionManager((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('JSON:' + JSON.stringify(data));
          }
        });

        if (isFirstSpawn) {
          ws.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
        }
        if (ptyProcess) {
          ws.send(`JSON:${JSON.stringify({ type: 'resize', cols: ptyProcess.cols, rows: ptyProcess.rows })}`);
        }
        flushPendingOutput();
      } catch {}
    });

    ws.on('message', (data) => {
      onHeartbeatActivity();
      try {
        const msgStr = data.toString();
        const control = parseControlMessage(msgStr);
        if (control) {
          if (control.type === 'file_rpc') {
            handleFileRpc(control, ws);
            return;
          }
          if (control.type === 'cmd_exec') {
            if (control.action === 'start_stream') {
              if (streamSessionManager) {
                streamSessionManager.startStream(control);
              }
              return;
            }
            handleCmdExec(control, ws);
            return;
          }
          if (control.type === 'cmd_stream_input') {
            if (streamSessionManager) {
              streamSessionManager.writeInput(control.taskId, control.data);
            }
            return;
          }
          if (control.type === 'cmd_stream_resize') {
            if (streamSessionManager) {
              streamSessionManager.resize(control.taskId, control.cols, control.rows);
            }
            return;
          }
          if (control.type === 'cmd_stream_kill') {
            if (streamSessionManager) {
              streamSessionManager.kill(control.taskId, control.signal);
            }
            return;
          }
          if (control.type === 'resize') {
            const cols = Math.max(10, Math.min(500, Math.floor(control.cols)));
            const rows = Math.max(5, Math.min(200, Math.floor(control.rows)));
            if (ptyProcess) {
              const currentCols = ptyProcess.cols;
              const currentRows = ptyProcess.rows;
              if (typeof currentCols === 'number' && typeof currentRows === 'number' && currentCols === cols && currentRows === rows) {
                // Dimensions match: Linux kernel TIOCSWINSZ will not emit SIGWINCH on identical size.
                // Briefly nudge rows by 1 and restore to force kernel SIGWINCH so shells (bash/zsh) redraw prompt.
                const now = Date.now();
                if (!nudgeRestoreTimer && (now - lastNudgeTimestamp > 1000)) {
                  lastNudgeTimestamp = now;
                  const nudgeRows = rows > 5 ? rows - 1 : rows + 1;
                  ptyProcess.resize(cols, nudgeRows);
                  nudgeRestoreTimer = setTimeout(() => {
                    nudgeRestoreTimer = null;
                    if (ptyProcess) {
                      ptyProcess.resize(cols, rows);
                    }
                  }, 30);
                }
              } else {
                if (nudgeRestoreTimer) {
                  clearTimeout(nudgeRestoreTimer);
                  nudgeRestoreTimer = null;
                }
                ptyProcess.resize(cols, rows);
              }
            }
            return;
          }
          if (control.type === 'reset') {
            console.log('[Agent] Reset PTY requested by server');
            spawnPty();
            return;
          }
          if (control.type === 'ping') {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(`JSON:${JSON.stringify({ type: 'pong' })}`);
            }
            return;
          }
          if (control.type === 'pong') {
            return;
          }
          if (control.type === 'registered') {
            console.log(`[Agent] Registered confirmed: hostId=${control.hostId}, status=${control.status}`);
            return;
          }
          if (control.type === 'rejected') {
            isExiting = true;
            console.error(`\x1b[31m[Error] Registration rejected by server: ${control.reason || 'Name conflict'}\x1b[0m`);
            console.error('Please choose a different name using --name=<unique-name>.');
            if (ws) {
              try { ws.close(); } catch {}
            }
            process.exit(1);
          }
          return;
        }

        if (ptyProcess) {
          ptyProcess.write(msgStr);
        }
      } catch (err) {
        if (ptyProcess) {
          ptyProcess.write(data.toString());
        }
      }
    });

    ws.on('close', (code, reason) => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      stopHeartbeat();
      if (streamSessionManager) {
        streamSessionManager.killAll();
      }
      if (code === 4009) {
        isExiting = true;
        console.error(`\x1b[31m[Error] Registration rejected by server: ${reason?.toString() || 'Host name conflict'}\x1b[0m`);
        console.error('Please choose a different name using --name=<unique-name>.');
        process.exit(1);
      }
      console.warn(`[Agent] Connection closed (code: ${code}, reason: ${reason || 'none'})`);
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      stopHeartbeat();
      const msg = err && (err.message || err.code || err.name || String(err));
      console.error(`[Agent] Connection error: ${msg || 'Unknown error'}`);
    });
  }

  function scheduleReconnect() {
    if (isExiting) return;
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, Math.min(reconnectAttempts, 8)));
    console.log(`[Agent] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function cleanup() {
    if (isExiting) return;
    isExiting = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    console.log('\n[Agent] Shutting down agent...');
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (streamSessionManager) {
      streamSessionManager.killAll();
    }
    if (ptyProcess) {
      try { ptyProcess.kill('SIGTERM'); } catch {}
    }
    for (const task of taskManager.tasks.values()) {
      if (task.status === 'running' && task.child) {
        killProcessTree(task.child, 'SIGTERM');
        setTimeout(() => {
          if (task.child) killProcessTree(task.child, 'SIGKILL');
        }, 500);
      }
    }
    setTimeout(() => process.exit(0), 600);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('uncaughtException', (err) => {
    console.error('\n[Agent] Uncaught exception:', err);
    cleanup();
  });
  process.on('exit', () => {
    for (const task of taskManager.tasks.values()) {
      if (task.status === 'running' && task.child && task.child.pid) {
        try {
          killProcessTreeSync(task.child.pid, 'SIGKILL');
        } catch {}
      }
    }
  });

  if (pty) {
    spawnPty();
  }
  connect();
}

// --------------------------------------------------------------------------
// Shell quoting and CLI Parsing Helpers
// --------------------------------------------------------------------------

function quoteShellArg(arg) {
  if (typeof arg !== 'string') return '';
  if (/^[a-zA-Z0-9_.\-\/=:@]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function parseExecArgs(args) {
  let detach = false;
  let workdir = undefined;
  let timeoutMs = 300000;
  let verbose = false;
  let pollInterval = 500;
  let interactive = false;
  let tty = false;
  const envVars = {};
  let host = '';
  const commandParts = [];

  let i = 0;
  // Phase 1: parse gt exec options until host is found or -- is encountered
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i++;
      if (!host && i < args.length) {
        host = args[i++];
      }
      break;
    }
    if (a === '-d' || a === '--detach' || a === '-a' || a === '--async') {
      detach = true;
    } else if (a === '--verbose') {
      verbose = true;
    } else if (a === '-q' || a === '--quiet') {
      // Retained for backward flag compatibility (now default behavior)
    } else if (a === '-it' || a === '-ti') {
      interactive = true;
      tty = true;
    } else if (a === '-i' || a === '--interactive' || a === '--stdin') {
      interactive = true;
    } else if (a === '-t' || a === '--tty') {
      tty = true;
    } else if (a === '-w' || a === '--workdir' || a === '--cwd') {
      workdir = args[++i];
    } else if (a.startsWith('-w=')) {
      workdir = a.slice(3);
    } else if (a.startsWith('--workdir=')) {
      workdir = a.slice(10);
    } else if (a.startsWith('--cwd=')) {
      workdir = a.slice(6);
    } else if (a === '--timeout') {
      timeoutMs = parseInt(args[++i], 10);
    } else if (a.startsWith('--timeout=')) {
      timeoutMs = parseInt(a.slice(10), 10);
    } else if (a === '--poll-interval') {
      pollInterval = parseInt(args[++i], 10);
    } else if (a === '-e' || a === '--env') {
      const pair = args[++i] || '';
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        envVars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    } else if (a.startsWith('-e=')) {
      const pair = a.slice(3);
      const eq = pair.indexOf('=');
      if (eq !== -1) envVars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    } else if (a.startsWith('-')) {
      // Unknown option before host
      throw new Error(`Unknown option before host: ${a}`);
    } else {
      host = a;
      i++;
      break;
    }
    i++;
  }

  // If a double dash directly follows host (e.g. gt exec node-1 -- cmd), skip it
  if (i < args.length && args[i] === '--') {
    i++;
  }

  // Phase 2: everything after host is remote command arguments
  while (i < args.length) {
    commandParts.push(args[i++]);
  }

  const fullCommand = commandParts.length === 1
    ? commandParts[0].trim()
    : commandParts.map(quoteShellArg).join(' ').trim();
  return {
    host,
    fullCommand,
    commandParts,
    options: { detach, workdir, timeoutMs, verbose, pollInterval, env: envVars, interactive, tty }
  };
}

function runInteractiveExec({ serverUrl, apiKey, hostId, fullCommand, options }) {
  return new Promise(async (resolve, reject) => {
    const { tty, timeoutMs, workdir, env } = options;
    const isTTY = Boolean(process.stdin.isTTY);

    let wsUrl = serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = `ws://${wsUrl}`;
    }
    wsUrl = wsUrl.replace(/\/+$/, '');

    const query = new URLSearchParams({ hostId });
    if (apiKey) query.set('key', apiKey);

    const targetUrl = `${wsUrl}/api/terminal/exec-ws?${query.toString()}`;
    const headers = {};
    if (apiKey) headers['x-admin-key'] = apiKey;

    const ws = new WebSocket(targetUrl, { headers });

    const restoreTerminal = () => {
      if (isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      try { process.stdin.pause(); } catch {}
      if (tty) {
        process.stdout.write('\x1b[?25h\x1b[0m');
      }
    };

    ws.on('open', () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // 1. Send exec_start
      ws.send(JSON.stringify({
        type: 'exec_start',
        command: fullCommand,
        cwd: workdir,
        env,
        timeoutMs: timeoutMs || 0,
        tty: Boolean(tty),
        interactive: true,
        cols,
        rows,
      }));

      // 2. Set raw mode if TTY
      if (isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      // 3. Pipe stdin to ws binary
      process.stdin.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });

      // 4. Handle resize
      const onResize = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows || 24,
          }));
        }
      };
      process.stdout.on('resize', onResize);
      ws.on('close', () => {
        process.stdout.removeListener('resize', onResize);
      });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        process.stdout.write(data);
        return;
      }

      const str = data.toString();
      try {
        const json = JSON.parse(str);
        if (json.type === 'exec_exit') {
          restoreTerminal();
          resolve(json.exitCode !== undefined ? json.exitCode : 0);
          return;
        }
        if (json.type === 'exec_started') {
          return;
        }
      } catch {}

      process.stdout.write(data);
    });

    ws.on('error', (err) => {
      restoreTerminal();
      console.error(`\n[Error] Connection error: ${err.message}`);
      resolve(1);
    });

    ws.on('close', (code, reason) => {
      restoreTerminal();
      if (code !== 1000) {
        console.error(`\n[Connection Closed] ${reason?.toString() || `code ${code}`}`);
        resolve(1);
      }
    });

    process.on('SIGINT', () => {
      restoreTerminal();
      process.exit(130);
    });
  });
}

async function handleRemotePs({ server, key, args = [], jsonOutput = false, formatTemplateStr = null }) {
  let showAll = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-a' || a === '--all') {
      showAll = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--format') {
      formatTemplateStr = args[++i];
    } else if (a.startsWith('--format=')) {
      formatTemplateStr = a.slice(9);
    }
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: '/api/terminal/hosts',
      method: 'GET',
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.data && Array.isArray(res.data.hosts)) {
      let hosts = res.data.hosts;
      if (!showAll) {
        hosts = hosts.filter(h => h.status === 'online');
      }

      if (formatTemplateStr) {
        const formatted = formatTemplate(formatTemplateStr, hosts);
        if (formatted) console.log(formatted);
        process.exit(0);
      }

      if (hosts.length === 0) {
        console.log(showAll ? 'No terminal agent hosts recorded.' : 'No online terminal agent hosts found. (Use -a to show offline)');
        if (!jsonOutput && !formatTemplateStr) {
          const runningAgents = AgentDaemonManager.getAllAgents().filter(a => a.running);
          if (runningAgents.length > 0) {
            console.log(`\n(Tip: ${runningAgents.length} local agent daemon(s) active. Run 'gt ps -l' to view)`);
          }
        }
        process.exit(0);
      }

      console.log(
        'NODE ID'.padEnd(20) +
        'NAME'.padEnd(25) +
        'STATUS'.padEnd(12) +
        'PLATFORM'.padEnd(12) +
        'IP'.padEnd(18) +
        'LAST SEEN'
      );
      console.log('-'.repeat(95));

      for (const h of hosts) {
        const statusStr = h.status === 'online' ? 'online' : 'offline';
        console.log(
          (h.id || '').padEnd(20) +
          (h.name || h.hostname || '').padEnd(25) +
          statusStr.padEnd(12) +
          (h.platform || '').padEnd(12) +
          (h.ip || '').padEnd(18) +
          formatRelativeTime(h.lastSeen)
        );
      }

      if (!jsonOutput && !formatTemplateStr) {
        const runningAgents = AgentDaemonManager.getAllAgents().filter(a => a.running);
        if (runningAgents.length > 0) {
          console.log(`\n(Tip: ${runningAgents.length} local agent daemon(s) active. Run 'gt ps -l' to view)`);
        }
      }
      process.exit(0);
    } else {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to query hosts: ${err.message}`);
    process.exit(1);
  }
}

async function handleRemotePrune({ server, key, args = [], jsonOutput = false }) {
  if (args.includes('--json')) jsonOutput = true;
  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: '/api/terminal/hosts/offline',
      method: 'DELETE',
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.status === 200 && res.data && res.data.success) {
      console.log(`Pruned ${res.data.prunedCount ?? res.data.removed ?? 0} offline host(s).`);
      process.exit(0);
    } else {
      console.error(`Failed to prune offline hosts: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to prune offline hosts: ${err.message}`);
    process.exit(1);
  }
}

async function handleLogin({ server, key, subArgs = [] }) {
  let targetServer = server;
  let targetKey = key;

  if (subArgs.length >= 2) {
    targetServer = subArgs[0];
    targetKey = subArgs[1];
  } else if (subArgs.length === 1) {
    if (subArgs[0].startsWith('http://') || subArgs[0].startsWith('https://')) {
      targetServer = subArgs[0];
    } else {
      targetKey = subArgs[0];
    }
  }

  if (!targetKey) {
    console.error('Error: Missing secret key. Usage: gt login [server] [key]');
    process.exit(1);
  }

  targetServer = targetServer.replace(/\/+$/, '');

  try {
    const res = await makeRequest({
      serverUrl: targetServer,
      endpoint: '/api/terminal/hosts',
      method: 'GET',
      apiKey: targetKey,
    });

    if (res.status === 200) {
      const config = ConfigStore.load();
      config.server = targetServer;
      config.key = targetKey;
      ConfigStore.save(config);
      console.log(`Successfully verified and logged in to ${targetServer}`);
      process.exit(0);
    } else {
      console.error(`Authentication failed: HTTP ${res.status} ${res.data?.error || 'Unauthorized'}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Authentication failed: ${err.message}`);
    process.exit(1);
  }
}

function handleLogout() {
  const config = ConfigStore.load();
  delete config.key;
  ConfigStore.save(config);
  console.log('Successfully logged out.');
  process.exit(0);
}

async function handleLogsDispatcher({ server, key, args = [], jsonOutput = false }) {
  // Extract flags and positional arguments
  let lines = 50;
  let follow = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--follow') {
      follow = true;
    } else if (a === '-n' || a === '--lines') {
      lines = parseInt(args[++i], 10) || 50;
    } else if (a.startsWith('-n=')) {
      lines = parseInt(a.slice(3), 10) || 50;
    } else if (a.startsWith('--lines=')) {
      lines = parseInt(a.slice(8), 10) || 50;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  // 1. If 2 or more positional args, or first arg explicitly points to remote node & taskId
  if (positional.length >= 2) {
    if (!jsonOutput) {
      process.stderr.write(`[Notice] Redirecting to 'gt task logs ${positional.join(' ')}'...\n`);
    }
    await handleRemoteLogs({ server, key, args, jsonOutput });
    return;
  }

  // 2. If 0 or 1 positional argument, check local agent daemons
  const targetName = positional[0];
  const resolved = AgentDaemonManager.resolveTarget(targetName, 'logs');
  if (resolved.agent) {
    await AgentDaemonManager.getLogs(resolved.agent.name, lines, follow);
    process.exit(0);
  }

  // If no local agent matched but targetName was provided, attempt fallback to remote task logs
  if (targetName) {
    await handleRemoteLogs({ server, key, args, jsonOutput });
    return;
  }

  if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
  }

  console.log('No running agent daemons found.');
  process.exit(0);
}

async function handleRemoteLogs({ server, key, args = [], jsonOutput = false }) {
  let follow = false;
  let pollInterval = 500;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--follow') {
      follow = true;
    } else if (a === '--poll-interval') {
      pollInterval = parseInt(args[++i], 10) || 500;
    } else if (a.startsWith('--poll-interval=')) {
      pollInterval = parseInt(a.slice(16), 10) || 500;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length < 1) {
    console.error('Error: Missing target host. Usage: gt logs [OPTIONS] <node> [taskId]');
    process.exit(125);
  }

  const hostInput = positional[0];
  let resolvedHost;
  try {
    resolvedHost = await resolveHost(server, key, hostInput);
  } catch (err) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    resolvedHost = { id: hostInput, name: hostInput };
  }

  let taskId = positional[1];
  try {
    const taskListRes = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });
    if (taskListRes.data && taskListRes.data.success && Array.isArray(taskListRes.data.tasks)) {
      if (!taskId) {
        if (taskListRes.data.tasks.length === 0) {
          console.error(`No tasks found on node [${resolvedHost.id}].`);
          process.exit(1);
        }
        taskId = taskListRes.data.tasks[0].taskId;
      } else {
        taskId = resolveTaskId(taskListRes.data.tasks, taskId);
      }
    }
  } catch (err) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such task'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (!taskId) {
    console.error(`Error: No taskId specified and could not deduce latest task on node [${resolvedHost.id}].`);
    process.exit(1);
  }

  const hostId = resolvedHost.id;

  if (!follow) {
    try {
      const res = await makeRequest({
        serverUrl: server,
        endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}`,
        method: 'GET',
        apiKey: key,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(0);
      }

      if (res.data && res.data.success) {
        const d = res.data;
        console.log(`Task:     ${d.taskId}`);
        console.log(`Host:     ${d.hostId}`);
        console.log(`Status:   ${d.status}`);
        console.log(`ExitCode: ${d.exitCode !== null && d.exitCode !== undefined ? d.exitCode : 'N/A'}`);
        const outputText = d.output !== undefined ? d.output : (d.stdout || '');
        if (outputText) {
          console.log('\n--- Output ---');
          process.stdout.write(outputText);
          if (!outputText.endsWith('\n')) console.log();
        }
        process.exit(0);
      } else {
        console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`Failed to get logs for [${taskId}]: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.on('SIGINT', () => {
      process.exit(130);
    });

    let offset = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 30;

    const poll = async () => {
      try {
        const pollRes = await makeRequest({
          serverUrl: server,
          endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}?offset=${offset}`,
          method: 'GET',
          apiKey: key,
        });

        if (pollRes.data && pollRes.data.success) {
          if (consecutiveErrors >= 3) {
            process.stderr.write(`\n[${hostId}] Connection restored, continuing stream...\n`);
          }
          consecutiveErrors = 0;
          const t = pollRes.data;
          if (t.stdout) process.stdout.write(t.stdout);
          if (t.stderr) process.stderr.write(t.stderr);
          if (!t.stdout && !t.stderr && t.output) process.stdout.write(t.output);

          offset = t.outputOffset !== undefined ? t.outputOffset : (t.offset !== undefined ? t.offset : offset);

          if (t.status !== 'running') {
            const exitCode = t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : (t.status === 'completed' ? 0 : 1);
            process.exit(exitCode);
          }
        } else {
          consecutiveErrors++;
        }
      } catch (err) {
        consecutiveErrors++;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`\n<<< [${hostId}] Connection lost after ${MAX_CONSECUTIVE_ERRORS} retries while streaming task [${taskId}]. Aborting.`);
        process.exit(1);
      } else if (consecutiveErrors === 3) {
        process.stderr.write(`\n[${hostId}] Server temporarily unavailable, waiting for reconnection...\n`);
      }

      setTimeout(poll, pollInterval);
    };

    poll();
  }
}

async function handleRemoteKill({ server, key, args = [], jsonOutput = false }) {
  let signal = 'SIGTERM';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--signal') {
      signal = args[++i];
    } else if (a.startsWith('--signal=')) {
      signal = a.slice(9);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length < 2) {
    console.error('Error: Missing arguments. Usage: gt kill [--signal <SIG>] <node> <taskId>');
    process.exit(125);
  }

  const [hostInput, taskInput] = positional;
  let resolvedHost;
  try {
    resolvedHost = await resolveHost(server, key, hostInput);
  } catch (err) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    resolvedHost = { id: hostInput, name: hostInput };
  }

  let taskId = taskInput;
  try {
    const taskListRes = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });
    if (taskListRes.data && taskListRes.data.success && Array.isArray(taskListRes.data.tasks)) {
      taskId = resolveTaskId(taskListRes.data.tasks, taskInput);
    }
  } catch (err) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such task'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  const hostId = resolvedHost.id;

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}/kill`,
      method: 'POST',
      body: { signal },
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.data && res.data.success) {
      console.log(`Kill signal sent to task [${taskId}] on host [${hostId}].`);
      process.exit(0);
    } else {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to kill task [${taskId}]: ${err.message}`);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------
// Main CLI Dispatcher
// --------------------------------------------------------------------------

async function main() {
  const rawArgs = process.argv.slice(2);

  let cliServer = null;
  let cliKey = null;
  let jsonOutput = false;
  let formatTemplateStr = null;

  const filteredArgs = [];
  let foundDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (foundDoubleDash) {
      filteredArgs.push(a);
      continue;
    }
    if (a === '--') {
      foundDoubleDash = true;
      filteredArgs.push(a);
      continue;
    }
    if (a === '-v' || a === '--version') {
      console.log(`gt version ${VERSION}`);
      process.exit(0);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--format') {
      formatTemplateStr = rawArgs[++i];
    } else if (a.startsWith('--format=')) {
      formatTemplateStr = a.slice(9);
    } else if (a === '-s' || a === '--server') {
      cliServer = rawArgs[++i];
    } else if (a.startsWith('--server=')) {
      cliServer = a.slice(9);
    } else if (a === '-k' || a === '--key') {
      cliKey = rawArgs[++i];
    } else if (a.startsWith('--key=')) {
      cliKey = a.slice(6);
    } else {
      filteredArgs.push(a);
    }
  }

  const effectiveConfig = ConfigStore.getEffectiveConfig({ server: cliServer, key: cliKey });
  const server = effectiveConfig.server;
  const key = effectiveConfig.key;

  if (filteredArgs.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = filteredArgs[0].toLowerCase();
  const cmdArgs = filteredArgs.slice(1);

  const commandMigrationMap = {
    hosts: "gt ps",
    nodes: "gt ps",
  };

  if (commandMigrationMap[command]) {
    const target = commandMigrationMap[command];
    if (command === 'hosts' || command === 'nodes') {
      console.error(`Error: 'gt ${command}' has been deprecated. Use '${target}' instead.`);
      console.error(`Run 'gt --help' for modern Docker-style command usage.`);
    } else {
      console.error(`Error: 'gt ${command}' has been moved to '${target}'.`);
      console.error(`Run '${target}' instead.`);
      console.error(`Run 'gt --help' for modern Docker-style command usage.`);
    }
    process.exit(125);
  }

  switch (command) {
    case 'ps': {
      const isLocal = cmdArgs.includes('-l') || cmdArgs.includes('--local');
      if (isLocal) {
        const hasAll = cmdArgs.includes('-a') || cmdArgs.includes('--all');
        AgentDaemonManager.printAgentsTable(hasAll);
        break;
      }
      await handleRemotePs({ server, key, args: cmdArgs, jsonOutput, formatTemplateStr });
      break;
    }

    case 'prune': {
      const isLocal = cmdArgs.includes('-l') || cmdArgs.includes('--local');
      const isAll = cmdArgs.includes('-a') || cmdArgs.includes('--all');

      if (isLocal) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length === 0) {
          console.log('No stopped agents to prune.');
        } else {
          console.log(`Pruned ${removed.length} stopped agent(s): ${removed.join(', ')}`);
        }
        process.exit(0);
      }

      if (isAll) {
        const { removed } = AgentDaemonManager.prune();
        if (removed.length > 0) {
          console.log(`Pruned ${removed.length} local stopped agent(s): ${removed.join(', ')}`);
        }
        await handleRemotePrune({ server, key, args: cmdArgs, jsonOutput });
        break;
      }

      await handleRemotePrune({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'login': {
      await handleLogin({ server, key, subArgs: cmdArgs });
      break;
    }

    case 'logout': {
      handleLogout();
      break;
    }

    case 'logs': {
      await handleLogsDispatcher({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'kill': {
      await handleRemoteKill({ server, key, args: cmdArgs, jsonOutput });
      break;
    }

    case 'host':
    case 'node': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing host subcommand. Usage: gt host <ls|prune> [OPTIONS]');
        process.exit(125);
      }

      if (subCommand === 'ls' || subCommand === 'list') {
        await handleRemotePs({ server, key, args: subArgs, jsonOutput, formatTemplateStr });
      } else if (subCommand === 'prune') {
        await handleRemotePrune({ server, key, args: subArgs, jsonOutput });
      } else {
        console.error(`Error: Unknown host subcommand: '${subCommand}'.`);
        console.error("Usage: gt host <ls|prune> [OPTIONS]");
        process.exit(125);
      }
      break;
    }

    case 'task': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing task subcommand. Usage: gt task <ls|logs|kill> [ARGS...]');
        process.exit(125);
      }

      if (subCommand === 'ls' || subCommand === 'list') {
        let targetHost = null;
        for (let i = 0; i < subArgs.length; i++) {
          if (subArgs[i] === '--json') jsonOutput = true;
          else if (subArgs[i] === '--format') formatTemplateStr = subArgs[++i];
          else if (subArgs[i].startsWith('--format=')) formatTemplateStr = subArgs[i].slice(9);
          else if (!targetHost) targetHost = subArgs[i];
        }

        if (!targetHost) {
          console.error('Error: Missing target host. Usage: gt task ls <host> [OPTIONS]');
          process.exit(125);
        }

        let resolvedHost;
        try {
          resolvedHost = await resolveHost(server, key, targetHost);
        } catch (err) {
          if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
          resolvedHost = { id: targetHost, name: targetHost };
        }

        try {
          const res = await makeRequest({
            serverUrl: server,
            endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
            method: 'GET',
            apiKey: key,
          });

          if (jsonOutput) {
            console.log(JSON.stringify(res.data, null, 2));
            process.exit(0);
          }

          if (res.data && res.data.success && Array.isArray(res.data.tasks)) {
            const tasks = res.data.tasks;
            if (formatTemplateStr) {
              const formatted = formatTemplate(formatTemplateStr, tasks);
              if (formatted) console.log(formatted);
              process.exit(0);
            }

            if (tasks.length === 0) {
              console.log(`No recent tasks recorded on [${resolvedHost.id}].`);
              process.exit(0);
            }

            console.log(
              'TASK ID'.padEnd(26) +
              'STATUS'.padEnd(12) +
              'EXIT'.padEnd(8) +
              'START TIME'.padEnd(14) +
              'COMMAND'
            );
            console.log('-'.repeat(80));

            for (const t of tasks) {
              const timeStr = new Date(t.startTime).toLocaleTimeString();
              const exitStr = t.exitCode !== null && t.exitCode !== undefined ? String(t.exitCode) : '-';
              console.log(
                t.taskId.padEnd(26) +
                t.status.padEnd(12) +
                exitStr.padEnd(8) +
                timeStr.padEnd(14) +
                t.command
              );
            }
            process.exit(0);
          } else {
            console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
            process.exit(1);
          }
        } catch (err) {
          console.error(`Failed to list tasks on [${resolvedHost.id}]: ${err.message}`);
          process.exit(1);
        }
      } else if (subCommand === 'logs') {
        await handleRemoteLogs({ server, key, args: subArgs, jsonOutput });
      } else if (subCommand === 'kill') {
        await handleRemoteKill({ server, key, args: subArgs, jsonOutput });
      } else {
        console.error(`Error: Unknown task subcommand: '${subCommand}'.`);
        console.error("Usage: gt task <ls|logs|kill> [ARGS...]");
        process.exit(125);
      }
      break;
    }

    case 'auth': {
      const subCommand = (cmdArgs[0] || '').toLowerCase();
      const subArgs = cmdArgs.slice(1);

      if (!subCommand) {
        console.error('Error: Missing auth subcommand. Usage: gt auth <login|logout> [ARGS...]');
        process.exit(125);
      }

      if (subCommand === 'login') {
        await handleLogin({ server, key, subArgs });
      } else if (subCommand === 'logout') {
        handleLogout();
      } else {
        console.error(`Error: Unknown auth subcommand: '${subCommand}'.`);
        console.error("Usage: gt auth <login|logout> [ARGS...]");
        process.exit(125);
      }
      break;
    }

    case 'cp': {
      if (cmdArgs.length < 2) {
        console.error('Error: Missing arguments. Usage: gt cp <src> <dest>');
        process.exit(125);
      }
      try {
        const code = await runCp(server, key, cmdArgs);
        process.exit(code);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'exec': {
      let parsed;
      try {
        parsed = parseExecArgs(cmdArgs);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      const { host, fullCommand, commandParts, options } = parsed;
      const { detach, workdir, timeoutMs, verbose, pollInterval, env: envVars, interactive, tty } = options;

      if (!host || commandParts.length === 0) {
        console.error('Error: "gt exec" requires at least 2 arguments.');
        if (!host) {
          console.error('Missing target host.');
        } else {
          console.error('Missing command to execute.');
        }
        console.error('Usage: gt exec [OPTIONS] <host> <command...>');
        process.exit(1);
      }

      let resolvedHost;
      try {
        resolvedHost = await resolveHost(server, key, host);
      } catch (err) {
        resolvedHost = { id: host, name: host };
      }
      const targetHost = resolvedHost.id;

      if (interactive && tty) {
        const exitCode = await runInteractiveExec({
          serverUrl: server,
          apiKey: key,
          hostId: targetHost,
          fullCommand,
          options,
        });
        process.exit(exitCode);
      }

      let stdinPayload = undefined;
      if (interactive && !tty) {
        stdinPayload = await new Promise((resolve) => {
          let buf = '';
          process.stdin.setEncoding('utf-8');
          process.stdin.on('data', (chunk) => { buf += chunk; });
          process.stdin.on('end', () => { resolve(buf); });
          process.stdin.on('error', () => { resolve(buf); });
          process.stdin.resume();
        });
      }

      const startTime = Date.now();

      if (verbose) {
        process.stderr.write(`>>> [${targetHost}] $ ${fullCommand}\n`);
      }

      try {
        const startRes = await makeRequest({
          serverUrl: server,
          endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}`,
          method: 'POST',
          body: {
            command: fullCommand,
            cwd: workdir,
            timeoutMs,
            env: envVars,
            stdin: stdinPayload,
          },
          apiKey: key,
        });

        if (!startRes.data || !startRes.data.success) {
          console.error(`Error starting task on [${targetHost}]: ${startRes.data?.error || `HTTP ${startRes.status}`}`);
          process.exit(1);
        }

        const { taskId } = startRes.data;

        if (detach) {
          if (jsonOutput) {
            console.log(JSON.stringify(startRes.data, null, 2));
          } else {
            console.log(taskId);
            console.log(`Run 'gt task logs -f ${targetHost} ${taskId}' to follow logs.`);
          }
          process.exit(0);
        }

        let offset = 0;
        let isTerminated = false;
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 30; // ~15 seconds buffer (at 500ms intervals) for server reload or network blips

        process.on('SIGINT', async () => {
          if (isTerminated) process.exit(130);
          isTerminated = true;
          process.stderr.write(`\n[Interrupted] Terminating remote task [${taskId}]...\n`);
          try {
            await makeRequest({
              serverUrl: server,
              endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}/${encodeURIComponent(taskId)}/kill`,
              method: 'POST',
              body: { signal: 'SIGTERM' },
              apiKey: key,
            });
          } catch {}
          process.exit(130);
        });

        const poll = async () => {
          try {
            const pollRes = await makeRequest({
              serverUrl: server,
              endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}/${encodeURIComponent(taskId)}?offset=${offset}`,
              method: 'GET',
              apiKey: key,
            });

            if (pollRes.data && pollRes.data.success) {
              if (consecutiveErrors >= 3) {
                process.stderr.write(`\n[${targetHost}] Connection restored, continuing stream...\n`);
              }
              consecutiveErrors = 0;
              const t = pollRes.data;
              if (t.stdout) process.stdout.write(t.stdout);
              if (t.stderr) process.stderr.write(t.stderr);

              offset = t.outputOffset !== undefined ? t.outputOffset : (t.offset !== undefined ? t.offset : offset);

              if (t.status !== 'running') {
                const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                const exitCode = t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : (t.status === 'completed' ? 0 : 1);

                if (verbose) {
                  if (exitCode === 0) {
                    process.stderr.write(`<<< [${targetHost}] Command completed with code 0 (took ${durationSec}s)\n`);
                  } else {
                    process.stderr.write(`<<< [${targetHost}] Command failed with code ${exitCode} (${t.status}, took ${durationSec}s)\n`);
                  }
                }
                process.exit(exitCode);
              }
            } else {
              consecutiveErrors++;
            }
          } catch (err) {
            consecutiveErrors++;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error(`\n<<< [${targetHost}] Connection lost after ${MAX_CONSECUTIVE_ERRORS} retries while streaming task [${taskId}]. Aborting.`);
            process.exit(1);
          } else if (consecutiveErrors === 3) {
            process.stderr.write(`\n[${targetHost}] Server temporarily unavailable, waiting for reconnection...\n`);
          }

          setTimeout(poll, pollInterval);
        };

        poll();
      } catch (err) {
        console.error(`Failed to execute on [${targetHost}]: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'config': {
      const subCmd = (cmdArgs[0] || 'list').toLowerCase();
      if (subCmd === 'list') {
        const stored = ConfigStore.load();
        const mask = (str) => {
          if (!str) return '';
          if (str.length <= 3) return '***';
          return str.slice(0, 3) + '***';
        };
        const serverVal = stored.server !== undefined ? stored.server : server;
        const keyVal = stored.key !== undefined ? mask(stored.key) : '';
        console.log(`server = "${serverVal}"`);
        console.log(`key    = "${keyVal}"`);
        for (const [k, v] of Object.entries(stored)) {
          if (k !== 'server' && k !== 'key') {
            console.log(`${k.padEnd(6)} = "${v}"`);
          }
        }
        process.exit(0);
      } else if (subCmd === 'get') {
        const k = cmdArgs[1];
        if (!k) {
          console.error('Error: Missing key. Usage: gt config get <key>');
          process.exit(1);
        }
        const val = ConfigStore.get(k);
        if (val !== undefined && val !== null) {
          console.log(val);
        } else {
          console.log('');
        }
        process.exit(0);
      } else if (subCmd === 'set') {
        const k = cmdArgs[1];
        const v = cmdArgs[2];
        if (!k || v === undefined) {
          console.error('Error: Missing arguments. Usage: gt config set <key> <value>');
          process.exit(1);
        }
        ConfigStore.set(k, v);
        console.log(`Set ${k} = "${v}"`);
        process.exit(0);
      } else {
        console.error(`Error: Unknown config command: ${subCmd}`);
        console.error('Usage: gt config <list|get|set> [key] [val]');
        process.exit(1);
      }
      break;
    }

    case 'run': {
      await runAgent(['run', ...cmdArgs], { server, key, cliServer, cliKey });
      break;
    }

    case 'stop': {
      const hasAll = cmdArgs.includes('--all') || cmdArgs.includes('-a');
      if (hasAll) {
        const results = await AgentDaemonManager.stopAll();
        if (results.length === 0) {
          console.log('No running agents to stop.');
        } else {
          for (const r of results) {
            console.log(r.message);
          }
        }
        process.exit(0);
      }

      let targetName = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      const resolved = AgentDaemonManager.resolveTarget(targetName, 'stop');
      if (resolved.error) {
        console.error(resolved.error);
        process.exit(1);
      }

      const res = await AgentDaemonManager.stop(resolved.agent.name);
      console.log(res.message);
      process.exit(0);
    }

    case 'restart': {
      let targetName = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      const resolved = AgentDaemonManager.resolveTarget(targetName, 'restart');
      if (resolved.error) {
        console.error(resolved.error);
        process.exit(1);
      }

      const sName = resolved.agent.name;
      await AgentDaemonManager.stop(sName);
      await runAgent(['start', `--name=${sName}`], { server, key, cliServer, cliKey });
      break;
    }

    case 'rm': {
      const hasAll = cmdArgs.includes('--all') || cmdArgs.includes('-a');
      if (hasAll) {
        const { removed } = AgentDaemonManager.removeAll();
        if (removed.length === 0) {
          console.log('No stopped agents to remove.');
        } else {
          console.log(`Removed agents: ${removed.join(', ')}`);
        }
        process.exit(0);
      }

      let targetName = null;
      for (const a of cmdArgs) {
        if (!a.startsWith('-')) {
          targetName = a;
          break;
        }
      }

      if (!targetName) {
        const resolved = AgentDaemonManager.resolveTarget(undefined, 'remove');
        if (resolved.agent) {
          targetName = resolved.agent.name;
        } else {
          console.error('Error: Please specify agent NAME to remove (e.g. gt rm <NAME>).');
          process.exit(1);
        }
      }

      const res = AgentDaemonManager.remove(targetName, { removeLogs: true });
      if (!res.success) {
        console.error(res.message);
        process.exit(1);
      }
      console.log(res.message);
      process.exit(0);
    }

    case 'agent': {
      await runAgent(cmdArgs, { server, key, cliServer, cliKey });
      break;
    }

    default:
      console.error(`Error: Unknown command: ${command}`);
      console.error("Run 'gt --help' for usage.");
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  formatRelativeTime,
  formatTemplate,
  resolveTaskId,
  resolveHost,
  isRemoteSpec,
  parseRemoteSpec,
  parseCpArgs,
  uploadLocalFile,
  downloadRemoteFile,
  runCp,
  makeRequest,
  parseControlMessage,
  resolveWebSocketUrl,
  quoteShellArg,
  parseExecArgs,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ConfigStore,
  AgentDaemonManager,
  TaskManager,
  taskManager,
  StreamSessionManager,
  hasSystemPython3,
  NodePtyDriver,
  PosixPtyDriver,
  InteractivePipeDriver,
  killProcessTree,
  killProcessTreeSync,
  handleFileRpc,
  handleCmdExec,
  runAgent,
  runInteractiveExec,
  createWebSocketAdapter,
  tryRequirePty,
  getDefaultShell,
  resolveWorkingDir,
};
