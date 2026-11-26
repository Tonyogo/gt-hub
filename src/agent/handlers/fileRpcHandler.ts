import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { resolveWorkingDir } from '../tasks/taskManager';
import { checkPathPermission, PermissionMode } from '../security/pathGuard';
import {
  BIN_MSG_TYPE,
  encodeBinaryJsonBufferPacket,
  sendWsSafe,
} from '../../shared/protocol/binaryProtocol';

const gzipAsync = promisify(zlib.gzip);

export const COMPRESSED_EXTENSIONS = new Set([
  'zip', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'zst',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3', 'woff2'
]);

export function isAlreadyCompressedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return COMPRESSED_EXTENSIONS.has(ext);
}

interface CachedHandleEntry {
  key: string;
  handle: fs.promises.FileHandle;
  refCount: number;
  closing: boolean;
  timer: NodeJS.Timeout | null;
}

const HANDLE_POOL_MAX = 16;
const HANDLE_IDLE_TTL_MS = 2000;
const handlePool = new Map<string, CachedHandleEntry>();

function scheduleHandleIdleClose(entry: CachedHandleEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.refCount === 0 && handlePool.get(entry.key) === entry) {
      handlePool.delete(entry.key);
      entry.closing = true;
      void entry.handle.close().catch(() => {});
    }
  }, HANDLE_IDLE_TTL_MS);
  if (typeof entry.timer.unref === 'function') {
    entry.timer.unref();
  }
}

async function invalidateHandlesForPath(fullPath: string): Promise<void> {
  for (const mode of ['r', 'w'] as const) {
    const key = `${mode}:${fullPath}`;
    const entry = handlePool.get(key);
    if (!entry) continue;
    handlePool.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.closing = true;
    if (entry.refCount === 0) {
      try {
        await entry.handle.close();
      } catch {}
    }
  }
}

async function acquirePooledHandle(
  mode: 'r' | 'w',
  fullPath: string,
  openFn: () => Promise<fs.promises.FileHandle>
): Promise<{ entry: CachedHandleEntry | null; handle: fs.promises.FileHandle }> {
  const key = `${mode}:${fullPath}`;
  const existing = handlePool.get(key);
  if (existing && !existing.closing) {
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    existing.refCount++;
    // Refresh insertion order for simple LRU
    handlePool.delete(key);
    handlePool.set(key, existing);
    return { entry: existing, handle: existing.handle };
  }

  const handle = await openFn();
  // Re-check if another concurrent call populated the pool while we awaited openFn
  if (!handlePool.has(key)) {
    if (handlePool.size >= HANDLE_POOL_MAX) {
      for (const [oldKey, oldEntry] of handlePool.entries()) {
        if (oldEntry.refCount === 0) {
          handlePool.delete(oldKey);
          if (oldEntry.timer) clearTimeout(oldEntry.timer);
          oldEntry.closing = true;
          void oldEntry.handle.close().catch(() => {});
          break;
        }
      }
    }
    const entry: CachedHandleEntry = {
      key,
      handle,
      refCount: 1,
      closing: false,
      timer: null,
    };
    handlePool.set(key, entry);
    return { entry, handle };
  }

  // Fallback unpooled handle when pool key raced
  return { entry: null, handle };
}

async function releasePooledHandle(
  entry: CachedHandleEntry | null,
  unpooledHandle: fs.promises.FileHandle,
  closeNow: boolean
): Promise<void> {
  if (!entry) {
    try {
      await unpooledHandle.close();
    } catch {}
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);
  if (closeNow || entry.closing) {
    if (handlePool.get(entry.key) === entry) {
      handlePool.delete(entry.key);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.closing = true;
    if (entry.refCount === 0) {
      try {
        await entry.handle.close();
      } catch {}
    }
    return;
  }

  if (entry.refCount === 0) {
    scheduleHandleIdleClose(entry);
  }
}

async function tryCompressChunk(buf: Buffer, filePath: string, acceptEncoding?: string): Promise<Buffer | null> {
  if (acceptEncoding !== 'gzip' || buf.length < 4096 || isAlreadyCompressedExtension(filePath)) {
    return null;
  }
  if (buf.length >= 65536) {
    const probe = await gzipAsync(buf.subarray(0, 16384), { level: zlib.constants.Z_BEST_SPEED });
    if (probe.length >= 16384 * 0.98) {
      return null;
    }
  }
  const gz = await gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED });
  if (gz.length < buf.length * 0.95) {
    return gz;
  }
  return null;
}

export async function handleFileRpc(control: any, targetWs: any, onActivity?: () => void): Promise<void> {
  const { reqId, action, path: targetPath, params = {}, permissionMode, workspace } = control;
  const reply = (success: boolean, data: any = null, error: string | null = null) => {
    onActivity?.();
    const isOpen = targetWs && (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));
    if (isOpen) {
      sendWsSafe(targetWs, `JSON:${JSON.stringify({
        type: 'file_rpc_res',
        reqId,
        success,
        data,
        error,
      })}`, { compress: false });
    }
  };
  const replyBinaryChunk = (meta: Record<string, any>, rawData: Buffer | null) => {
    onActivity?.();
    const isOpen = targetWs && (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));
    if (isOpen) {
      const pkt = encodeBinaryJsonBufferPacket(
        BIN_MSG_TYPE.FILE_CHUNK_RES,
        reqId,
        { success: true, ...meta },
        rawData || undefined
      );
      sendWsSafe(targetWs, pkt, { binary: true, compress: false });
    }
  };

  try {
    const resolvedPath = resolveWorkingDir(targetPath);
    const mode: PermissionMode = permissionMode || (process.env.GT_PERMISSION_MODE as PermissionMode) || 'default';
    const effectiveWorkspace = workspace || process.env.GT_AGENT_WORKSPACE;

    const permCheck = checkPathPermission(resolvedPath, mode, effectiveWorkspace);
    if (!permCheck.allowed) {
      console.warn(`[SECURITY_AUDIT] BLOCKED file_rpc ${action} on path: "${targetPath}" (mode: ${mode})`);
      return reply(false, null, `SecurityException: ${permCheck.reason}`);
    }

    if (action === 'rename' && params.newPath) {
      const newResolved = resolveWorkingDir(params.newPath);
      const newCheck = checkPathPermission(newResolved, mode, effectiveWorkspace);
      if (!newCheck.allowed) {
        console.warn(`[SECURITY_AUDIT] BLOCKED file_rpc rename target on path: "${params.newPath}" (mode: ${mode})`);
        return reply(false, null, `SecurityException: ${newCheck.reason}`);
      }
    }

    if (action === 'mkdir' && params.dirName) {
      const newDir = path.join(resolvedPath, params.dirName);
      const dirCheck = checkPathPermission(newDir, mode, effectiveWorkspace);
      if (!dirCheck.allowed) {
        console.warn(`[SECURITY_AUDIT] BLOCKED file_rpc mkdir on path: "${newDir}" (mode: ${mode})`);
        return reply(false, null, `SecurityException: ${dirCheck.reason}`);
      }
    }

    if (action === 'upload_chunk' && params.filename) {
      const sanitizedFilename = path.basename(params.filename);
      const uploadFile = path.join(resolvedPath, sanitizedFilename);
      const fileCheck = checkPathPermission(uploadFile, mode, effectiveWorkspace);
      if (!fileCheck.allowed) {
        console.warn(`[SECURITY_AUDIT] BLOCKED file_rpc upload_chunk on path: "${uploadFile}" (mode: ${mode})`);
        return reply(false, null, `SecurityException: ${fileCheck.reason}`);
      }
    }

    if (action === 'list') {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolvedPath);
      } catch (err: any) {
        return reply(false, null, `Path not found: ${resolvedPath}`);
      }
      if (!stat.isDirectory()) {
        return reply(false, null, 'Target is not a directory');
      }
      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const files: any[] = [];
      const batchSize = 64;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (entry) => {
            const full = path.join(resolvedPath, entry.name);
            try {
              const entryStat = await fs.promises.stat(full);
              const isDir = entryStat.isDirectory();
              files.push({
                name: entry.name,
                path: full,
                isDirectory: isDir,
                size: isDir ? 0 : entryStat.size,
                updatedAt: entryStat.mtimeMs,
                extension: isDir ? '' : path.extname(entry.name).replace(/^\./, '').toLowerCase(),
              });
            } catch {}
          })
        );
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
        files,
      });
    }

    if (action === 'read') {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolvedPath);
      } catch {
        return reply(false, null, 'File not found');
      }
      if (stat.isDirectory()) return reply(false, null, 'Target is a directory');
      if (stat.size > 5 * 1024 * 1024) return reply(false, null, 'File exceeds 5MB preview limit');
      const buf = await fs.promises.readFile(resolvedPath);
      const isBinary = buf.slice(0, 1024).includes(0);

      if (params?.acceptEncoding === 'gzip' && !isBinary && buf.length >= 4096) {
        const gz = await gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED });
        if (gz.length < buf.length) {
          return reply(true, {
            path: resolvedPath,
            size: stat.size,
            isBinary: false,
            content: gz.toString('base64'),
            encoding: 'gzip',
          });
        }
      }

      return reply(true, {
        path: resolvedPath,
        size: stat.size,
        isBinary,
        content: isBinary ? '' : buf.toString('utf-8'),
      });
    }

    if (action === 'write') {
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.promises.writeFile(resolvedPath, params.content || '', 'utf-8');
      return reply(true, { success: true });
    }

    if (action === 'mkdir') {
      const full = path.join(resolvedPath, params.dirName || 'new-folder');
      await fs.promises.mkdir(full, { recursive: true });
      return reply(true, { success: true });
    }

    if (action === 'rename') {
      const newPath = resolveWorkingDir(params.newPath);
      await invalidateHandlesForPath(resolvedPath);
      await invalidateHandlesForPath(newPath);
      await fs.promises.rename(resolvedPath, newPath);
      return reply(true, { success: true });
    }

    if (action === 'delete') {
      await invalidateHandlesForPath(resolvedPath);
      const stat = await fs.promises.stat(resolvedPath);
      if (stat.isDirectory()) {
        await fs.promises.rm(resolvedPath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(resolvedPath);
      }
      return reply(true, { success: true });
    }

    if (action === 'upload_chunk') {
      const sanitizedFilename = path.basename(params.filename || '');
      if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
        return reply(false, null, 'Invalid filename');
      }
      const full = path.join(resolvedPath, sanitizedFilename);
      const buf = Buffer.isBuffer(params.rawBuffer)
        ? params.rawBuffer
        : Buffer.from(params.data || '', 'base64');

      const offset = typeof params.offset === 'number' ? params.offset : undefined;
      const truncate = params.truncate === true || (offset === 0 && params.truncate !== false);
      const isLast = params.isLast === true;

      if (offset === undefined) {
        await invalidateHandlesForPath(full);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, buf);
      } else if (truncate) {
        await invalidateHandlesForPath(full);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        const { entry, handle } = await acquirePooledHandle('w', full, () => fs.promises.open(full, 'w'));
        try {
          if (buf.length > 0) {
            await handle.write(buf, 0, buf.length, 0);
          }
        } finally {
          await releasePooledHandle(entry, handle, isLast);
        }
      } else {
        const { entry, handle } = await acquirePooledHandle('w', full, async () => {
          try {
            return await fs.promises.open(full, 'r+');
          } catch {
            await fs.promises.mkdir(path.dirname(full), { recursive: true });
            return await fs.promises.open(full, 'w');
          }
        });
        try {
          if (buf.length > 0) {
            await handle.write(buf, 0, buf.length, offset);
          }
        } finally {
          await releasePooledHandle(entry, handle, isLast);
        }
      }
      return reply(true, { success: true, written: buf.length, offset });
    }

    if (action === 'stat') {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolvedPath);
      } catch {
        return reply(false, null, 'File not found');
      }
      return reply(true, {
        size: stat.size,
        mtime: stat.mtimeMs,
        isDirectory: stat.isDirectory(),
      });
    }

    if (action === 'download_chunk') {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolvedPath);
      } catch {
        return reply(false, null, 'File not found');
      }
      if (stat.isDirectory()) return reply(false, null, 'Target is a directory');

      const useBinaryReply = Boolean(targetWs?._binaryFile === true || control._binaryFile === true);
      const hasSliceParams = params && (params.offset !== undefined || params.length !== undefined);
      if (!hasSliceParams) {
        const maxInlineBytes = typeof params?.maxInlineBytes === 'number' ? params.maxInlineBytes : 0;
        if (maxInlineBytes > 0 && stat.size > maxInlineBytes) {
          return reply(true, {
            tooLargeForInline: true,
            size: stat.size,
          });
        }
        const MAX_DIRECT_READ = 10 * 1024 * 1024; // 10MB OOM protection guard for unchunked fallback
        if (stat.size > MAX_DIRECT_READ) {
          return reply(false, null, 'File exceeds 10MB direct download limit; chunked range transfer required');
        }
        const buf = await fs.promises.readFile(resolvedPath);
        const gz = await tryCompressChunk(buf, resolvedPath, params?.acceptEncoding);
        if (gz) {
          if (useBinaryReply) {
            replyBinaryChunk({ encoding: 'gzip', size: stat.size, offset: 0, length: buf.length }, gz);
            return;
          }
          return reply(true, {
            data: gz.toString('base64'),
            encoding: 'gzip',
            size: stat.size,
            offset: 0,
            length: buf.length,
          });
        }
        if (useBinaryReply) {
          replyBinaryChunk({ size: stat.size, offset: 0, length: buf.length }, buf);
          return;
        }
        return reply(true, buf.toString('base64'));
      }

      const offset = Number(params.offset) || 0;
      const length = params.length !== undefined ? Number(params.length) : (stat.size - offset);

      if (isNaN(offset) || isNaN(length) || offset < 0 || length < 0 || offset > stat.size) {
        return reply(false, null, 'Invalid offset or length');
      }

      if (length === 0 || offset === stat.size) {
        if (useBinaryReply) {
          replyBinaryChunk({ size: stat.size, offset, length: 0 }, null);
          return;
        }
        return reply(true, { data: '', size: stat.size, offset, length: 0 });
      }

      const safeLength = Math.min(length, stat.size - offset);
      const { entry, handle } = await acquirePooledHandle('r', resolvedPath, () =>
        fs.promises.open(resolvedPath, 'r')
      );
      let reachedEof = false;
      try {
        const buffer = Buffer.allocUnsafe(safeLength);
        const { bytesRead } = await handle.read(buffer, 0, safeLength, offset);
        reachedEof = offset + bytesRead >= stat.size;
        const chunk = bytesRead < safeLength ? buffer.subarray(0, bytesRead) : buffer;

        const gz = await tryCompressChunk(chunk, resolvedPath, params?.acceptEncoding);
        if (gz) {
          if (useBinaryReply) {
            replyBinaryChunk({ encoding: 'gzip', size: stat.size, offset, length: bytesRead }, gz);
            return;
          }
          return reply(true, {
            data: gz.toString('base64'),
            encoding: 'gzip',
            size: stat.size,
            offset,
            length: bytesRead,
          });
        }

        if (useBinaryReply) {
          replyBinaryChunk({ size: stat.size, offset, length: bytesRead }, chunk);
          return;
        }
        return reply(true, {
          data: chunk.toString('base64'),
          size: stat.size,
          offset,
          length: bytesRead,
        });
      } finally {
        await releasePooledHandle(entry, handle, reachedEof);
      }
    }

    reply(false, null, `Unknown action: ${action}`);
  } catch (err: any) {
    reply(false, null, err.message);
  }
}
