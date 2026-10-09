import fs from 'fs';
import path from 'path';
import { resolveWorkingDir } from '../tasks/taskManager';

export function handleFileRpc(control: any, targetWs: any): void {
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
      if (!fs.existsSync(resolvedPath)) {
        return reply(false, null, `Path not found: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return reply(false, null, 'Target is not a directory');
      }
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      const files: any[] = [];
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
        files,
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
        content: isBinary ? '' : buf.toString('utf-8'),
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
  } catch (err: any) {
    reply(false, null, err.message);
  }
}
