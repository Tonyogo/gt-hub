import path from 'path';
import { Readable } from 'stream';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';

export interface TerminalFileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  updatedAt: number;
  extension: string;
}

export interface ListFilesResult {
  success: boolean;
  currentPath: string;
  parentPath: string | null;
  separator: string;
  files: TerminalFileItem[];
  error?: string;
}

export interface ReadFileResult {
  success: boolean;
  path: string;
  content?: string;
  size: number;
  isBinary: boolean;
  error?: string;
}

export class TerminalFileService {
  /**
   * List files in a directory via agent RPC
   */
  public async listFiles(hostId: string, inputPath?: string): Promise<ListFilesResult> {
    if (!hostId || !hostId.trim()) {
      return {
        success: false,
        currentPath: inputPath || '',
        parentPath: null,
        separator: '/',
        files: [],
        error: 'hostId is required',
      };
    }

    const res = await this.rpcAgent(hostId, 'list', inputPath || '');
    if (res && res.success && res.data) {
      return {
        success: true,
        ...res.data,
      };
    }
    return {
      success: false,
      currentPath: inputPath || '',
      parentPath: null,
      separator: '/',
      files: [],
      error: res?.error || 'Failed to list files from agent',
    };
  }

  /**
   * Read file text content via agent RPC
   */
  public async readFileContent(hostId: string, filePath: string): Promise<ReadFileResult> {
    if (!hostId || !hostId.trim()) {
      return {
        success: false,
        path: filePath,
        size: 0,
        isBinary: false,
        error: 'hostId is required',
      };
    }

    const res = await this.rpcAgent(hostId, 'read', filePath);
    if (res && res.success && res.data) {
      return {
        success: true,
        ...res.data,
      };
    }
    return {
      success: false,
      path: filePath,
      size: 0,
      isBinary: false,
      error: res?.error || 'Failed to read file from agent',
    };
  }

  /**
   * Save file content via agent RPC
   */
  public async saveFileContent(hostId: string, filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    return this.rpcAgent(hostId, 'write', filePath, { content });
  }

  /**
   * Create directory via agent RPC
   */
  public async createDirectory(hostId: string, targetPath: string, dirName: string): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    return this.rpcAgent(hostId, 'mkdir', targetPath, { dirName });
  }

  /**
   * Rename file or directory via agent RPC
   */
  public async renameFile(hostId: string, oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    return this.rpcAgent(hostId, 'rename', oldPath, { newPath });
  }

  /**
   * Delete file or directory via agent RPC
   */
  public async deleteItem(hostId: string, targetPath: string): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    return this.rpcAgent(hostId, 'delete', targetPath);
  }

  /**
   * Get file metadata (size, mtime) via agent RPC
   */
  public async getFileStat(hostId: string, filePath: string): Promise<{
    success: boolean;
    size?: number;
    mtime?: number;
    isDirectory?: boolean;
    error?: string;
  }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    const res = await this.rpcAgent(hostId, 'stat', filePath);
    if (res && res.success && res.data) {
      return {
        success: true,
        size: res.data.size,
        mtime: res.data.mtime,
        isDirectory: res.data.isDirectory,
      };
    }
    return {
      success: false,
      error: res?.error || 'Failed to stat file from agent',
    };
  }

  /**
   * Get file stream for download via agent RPC, supporting optional slice range.
   * For files/slices larger than 1MB, streams chunk-by-chunk to prevent memory spikes & 30s timeouts.
   */
  public async getFileStream(
    hostId: string,
    filePath: string,
    range?: { offset: number; length: number }
  ): Promise<{
    status: number;
    filename: string;
    size?: number;
    totalSize?: number;
    stream?: NodeJS.ReadableStream;
    error?: string;
  }> {
    if (!hostId || !hostId.trim()) {
      return { status: 400, filename: path.basename(filePath), error: 'hostId is required' };
    }

    const filename = path.basename(filePath);
    const CHUNK_THRESHOLD = 512 * 1024; // 512KB

    // If a range is provided and length is greater than 512KB, stream in chunks
    if (range && range.length > CHUNK_THRESHOLD) {
      const stream = this.createAgentChunkedStream(hostId, filePath, range.offset, range.length);
      return {
        status: 200,
        filename,
        size: range.length,
        stream,
      };
    }

    // If no range is provided, check if we can get totalSize and stream chunk-by-chunk
    if (!range) {
      const statRes = await this.getFileStat(hostId, filePath);
      if (statRes.success && typeof statRes.size === 'number' && statRes.size > CHUNK_THRESHOLD) {
        const stream = this.createAgentChunkedStream(hostId, filePath, 0, statRes.size);
        return {
          status: 200,
          filename,
          size: statRes.size,
          totalSize: statRes.size,
          stream,
        };
      }
    }

    // Single chunk fetch for files/slices <= 512KB (or fallback when stat fails)
    const params = range ? { offset: range.offset, length: range.length } : undefined;
    const res = await this.rpcAgent(hostId, 'download_chunk', filePath, params, 60000);
    if (!res || !res.success || res.data === undefined || res.data === null) {
      const isNotFound = res?.error && (res.error.toLowerCase().includes('not found') || res.error.toLowerCase().includes('no such file'));
      return { status: isNotFound ? 404 : 500, filename, error: res?.error || 'Failed to fetch file from agent' };
    }

    let buffer: Buffer;
    let totalSize: number | undefined;

    if (typeof res.data === 'string') {
      buffer = Buffer.from(res.data, 'base64');
      totalSize = buffer.length;
    } else {
      buffer = Buffer.from(res.data.data || '', 'base64');
      totalSize = typeof res.data.size === 'number' ? res.data.size : undefined;
    }

    const stream = Readable.from(buffer);
    return { status: 200, filename, size: buffer.length, totalSize, stream };
  }

  /**
   * Creates a Readable stream that pulls data from the agent in 512KB chunks sequentially.
   * Completely avoids memory spikes and RPC timeouts for large files over WAN.
   */
  private createAgentChunkedStream(
    hostId: string,
    filePath: string,
    startOffset: number,
    totalLength: number,
    chunkSize: number = 512 * 1024
  ): NodeJS.ReadableStream {
    const endOffset = startOffset + totalLength - 1;
    let currentOffset = startOffset;
    let isFetching = false;
    let isDestroyed = false;

    const self = this;
    return new Readable({
      async read() {
        if (isFetching || isDestroyed) return;
        if (currentOffset > endOffset) {
          this.push(null); // EOF
          return;
        }

        isFetching = true;
        try {
          const remaining = endOffset - currentOffset + 1;
          const fetchLength = Math.min(chunkSize, remaining);

          const res = await self.rpcAgent(hostId, 'download_chunk', filePath, {
            offset: currentOffset,
            length: fetchLength,
          }, 60000);

          if (isDestroyed) return;

          if (!res || !res.success || res.data === undefined || res.data === null) {
            this.destroy(new Error(res?.error || 'Failed to read chunk from agent'));
            return;
          }

          let buffer: Buffer;
          if (typeof res.data === 'string') {
            buffer = Buffer.from(res.data, 'base64');
          } else if (res.data.data) {
            buffer = Buffer.from(res.data.data, 'base64');
          } else {
            buffer = Buffer.alloc(0);
          }

          if (buffer.length === 0) {
            this.push(null);
            return;
          }

          currentOffset += buffer.length;
          isFetching = false;
          this.push(buffer);
        } catch (err: any) {
          if (!isDestroyed) {
            this.destroy(err);
          }
        }
      },
      destroy(err, callback) {
        isDestroyed = true;
        callback(err);
      },
    });
  }

  /**
   * Save uploaded file via agent RPC
   */
  public async saveUploadedFile(
    hostId: string,
    targetDir: string,
    filename: string,
    buffer: Buffer
  ): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    return this.rpcAgent(hostId, 'upload_chunk', targetDir, {
      filename,
      data: buffer.toString('base64'),
    });
  }

  /**
   * RPC bridge for Remote Agent
   */
  private async rpcAgent(hostId: string, action: string, targetPath: string, params?: any, timeoutMs?: number): Promise<any> {
    return terminalHostManager.executeFileRpc(hostId, {
      action,
      path: targetPath,
      params,
    }, timeoutMs);
  }
}

export const terminalFileService = new TerminalFileService();
export default terminalFileService;
