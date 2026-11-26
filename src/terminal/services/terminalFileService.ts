import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { Readable } from 'stream';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';

const gunzipAsync = promisify(zlib.gunzip);
const gzipAsync = promisify(zlib.gzip);

export const DEFAULT_DOWNLOAD_CHUNK_SIZE = 512 * 1024; // 512KB
export const DEFAULT_PREFETCH_CONCURRENCY = 2;
export const DEFAULT_UPLOAD_CONCURRENCY = 4;

export function decodeAgentChunkBuffer(resData: any): Buffer {
  if (!resData) return Buffer.alloc(0);
  if (typeof resData === 'string') {
    return Buffer.from(resData, 'base64');
  }
  const buf = Buffer.isBuffer(resData.rawBuffer)
    ? resData.rawBuffer
    : Buffer.from(typeof resData.data === 'string' ? resData.data : '', 'base64');
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
  const buf = Buffer.isBuffer(resData.rawBuffer)
    ? resData.rawBuffer
    : Buffer.from(typeof resData.data === 'string' ? resData.data : '', 'base64');
  if (resData.encoding === 'gzip') {
    return gunzipAsync(buf);
  }
  return buf;
}

export async function passthroughOrGzipAgentChunkAsync(resData: any): Promise<Buffer> {
  if (!resData) return Buffer.alloc(0);
  if (typeof resData === 'string') {
    const raw = Buffer.from(resData, 'base64');
    return gzipAsync(raw, { level: zlib.constants.Z_BEST_SPEED });
  }
  const buf = Buffer.isBuffer(resData.rawBuffer)
    ? resData.rawBuffer
    : Buffer.from(typeof resData.data === 'string' ? resData.data : '', 'base64');
  if (resData.encoding === 'gzip') {
    return buf;
  }
  if (buf.length === 0) return buf;
  return gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED });
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
    range?: { offset: number; length: number },
    options?: { preferGzipPassthrough?: boolean }
  ): Promise<{
    status: number;
    filename: string;
    size?: number;
    totalSize?: number;
    isGzippedStream?: boolean;
    stream?: NodeJS.ReadableStream;
    error?: string;
  }> {
    if (!hostId || !hostId.trim()) {
      return { status: 400, filename: path.basename(filePath), error: 'hostId is required' };
    }

    const filename = path.basename(filePath);
    const CHUNK_THRESHOLD = DEFAULT_DOWNLOAD_CHUNK_SIZE;
    const preferGzipPassthrough = Boolean(options?.preferGzipPassthrough);

    // If a range is provided and length is greater than threshold, stream in chunks
    if (range && range.length > CHUNK_THRESHOLD) {
      const stream = this.createAgentChunkedStream(
        hostId,
        filePath,
        range.offset,
        range.length,
        DEFAULT_DOWNLOAD_CHUNK_SIZE,
        DEFAULT_PREFETCH_CONCURRENCY,
        preferGzipPassthrough
      );
      return {
        status: 200,
        filename,
        size: range.length,
        ...(preferGzipPassthrough ? { isGzippedStream: true } : {}),
        stream,
      };
    }

    const session = terminalHostManager.getSession(hostId);
    const supportsBinaryFile = Boolean((session?.getAgentWs() as any)?._binaryFile === true);

    // For binaryFile-capable agents without Range: try 1-RTT inline fetch (<= 512KB) first
    if (!range && supportsBinaryFile) {
      const res = await this.rpcAgentWithRetry(
        hostId,
        'download_chunk',
        filePath,
        { acceptEncoding: 'gzip', maxInlineBytes: CHUNK_THRESHOLD },
        60000
      );
      if (!res || !res.success || res.data === undefined || res.data === null) {
        const isNotFound = res?.error && (res.error.toLowerCase().includes('not found') || res.error.toLowerCase().includes('no such file'));
        return { status: isNotFound ? 404 : 500, filename, error: res?.error || 'Failed to fetch file from agent' };
      }

      if (res.data.tooLargeForInline && typeof res.data.size === 'number') {
        const stream = this.createAgentChunkedStream(
          hostId,
          filePath,
          0,
          res.data.size,
          DEFAULT_DOWNLOAD_CHUNK_SIZE,
          DEFAULT_PREFETCH_CONCURRENCY,
          preferGzipPassthrough
        );
        return {
          status: 200,
          filename,
          size: res.data.size,
          totalSize: res.data.size,
          ...(preferGzipPassthrough ? { isGzippedStream: true } : {}),
          stream,
        };
      }

      const rawSize = typeof res.data.size === 'number' ? res.data.size : undefined;
      if (preferGzipPassthrough) {
        const gzBuf = await passthroughOrGzipAgentChunkAsync(res.data);
        return {
          status: 200,
          filename,
          size: rawSize ?? gzBuf.length,
          totalSize: rawSize ?? gzBuf.length,
          isGzippedStream: true,
          stream: Readable.from(gzBuf),
        };
      }

      const buffer = await decodeAgentChunkBufferAsync(res.data);
      const totalSize = rawSize ?? buffer.length;
      return { status: 200, filename, size: buffer.length, totalSize, stream: Readable.from(buffer) };
    }

    // If no range is provided (legacy / mock agent), check totalSize and stream chunk-by-chunk
    if (!range) {
      const statRes = await this.getFileStat(hostId, filePath);
      if (statRes.success && typeof statRes.size === 'number' && statRes.size > CHUNK_THRESHOLD) {
        const stream = this.createAgentChunkedStream(
          hostId,
          filePath,
          0,
          statRes.size,
          DEFAULT_DOWNLOAD_CHUNK_SIZE,
          DEFAULT_PREFETCH_CONCURRENCY,
          preferGzipPassthrough
        );
        return {
          status: 200,
          filename,
          size: statRes.size,
          totalSize: statRes.size,
          ...(preferGzipPassthrough ? { isGzippedStream: true } : {}),
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

    if (preferGzipPassthrough) {
      const gzBuf = await passthroughOrGzipAgentChunkAsync(res.data);
      const totalSize = typeof res.data === 'string' ? undefined : (typeof res.data.size === 'number' ? res.data.size : undefined);
      return {
        status: 200,
        filename,
        size: totalSize ?? gzBuf.length,
        totalSize: totalSize ?? gzBuf.length,
        isGzippedStream: true,
        stream: Readable.from(gzBuf),
      };
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
   * Creates a Readable stream that pulls data from the agent with concurrent read-ahead prefetch pipeline.
   * Completely avoids memory spikes and RPC timeouts for large files over WAN, eliminating stop-and-wait latency.
   */
  private createAgentChunkedStream(
    hostId: string,
    filePath: string,
    startOffset: number,
    totalLength: number,
    chunkSize: number = DEFAULT_DOWNLOAD_CHUNK_SIZE,
    concurrency: number = DEFAULT_PREFETCH_CONCURRENCY,
    preferGzipPassthrough: boolean = false
  ): NodeJS.ReadableStream {
    if (totalLength <= 0) {
      return Readable.from([]);
    }

    const totalChunks = Math.ceil(totalLength / chunkSize);
    let nextDispatchIndex = 0;
    let nextEmitIndex = 0;
    let isDestroyed = false;
    let canPush = true;
    let gzipDisabled = false;
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
        const rpcParams: Record<string, any> = { offset, length };
        if (!gzipDisabled) {
          rpcParams.acceptEncoding = 'gzip';
        }

        self.rpcAgentWithRetry(
          hostId,
          'download_chunk',
          filePath,
          rpcParams,
          60000
        ).then(async (res) => {
          if (isDestroyed) return;

          if (!res || !res.success || res.data === undefined || res.data === null) {
            isDestroyed = true;
            stream.destroy(new Error(res?.error || 'Failed to read chunk from agent'));
            return;
          }

          if (chunkIndex === 0 && length >= 4096 && res.data?.encoding !== 'gzip') {
            gzipDisabled = true;
          }

          const buffer = preferGzipPassthrough
            ? await passthroughOrGzipAgentChunkAsync(res.data)
            : await decodeAgentChunkBufferAsync(res.data);
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
   * If a Buffer is passed, slices chunks directly without intermediate stream wrapping.
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
          rawBuffer: data,
          offset: 0,
          truncate: true,
          isLast: true,
        });
      }

      // First chunk truncates/creates target file cleanly
      const firstSlice = data.subarray(0, CHUNK_SIZE);
      const firstRes = await this.rpcAgent(hostId, 'upload_chunk', targetDir, {
        filename,
        rawBuffer: firstSlice,
        offset: 0,
        truncate: true,
        isLast: false,
      }, 60000);
      if (!firstRes || !firstRes.success) {
        return { success: false, error: firstRes?.error || 'Failed to upload file chunk to agent' };
      }

      // Pipeline remaining chunks concurrently (up to DEFAULT_UPLOAD_CONCURRENCY)
      const inFlight = new Set<Promise<void>>();
      let uploadErr: Error | null = null;
      for (let offset = CHUNK_SIZE; offset < data.length; offset += CHUNK_SIZE) {
        if (uploadErr) break;
        const end = Math.min(offset + CHUNK_SIZE, data.length);
        const isLast = end >= data.length;
        const slice = data.subarray(offset, end);

        const p = this.rpcAgent(hostId, 'upload_chunk', targetDir, {
          filename,
          rawBuffer: slice,
          offset,
          truncate: false,
          isLast,
        }, 60000).then((res) => {
          if (!res || !res.success) {
            throw new Error(res?.error || 'Failed to upload file chunk to agent');
          }
        }).catch((err: any) => {
          if (!uploadErr) uploadErr = err instanceof Error ? err : new Error(String(err));
        }).finally(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);

        if (inFlight.size >= DEFAULT_UPLOAD_CONCURRENCY) {
          await Promise.race(inFlight);
        }
      }

      if (inFlight.size > 0) {
        await Promise.all(inFlight);
      }
      if (uploadErr) {
        return { success: false, error: (uploadErr as Error).message };
      }
      return { success: true };
    }

    return this.saveUploadedStream(hostId, targetDir, filename, data);
  }

  /**
   * Streams a file from a ReadableStream to the Agent in 512KB chunks with bounded concurrency.
   * Chunk 0 truncates/creates synchronously first; subsequent chunks pipeline up to concurrency=4.
   */
  public async saveUploadedStream(
    hostId: string,
    targetDir: string,
    filename: string,
    stream: NodeJS.ReadableStream,
    chunkSize: number = 512 * 1024,
    concurrency: number = DEFAULT_UPLOAD_CONCURRENCY
  ): Promise<{ success: boolean; error?: string }> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }

    let currentOffset = 0;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    const inFlight = new Set<Promise<void>>();
    let uploadErr: Error | null = null;

    const sendChunk = async (buf: Buffer, offset: number, truncate: boolean, isLast: boolean): Promise<void> => {
      const res = await this.rpcAgent(hostId, 'upload_chunk', targetDir, {
        filename,
        rawBuffer: buf,
        offset,
        truncate,
        isLast,
      }, 60000);
      if (!res || !res.success) {
        throw new Error(res?.error || 'Failed to upload file chunk to agent');
      }
    };

    try {
      for await (const chunk of stream) {
        if (uploadErr) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pendingChunks.push(buf);
        pendingBytes += buf.length;

        while (pendingBytes >= chunkSize) {
          if (uploadErr) break;
          const combined = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
          const toSend = combined.subarray(0, chunkSize);
          const rest = combined.subarray(chunkSize);
          pendingChunks = rest.length > 0 ? [rest] : [];
          pendingBytes = rest.length;

          const chunkOffset = currentOffset;
          currentOffset += toSend.length;

          if (chunkOffset === 0) {
            await sendChunk(toSend, 0, true, false);
          } else {
            const p = sendChunk(toSend, chunkOffset, false, false)
              .catch((err: any) => {
                if (!uploadErr) uploadErr = err instanceof Error ? err : new Error(String(err));
              })
              .finally(() => {
                inFlight.delete(p);
              });
            inFlight.add(p);

            if (inFlight.size >= concurrency) {
              await Promise.race(inFlight);
            }
          }
        }
      }

      if (inFlight.size > 0) {
        await Promise.all(inFlight);
      }
      if (uploadErr) {
        return { success: false, error: (uploadErr as Error).message };
      }

      // Flush any remaining bytes, or if file was 0 bytes, ensure an empty file is created
      if (pendingBytes > 0 || currentOffset === 0) {
        const combined = pendingChunks.length === 0
          ? Buffer.alloc(0)
          : pendingChunks.length === 1
            ? pendingChunks[0]
            : Buffer.concat(pendingChunks);
        await sendChunk(combined, currentOffset, currentOffset === 0, true);
      }

      return { success: true };
    } catch (err: any) {
      if (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
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
