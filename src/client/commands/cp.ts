import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import url from 'url';
import { isRemoteSpec, parseRemoteSpec, resolveEndpointUrl, resolveHost } from '../utils/terminalUI';

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

  const rawFilename = path.basename(localPath);
  const safeFilename = rawFilename.replace(/["\r\n]/g, '_');
  const boundary = `----GtFormBoundary${crypto.randomBytes(8).toString('hex')}`;

  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const totalLength = head.length + stat.size + tail.length;

  const endpoint = `/api/terminal/files/upload?hostId=${encodeURIComponent(hostId)}&path=${encodeURIComponent(remotePath || '.')}`;
  const targetUrl = new url.URL(resolveEndpointUrl(serverUrl, endpoint));
  const isHttps = targetUrl.protocol === 'https:';
  const client = isHttps ? https : http;

  const headers: Record<string, any> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': totalLength,
  };
  if (apiKey) {
    headers['x-admin-key'] = apiKey;
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let responseStarted = false;

    const req = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers,
    }, (res) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        if (!settled) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      res.on('error', (err) => {
        finishReject(err);
      });
      res.on('close', () => {
        if (!settled && !res.complete) {
          finishReject(new Error('Upload response closed prematurely by server'));
        }
      });
      res.on('end', () => {
        if (settled) return;
        if (!res.complete) {
          return finishReject(new Error('Upload response ended prematurely by server'));
        }
        const data = Buffer.concat(chunks).toString('utf-8');
        let json: any = null;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        if ((res.statusCode && res.statusCode >= 400) || (json && json.success === false)) {
          finishReject(new Error(`Upload failed: ${json?.error || `HTTP ${res.statusCode}`}`));
          try { req.destroy(); } catch {}
          return;
        }
        if (!req.writableEnded && !req.destroyed) {
          try { req.destroy(); } catch {}
        }
        console.log(`Successfully copied ${localPath} -> [${hostId}]:${remotePath} (${(stat.size / 1024).toFixed(1)} KB)`);
        finishResolve(0);
      });
    });

    const readStream = fs.createReadStream(localPath, { highWaterMark: 64 * 1024 });

    const cleanupReadStream = () => {
      try {
        if (!readStream.destroyed) {
          readStream.destroy();
        }
      } catch {}
    };

    const finishResolve = (code: number) => {
      if (settled) return;
      settled = true;
      cleanupReadStream();
      resolve(code);
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupReadStream();
      reject(err);
    };

    req.setTimeout(60000, () => {
      const timeoutErr = new Error('Upload socket inactivity timeout (60s)');
      try { req.destroy(timeoutErr); } catch {}
      finishReject(timeoutErr);
    });

    req.on('error', (err) => {
      try { req.destroy(); } catch {}
      finishReject(err);
    });

    req.on('close', () => {
      cleanupReadStream();
      if (!responseStarted && !settled) {
        finishReject(new Error('Upload connection closed prematurely before response'));
      }
    });

    // Stream file content chunk-by-chunk with backpressure
    req.write(head);
    readStream.on('data', (chunk) => {
      if (settled || req.destroyed || req.writableEnded) {
        cleanupReadStream();
        return;
      }
      const ok = req.write(chunk);
      if (!ok && !settled && !req.destroyed && !req.writableEnded) {
        readStream.pause();
        req.once('drain', () => {
          if (!settled && !readStream.destroyed && !req.destroyed && !req.writableEnded) {
            readStream.resume();
          }
        });
      }
    });
    readStream.on('end', () => {
      if (settled || req.destroyed || req.writableEnded) return;
      req.end(tail);
    });
    readStream.on('error', (err) => {
      if (settled) return;
      finishReject(err);
      try { req.destroy(err); } catch {}
    });
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
  const targetUrl = new url.URL(resolveEndpointUrl(serverUrl, endpoint));
  const isHttps = targetUrl.protocol === 'https:';
  const client = isHttps ? https : http;

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
      let responseStarted = false;
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
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'GET',
        headers,
      }, (incomingRes) => {
        responseStarted = true;
        res = incomingRes;

        // If 416 (Range Not Satisfiable), our .part file might be corrupted or complete. Reset and redownload.
        if (res.statusCode === 416) {
          attemptHandled = true;
          safeCleanup();
          try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch {}
          if (allowResume) {
            return executeDownload(false).then(resolve, reject);
          }
          isSettled = true;
          reject(new Error('Download failed: 416 Range Not Satisfiable'));
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            if (!isSettled && !attemptHandled) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
          });
          res.on('close', () => {
            if (isSettled || attemptHandled) return;
            if (!res?.complete) {
              const statusCode = res?.statusCode || 0;
              if (statusCode >= 500 || statusCode === 429) {
                handleRetryOrReject(new Error(`HTTP ${statusCode} error response closed prematurely by server`));
              } else {
                attemptHandled = true;
                isSettled = true;
                safeCleanup();
                reject(new Error(`Download failed: HTTP ${statusCode} (error response closed prematurely)`));
              }
            }
          });
          res.on('end', () => {
            if (isSettled || attemptHandled) return;
            const statusCode = res?.statusCode || 0;
            if (!res?.complete) {
              if (statusCode >= 500 || statusCode === 429) {
                handleRetryOrReject(new Error(`HTTP ${statusCode} error response ended prematurely by server`));
              } else {
                attemptHandled = true;
                isSettled = true;
                safeCleanup();
                reject(new Error(`Download failed: HTTP ${statusCode} (error response ended prematurely)`));
              }
              return;
            }
            const data = Buffer.concat(chunks).toString('utf-8');
            let json: any = null;
            try { json = JSON.parse(data); } catch { json = { raw: data }; }
            const errorMsg = json?.error || `HTTP ${statusCode}`;

            // Transient server errors (500, 502, 503, 504) or rate limit (429) may be temporary
            if (statusCode >= 500 || statusCode === 429) {
              handleRetryOrReject(new Error(errorMsg));
              return;
            }

            attemptHandled = true;
            isSettled = true;
            safeCleanup();
            reject(new Error(`Download failed: ${errorMsg}`));
          });
          res.on('error', (err) => {
            if (isSettled || attemptHandled) return;
            const statusCode = res?.statusCode || 0;
            if (statusCode >= 500 || statusCode === 429) {
              handleRetryOrReject(err);
            } else {
              attemptHandled = true;
              isSettled = true;
              safeCleanup();
              reject(new Error(`Download failed: HTTP ${statusCode} (${err.message})`));
            }
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

        res.pipe(writeStream);

        res.on('error', (err) => {
          handleRetryOrReject(err);
        });

        res.on('close', () => {
          if (!res?.complete && !isSettled && !attemptHandled) {
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

      req.setTimeout(60000, () => {
        handleRetryOrReject(new Error('Download socket inactivity timeout (60s)'));
      });

      req.on('error', (err) => {
        handleRetryOrReject(err);
      });

      req.on('close', () => {
        if (!responseStarted && !isSettled && !attemptHandled) {
          handleRetryOrReject(new Error('Download connection closed prematurely before response'));
        }
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
