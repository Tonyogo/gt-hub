import fs from 'fs';
import path from 'path';
import { resolveWorkingDir } from '../tasks/taskManager';

export async function handleFileRpc(control: any, targetWs: any): Promise<void> {
  const { reqId, action, path: targetPath, params = {} } = control;
  const reply = (success: boolean, data: any = null, error: string | null = null) => {
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
      await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(resolvedPath, entry.name);
          try {
            const entryStat = await fs.promises.stat(full);
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
        })
      );
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
      const full = path.join(resolvedPath, params.filename);
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
        const buf = await fs.promises.readFile(resolvedPath);
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
