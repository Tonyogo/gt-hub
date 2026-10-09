import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import url from 'url';
import { isRemoteSpec, parseRemoteSpec, resolveHost } from '../utils/terminalUI';

export interface CpSpec {
  isRemote: boolean;
  host?: string;
  path: string;
}

export function parseCpArgs(args: string[]): { src: CpSpec; dest: CpSpec } {
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

  const src: CpSpec = srcIsRemote
    ? { isRemote: true, ...parseRemoteSpec(srcArg) }
    : { isRemote: false, path: srcArg };

  const dest: CpSpec = destIsRemote
    ? { isRemote: true, ...parseRemoteSpec(destArg) }
    : { isRemote: false, path: destArg };

  return { src, dest };
}

export async function uploadLocalFile({
  serverUrl,
  apiKey,
  hostId,
  localPath,
  remotePath,
}: {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  localPath: string;
  remotePath?: string;
}): Promise<number> {
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

  const headers: Record<string, any> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': payload.length,
  };
  if (apiKey) {
    headers['x-admin-key'] = apiKey;
  }

  return new Promise<number>((resolve, reject) => {
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
        let json: any = null;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        if ((res.statusCode && res.statusCode >= 400) || (json && json.success === false)) {
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

export async function downloadRemoteFile({
  serverUrl,
  apiKey,
  hostId,
  remotePath,
  localPath,
}: {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  remotePath: string;
  localPath: string;
}): Promise<number> {
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

  const executeDownload = (allowResume: boolean = true): Promise<number> => {
    return new Promise<number>((resolve, reject) => {
      let isSettled = false;
      let attemptHandled = false;
      let writeStream: fs.WriteStream | null = null;
      let req: http.ClientRequest | null = null;
      let res: http.IncomingMessage | null = null;

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

      const handleRetryOrReject = (err: Error) => {
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

      const headers: Record<string, any> = {};
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

        if (res.statusCode && res.statusCode >= 400) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let json: any = null;
            try { json = JSON.parse(data); } catch { json = { raw: data }; }
            const errorMsg = json?.error || `HTTP ${res?.statusCode}`;

            // Transient server errors (500, 502, 503, 504) or rate limit (429) may be temporary
            if ((res?.statusCode && res.statusCode >= 500) || res?.statusCode === 429) {
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

        let expectedTotal: number | null = null;
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
        writeStream.on('error', (err) => {
          handleRetryOrReject(err);
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
          } catch (renameErr: any) {
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

export async function runCp(serverUrl: string, apiKey: string, args: string[]): Promise<number> {
  const { src, dest } = parseCpArgs(args);

  if (src.isRemote) {
    const resolved = await resolveHost(serverUrl, apiKey, src.host!);
    return await downloadRemoteFile({
      serverUrl,
      apiKey,
      hostId: resolved.id,
      remotePath: src.path,
      localPath: dest.path,
    });
  } else {
    const resolved = await resolveHost(serverUrl, apiKey, dest.host!);
    return await uploadLocalFile({
      serverUrl,
      apiKey,
      hostId: resolved.id,
      localPath: src.path,
      remotePath: dest.path,
    });
  }
}
