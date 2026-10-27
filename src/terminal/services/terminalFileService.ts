import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { Readable } from 'stream';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';

const gunzipAsync = promisify(zlib.gunzip);

export const DEFAULT_DOWNLOAD_CHUNK_SIZE = 512 * 1024; // 512KB
export const DEFAULT_PREFETCH_CONCURRENCY = 2;

export function decodeAgentChunkBuffer(resData: any): Buffer {
  if (!resData) return Buffer.alloc(0);
  if (typeof resData === 'string') {
    return Buffer.from(resData, 'base64');
  }
  const base64Str = typeof resData.data === 'string' ? resData.data : '';
  const buf = Buffer.from(base64Str, 'base64');
  if (resData.encoding === 'gzip') {
    return zlib.gunzipSync(buf);
  }
  return buf;
}

export async function decodeAgentChunkBufferAsync(resData: any): Promise<Buffer> {
  if (!resData) return Buffer.alloc(0);
  if (typeof resData === 'string') {
    return Buffer.from(resData, 'base64');
  }
  const base64Str = typeof resData.data === 'string' ? resData.data : '';
  const buf = Buffer.from(base64Str, 'base64');
  if (resData.encoding === 'gzip') {
    return gunzipAsync(buf);
  }
  return buf;
}

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

    const res = await this.rpcAgentWithRetry(hostId, 'list', inputPath || '');
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

    const res = await this.rpcAgentWithRetry(hostId, 'read', filePath, { acceptEncoding: 'gzip' });
    if (res && res.success && res.data) {
      let content = res.data.content;
      if (res.data.encoding === 'gzip' && typeof content === 'string') {
        try {
          content = (await gunzipAsync(Buffer.from(content, 'base64'))).toString('utf-8');
        } catch (err: any) {
          logger.error(`Failed to decompress file content: ${err.message}`);
        }
      }
      return {
        success: true,
        ...res.data,
        content,
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
    const res = await this.rpcAgentWithRetry(hostId, 'stat', filePath);
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
    const CHUNK_THRESHOLD = DEFAULT_DOWNLOAD_CHUNK_SIZE; // 1MB

    // If a range is provided and length is greater than 1MB, stream in chunks
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
    const params = range
      ? { offset: range.offset, length: range.length, acceptEncoding: 'gzip' }
      : { acceptEncoding: 'gzip' };
    const res = await this.rpcAgentWithRetry(hostId, 'download_chunk', filePath, params, 60000);
    if (!res || !res.success || res.data === undefined || res.data === null) {
      const isNotFound = res?.error && (res.error.toLowerCase().includes('not found') || res.error.toLowerCase().includes('no such file'));
      return { status: isNotFound ? 404 : 500, filename, error: res?.error || 'Failed to fetch file from agent' };
    }

    const buffer = await decodeAgentChunkBufferAsync(res.data);
    let totalSize: number | undefined;

    if (typeof res.data === 'string') {
      totalSize = buffer.length;
    } else {
      totalSize = typeof res.data.size === 'number' ? res.data.size : buffer.length;
    }

    const stream = Readable.from(buffer);
    return { status: 200, filename, size: buffer.length, totalSize, stream };
  }

  /**
   * Creates a Readable stream that pulls data from the agent with 1MB 4-way concurrent read-ahead prefetch pipeline.
   * Completely avoids memory spikes and RPC timeouts for large files over WAN, eliminating stop-and-wait latency.
   */
  private createAgentChunkedStream(
    hostId: string,
    filePath: string,
    startOffset: number,
    totalLength: number,
    chunkSize: number = DEFAULT_DOWNLOAD_CHUNK_SIZE,
    concurrency: number = DEFAULT_PREFETCH_CONCURRENCY
  ): NodeJS.ReadableStream {
    if (totalLength <= 0) {
      return Readable.from([]);
    }

    const totalChunks = Math.ceil(totalLength / chunkSize);
    let nextDispatchIndex = 0;
    let nextEmitIndex = 0;
    let isDestroyed = false;
    let canPush = true;
    const completedBuffers = new Map<number, Buffer>();

    const self = this;

    const stream = new Readable({
      read() {
        canPush = true;
        flush();
        pump();
      },
      destroy(err, callback) {
        isDestroyed = true;
        completedBuffers.clear();
        callback(err);
      },
    });

    function flush(): void {
      while (canPush && !isDestroyed && completedBuffers.has(nextEmitIndex)) {
        const buf = completedBuffers.get(nextEmitIndex)!;
        completedBuffers.delete(nextEmitIndex);
        nextEmitIndex++;
        if (buf.length > 0) {
          canPush = stream.push(buf);
        }
        if (nextEmitIndex >= totalChunks) {
          stream.push(null);
          return;
        }
      }
      if (!isDestroyed && nextEmitIndex >= totalChunks && completedBuffers.size === 0) {
        stream.push(null);
      }
    }

    function pump(): void {
      if (isDestroyed) return;
      while (
        !isDestroyed &&
        nextDispatchIndex < totalChunks &&
        (nextDispatchIndex - nextEmitIndex) < concurrency
      ) {
        const chunkIndex = nextDispatchIndex++;
        const offset = startOffset + chunkIndex * chunkSize;
        const length = Math.min(chunkSize, startOffset + totalLength - offset);

        self.rpcAgentWithRetry(
          hostId,
          'download_chunk',
          filePath,
          {
            offset,
            length,
            acceptEncoding: 'gzip',
          },
          60000
        ).then(async (res) => {
          if (isDestroyed) return;

          if (!res || !res.success || res.data === undefined || res.data === null) {
            isDestroyed = true;
            stream.destroy(new Error(res?.error || 'Failed to read chunk from agent'));
            return;
          }

          const buffer = await decodeAgentChunkBufferAsync(res.data);
          completedBuffers.set(chunkIndex, buffer);
          flush();
          pump();
        }).catch((err) => {
          if (!isDestroyed) {
            isDestroyed = true;
            stream.destroy(err);
          }
        });
      }
    }

    return stream;
  }

  /**
   * Save uploaded file via agent RPC with chunked streaming to prevent high memory usage.
   * If a Buffer is passed, small buffers (<=512KB) use single chunk RPC,
   * while larger buffers or streams are chunked into 512KB RPC requests sequentially.
   */
  public async saveUploadedFile(
    hostId: string,
    targetDir: string,
    filename: string,
    data: Buffer | NodeJS.ReadableStream
  ): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }

    if (Buffer.isBuffer(data)) {
      const CHUNK_SIZE = 512 * 1024;
      if (data.length <= CHUNK_SIZE) {
        return this.rpcAgent(hostId, 'upload_chunk', targetDir, {
          filename,
          data: data.toString('base64'),
          offset: 0,
          truncate: true,
        });
      }
      return this.saveUploadedStream(hostId, targetDir, filename, Readable.from(data), CHUNK_SIZE);
    }

    return this.saveUploadedStream(hostId, targetDir, filename, data);
  }

  /**
   * Streams a file from a ReadableStream directly to the Agent in 512KB chunks.
   * Neither server nor agent ever buffers the whole file in memory.
   */
  public async saveUploadedStream(
    hostId: string,
    targetDir: string,
    filename: string,
    stream: NodeJS.ReadableStream,
    chunkSize: number = 512 * 1024
  ): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }

    let currentOffset = 0;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;

    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pendingChunks.push(buf);
        pendingBytes += buf.length;

        while (pendingBytes >= chunkSize) {
          const combined = Buffer.concat(pendingChunks);
          const toSend = combined.slice(0, chunkSize);
          const rest = combined.slice(chunkSize);
          pendingChunks = rest.length > 0 ? [rest] : [];
          pendingBytes = rest.length;

          const res = await this.rpcAgent(hostId, 'upload_chunk', targetDir, {
            filename,
            data: toSend.toString('base64'),
            offset: currentOffset,
            truncate: currentOffset === 0,
          }, 60000);

          if (!res || !res.success) {
            return { success: false, error: res?.error || 'Failed to upload file chunk to agent' };
          }
          currentOffset += toSend.length;
        }
      }

      // Flush any remaining bytes, or if file was 0 bytes, ensure an empty file is created
      if (pendingBytes > 0 || currentOffset === 0) {
        const combined = Buffer.concat(pendingChunks);
        const res = await this.rpcAgent(hostId, 'upload_chunk', targetDir, {
          filename,
          data: combined.toString('base64'),
          offset: currentOffset,
          truncate: currentOffset === 0,
        }, 60000);

        if (!res || !res.success) {
          return { success: false, error: res?.error || 'Failed to upload final file chunk to agent' };
        }
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Error processing stream upload' };
    }
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

  /**
   * RPC bridge for Remote Agent with automatic retry for transient reconnects
   */
  private async rpcAgentWithRetry(
    hostId: string,
    action: string,
    targetPath: string,
    params?: any,
    timeoutMs?: number,
    maxRetries: number = 3
  ): Promise<any> {
    const RETRYABLE_PATTERN = /reconnected|previous RPC cancelled|not connected|offline/i;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await this.rpcAgent(hostId, action, targetPath, params, timeoutMs);
      if (res && res.success) {
        return res;
      }
      const isRetryable = res?.error && RETRYABLE_PATTERN.test(res.error);
      if (isRetryable && attempt < maxRetries) {
        const delay = 400 * (attempt + 1);
        logger.warn(
          `[TerminalFileService] RPC ${action} on ${hostId} failed with "${res?.error}". Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return res;
    }
  }
}

export const terminalFileService = new TerminalFileService();
export default terminalFileService;
