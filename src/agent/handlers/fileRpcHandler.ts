import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { resolveWorkingDir } from '../tasks/taskManager';
import { checkPathPermission, PermissionMode } from '../security/pathGuard';

const gzipAsync = promisify(zlib.gzip);

export const COMPRESSED_EXTENSIONS = new Set([
  'zip', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'zst',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3', 'woff2'
]);

export function isAlreadyCompressedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return COMPRESSED_EXTENSIONS.has(ext);
}

export async function handleFileRpc(control: any, targetWs: any, onActivity?: () => void): Promise<void> {
  const { reqId, action, path: targetPath, params = {}, permissionMode, workspace } = control;
  const reply = (success: boolean, data: any = null, error: string | null = null) => {
    onActivity?.();
    const isOpen = targetWs && (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));
    if (isOpen) {
      targetWs.send(`JSON:${JSON.stringify({
        type: 'file_rpc_res',
        reqId,
        success,
        data,
        error,
      })}`);
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
      await fs.promises.rename(resolvedPath, newPath);
      return reply(true, { success: true });
    }

    if (action === 'delete') {
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
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      const buf = Buffer.from(params.data || '', 'base64');

      const offset = typeof params.offset === 'number' ? params.offset : undefined;
      const truncate = params.truncate === true || (offset === 0 && params.truncate !== false);

      if (offset === undefined) {
        // Full file write (backwards compatible single-chunk)
        await fs.promises.writeFile(full, buf);
      } else if (truncate) {
        // First chunk or explicit truncate: open with 'w' to truncate/create
        const handle = await fs.promises.open(full, 'w');
        try {
          if (buf.length > 0) {
            await handle.write(buf, 0, buf.length, 0);
          }
        } finally {
          await handle.close();
        }
      } else {
        // Subsequent chunk at specific offset: open with 'r+' (or create if missing)
        let handle: fs.promises.FileHandle;
        try {
          handle = await fs.promises.open(full, 'r+');
        } catch {
          handle = await fs.promises.open(full, 'w');
        }
        try {
          if (buf.length > 0) {
            await handle.write(buf, 0, buf.length, offset);
          }
        } finally {
          await handle.close();
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

      const hasSliceParams = params && (params.offset !== undefined || params.length !== undefined);
      if (!hasSliceParams) {
        const MAX_DIRECT_READ = 10 * 1024 * 1024; // 10MB OOM protection guard for unchunked fallback
        if (stat.size > MAX_DIRECT_READ) {
          return reply(false, null, 'File exceeds 10MB direct download limit; chunked range transfer required');
        }
        const buf = await fs.promises.readFile(resolvedPath);
        if (params?.acceptEncoding === 'gzip' && buf.length >= 4096 && !isAlreadyCompressedExtension(resolvedPath)) {
          const gz = await gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED });
          if (gz.length < buf.length) {
            return reply(true, {
              data: gz.toString('base64'),
              encoding: 'gzip',
              size: stat.size,
              offset: 0,
              length: buf.length,
            });
          }
        }
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
      const handle = await fs.promises.open(resolvedPath, 'r');
      try {
        const buffer = Buffer.alloc(safeLength);
        const { bytesRead } = await handle.read(buffer, 0, safeLength, offset);
        const chunk = bytesRead < safeLength ? buffer.slice(0, bytesRead) : buffer;

        if (params?.acceptEncoding === 'gzip' && chunk.length >= 4096 && !isAlreadyCompressedExtension(resolvedPath)) {
          const gz = await gzipAsync(chunk, { level: zlib.constants.Z_BEST_SPEED });
          if (gz.length < chunk.length) {
            return reply(true, {
              data: gz.toString('base64'),
              encoding: 'gzip',
              size: stat.size,
              offset,
              length: bytesRead,
            });
          }
        }

        return reply(true, {
          data: chunk.toString('base64'),
          size: stat.size,
          offset,
          length: bytesRead,
        });
      } finally {
        await handle.close();
      }
    }

    reply(false, null, `Unknown action: ${action}`);
  } catch (err: any) {
    reply(false, null, err.message);
  }
}
