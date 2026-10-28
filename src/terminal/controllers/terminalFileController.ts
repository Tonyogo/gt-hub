import { Request, Response } from 'express';
import path from 'path';
import zlib from 'zlib';
import { PassThrough } from 'stream';
import terminalFileService from '../services/terminalFileService';
import logger from '../../utils/logger';
import { parseRangeHeader, applyRangeHeaders, applyUnsatisfiableHeaders } from '../utils/rangeParser';
import { isAlreadyCompressedExtension } from '../../agent/handlers/fileRpcHandler';

function isCompressibleFile(filename: string): boolean {
  return !isAlreadyCompressedExtension(filename);
}

async function parseAndUploadMultipart(
  source: NodeJS.ReadableStream,
  boundary: string,
  hostId: string,
  targetDir: string
): Promise<{ success: boolean; uploaded?: string[]; error?: string }> {
  const delimiter = Buffer.from(`--${boundary}`);
  const crlfCrlf = Buffer.from('\r\n\r\n');
  const uploaded: string[] = [];

  let state: 'WAIT_DELIMITER' | 'READ_HEADER' | 'READ_BODY' | 'SKIP_BODY' = 'WAIT_DELIMITER';
  let buffer = Buffer.alloc(0);
  let currentFileStream: PassThrough | null = null;
  let currentSavePromise: Promise<{ success: boolean; error?: string }> | null = null;
  let currentFilename = '';
  let saveError: string | undefined = undefined;
  let closedGracefully = false;

  const writeToFileStream = async (data: Buffer): Promise<boolean> => {
    if (!currentFileStream || data.length === 0) return true;
    if (saveError) return false;
    const ok = currentFileStream.write(data);
    if (!ok) {
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          currentFileStream?.removeListener('error', onError);
          resolve();
        };
        const onError = () => {
          currentFileStream?.removeListener('drain', onDrain);
          resolve();
        };
        currentFileStream?.once('drain', onDrain);
        currentFileStream?.once('error', onError);
      });
    }
    return !saveError;
  };

  try {
    for await (const chunk of source) {
      if (saveError) {
        currentFileStream?.destroy();
        return { success: false, error: saveError };
      }

      const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, chunkBuf]);

      const keepProcessing = true;
      while (keepProcessing) {
        if (saveError) {
          currentFileStream?.destroy();
          return { success: false, error: saveError };
        }

        if (state === 'WAIT_DELIMITER') {
          const idx = buffer.indexOf(delimiter);
          if (idx === -1) {
            if (buffer.length > delimiter.length + 4) {
              buffer = buffer.slice(buffer.length - (delimiter.length + 4));
            }
            break;
          }
          const after = idx + delimiter.length;
          if (buffer.length < after + 2) {
            if (idx > 0) {
              buffer = buffer.slice(idx);
            }
            break;
          }
          if (buffer[after] === 45 && buffer[after + 1] === 45) {
            closedGracefully = true;
            return { success: true, uploaded };
          }
          let skip = 0;
          if (buffer[after] === 13 && buffer[after + 1] === 10) {
            skip = 2;
          } else if (buffer[after] === 10) {
            skip = 1;
          }
          buffer = buffer.slice(after + skip);
          state = 'READ_HEADER';
        }

        if (state === 'READ_HEADER') {
          const headerEnd = buffer.indexOf(crlfCrlf);
          if (headerEnd === -1) {
            break;
          }
          const headerText = buffer.slice(0, headerEnd).toString('utf-8');
          buffer = buffer.slice(headerEnd + 4);

          const filenameMatch = /filename="?([^"\r\n]+)"?/i.exec(headerText);
          if (filenameMatch) {
            currentFilename = path.basename(filenameMatch[1].trim());
            currentFileStream = new PassThrough();
            currentSavePromise = terminalFileService
              .saveUploadedStream(hostId, targetDir, currentFilename, currentFileStream)
              .then((res) => {
                if (!res.success) {
                  saveError = res.error || `Failed to save ${currentFilename}`;
                }
                return res;
              })
              .catch((err) => {
                saveError = err?.message || `Failed to save ${currentFilename}`;
                return { success: false, error: saveError };
              });
            state = 'READ_BODY';
          } else {
            state = 'SKIP_BODY';
          }
        }

        if (state === 'READ_BODY') {
          const delimIdx = buffer.indexOf(delimiter);
          if (delimIdx === -1) {
            const safeLen = buffer.length - (delimiter.length + 4);
            if (safeLen > 0) {
              const ok = await writeToFileStream(buffer.slice(0, safeLen));
              if (!ok || saveError) {
                currentFileStream?.destroy();
                return { success: false, error: saveError || 'Stream write failed' };
              }
              buffer = buffer.slice(safeLen);
            }
            break;
          } else {
            const after = delimIdx + delimiter.length;
            if (buffer.length < after + 2) {
              let bodyEnd = delimIdx;
              if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) {
                bodyEnd -= 2;
              } else if (bodyEnd >= 1 && buffer[bodyEnd - 1] === 10) {
                bodyEnd -= 1;
              }
              if (bodyEnd > 0) {
                const ok = await writeToFileStream(buffer.slice(0, bodyEnd));
                if (!ok || saveError) {
                  currentFileStream?.destroy();
                  return { success: false, error: saveError || 'Stream write failed' };
                }
              }
              buffer = buffer.slice(delimIdx);
              break;
            }

            let bodyEnd = delimIdx;
            if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) {
              bodyEnd -= 2;
            } else if (bodyEnd >= 1 && buffer[bodyEnd - 1] === 10) {
              bodyEnd -= 1;
            }
            if (bodyEnd > 0) {
              await writeToFileStream(buffer.slice(0, bodyEnd));
            }
            currentFileStream?.end();

            if (currentSavePromise) {
              const saveRes = await currentSavePromise;
              if (!saveRes.success) {
                return { success: false, error: saveRes.error || `Failed to save ${currentFilename}` };
              }
              uploaded.push(currentFilename);
              currentSavePromise = null;
              currentFileStream = null;
            }

            if (buffer[after] === 45 && buffer[after + 1] === 45) {
              closedGracefully = true;
              return { success: true, uploaded };
            }

            let skip = 0;
            if (buffer[after] === 13 && buffer[after + 1] === 10) {
              skip = 2;
            } else if (buffer[after] === 10) {
              skip = 1;
            }
            buffer = buffer.slice(after + skip);
            state = 'READ_HEADER';
          }
        }

        if (state === 'SKIP_BODY') {
          const delimIdx = buffer.indexOf(delimiter);
          if (delimIdx === -1) {
            if (buffer.length > delimiter.length + 4) {
              buffer = buffer.slice(buffer.length - (delimiter.length + 4));
            }
            break;
          }
          const after = delimIdx + delimiter.length;
          if (buffer.length < after + 2) {
            buffer = buffer.slice(delimIdx);
            break;
          }
          if (buffer[after] === 45 && buffer[after + 1] === 45) {
            closedGracefully = true;
            return { success: true, uploaded };
          }
          let skip = 0;
          if (buffer[after] === 13 && buffer[after + 1] === 10) {
            skip = 2;
          } else if (buffer[after] === 10) {
            skip = 1;
          }
          buffer = buffer.slice(after + skip);
          state = 'READ_HEADER';
        }
      }
    }
  } catch (err: any) {
    currentFileStream?.destroy(err);
    return { success: false, error: err?.message || 'Multipart stream read error' };
  }

  if (currentFileStream) {
    currentFileStream.destroy(new Error('Premature stream termination'));
  }

  if (!closedGracefully) {
    return {
      success: false,
      error: 'Unexpected end of multipart stream: closing boundary not found',
    };
  }

  return { success: true, uploaded };
}

class TerminalFileController {
  public async listFiles(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.query.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const targetPath = (req.query.path as string) || undefined;
      const result = await terminalFileService.listFiles(hostId, targetPath);
      if (!result.success && result.error?.includes('not found')) {
        res.status(404).json(result);
        return;
      }
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async readFileContent(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.query.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const targetPath = req.query.path as string;
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'path query parameter is required' });
        return;
      }
      const result = await terminalFileService.readFileContent(hostId, targetPath);
      if (!result.success && (result.error === 'File not found' || result.error?.includes('not found'))) {
        res.status(404).json(result);
        return;
      }
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async saveFileContent(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.body.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const { path: targetPath, content = '' } = req.body;
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'path is required' });
        return;
      }
      const result = await terminalFileService.saveFileContent(hostId, targetPath, content);
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async createDirectory(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.body.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const { path: targetPath, dirName } = req.body;
      if (!targetPath || !dirName) {
        res.status(400).json({ success: false, error: 'path and dirName are required' });
        return;
      }
      const result = await terminalFileService.createDirectory(hostId, targetPath, dirName);
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async renameFile(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.body.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const { oldPath, newPath } = req.body;
      if (!oldPath || !newPath) {
        res.status(400).json({ success: false, error: 'oldPath and newPath are required' });
        return;
      }
      const result = await terminalFileService.renameFile(hostId, oldPath, newPath);
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async deleteItem(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.query.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const targetPath = req.query.path as string;
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'path query parameter is required' });
        return;
      }
      const result = await terminalFileService.deleteItem(hostId, targetPath);
      res.status(result.success ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  public async downloadFile(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.query.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const targetPath = req.query.path as string;
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'path query parameter is required' });
        return;
      }

      // Disable request/response timeouts for streaming large files
      req.setTimeout(0);
      res.setTimeout(0);

      const rangeHeader = req.headers.range;

      // Handle Range request if Range header is present
      if (rangeHeader) {
        const statRes = await terminalFileService.getFileStat(hostId, targetPath);
        if (!statRes.success || typeof statRes.size !== 'number') {
          const isNotFound = statRes.error && (statRes.error.toLowerCase().includes('not found') || statRes.error.toLowerCase().includes('no such file'));
          res.status(isNotFound ? 404 : 500).json({ success: false, error: statRes.error || 'Failed to stat file' });
          return;
        }

        const totalSize = statRes.size;
        const parsed = parseRangeHeader(rangeHeader, totalSize);

        if (parsed?.status === 'unsatisfiable') {
          applyUnsatisfiableHeaders(res, totalSize);
          res.end();
          return;
        }

        if (parsed?.status === 'valid') {
          const sliceResult = await terminalFileService.getFileStream(hostId, targetPath, {
            offset: parsed.range.start,
            length: parsed.range.length,
          });

          if (sliceResult.status === 200 && sliceResult.stream) {
            res.type(sliceResult.filename);
            applyRangeHeaders(res, parsed.range, sliceResult.filename);
            this.pipeStreamToResponse(sliceResult.stream, res);
            return;
          } else {
            res.status(sliceResult.status).json({ success: false, error: sliceResult.error });
            return;
          }
        }
        // If parsed is null (malformed Range header), fall through to full 200 stream as per RFC 9110
      }

      // Normal full stream download (200 OK)
      const result = await terminalFileService.getFileStream(hostId, targetPath);
      if (result.status === 200 && result.stream) {
        res.status(200);
        res.setHeader('Accept-Ranges', 'bytes');
        res.type(result.filename);

        const isInline = req.query.inline === '1' || req.query.inline === 'true';
        res.setHeader('Content-Disposition', `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(result.filename)}"`);

        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        const wantsCompress = acceptEncoding.includes('gzip') && (
          req.query.compress === '1' ||
          req.query.compress === 'true' ||
          (Boolean(req.headers['cf-ray']) && !isInline && isCompressibleFile(result.filename))
        );

        if (wantsCompress) {
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          const gzipStream = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
          result.stream.on('error', (err) => gzipStream.destroy(err));
          res.on('close', () => {
            if (!res.writableEnded && typeof (result.stream as any)?.destroy === 'function') {
              (result.stream as any).destroy();
            }
          });
          this.pipeStreamToResponse(gzipStream, res);
          result.stream.pipe(gzipStream);
          return;
        }

        const totalLength = result.totalSize !== undefined ? result.totalSize : result.size;
        if (totalLength !== undefined) {
          res.setHeader('Content-Length', totalLength);
        }
        this.pipeStreamToResponse(result.stream, res);
      } else {
        res.status(result.status).json({ success: false, error: result.error });
      }
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  private pipeStreamToResponse(stream: NodeJS.ReadableStream, res: Response): void {
    let isStreamDestroyed = false;
    const safeDestroy = (err?: Error) => {
      if (isStreamDestroyed) return;
      isStreamDestroyed = true;
      if (typeof (stream as any).destroy === 'function') {
        (stream as any).destroy(err);
      }
    };

    stream.on('error', (err: any) => {
      logger.error(`[TerminalFileController] Stream error during download: ${err?.message || err}`);
      safeDestroy(err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err?.message || 'Download stream error' });
      } else {
        res.destroy(err);
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        logger.info(`[TerminalFileController] Client closed connection prematurely, destroying stream`);
        safeDestroy();
      }
    });

    stream.pipe(res);
  }

  public async uploadFile(req: Request, res: Response): Promise<void> {
    try {
      const hostId = (req.query.hostId as string)?.trim();
      if (!hostId) {
        res.status(400).json({ success: false, error: 'hostId is required' });
        return;
      }
      const targetDir = (req.query.path as string) || '';
      const contentType = req.headers['content-type'] || '';

      req.setTimeout(0);
      res.setTimeout(0);

      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
        const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : '';
        if (!boundary) {
          res.status(400).json({ success: false, error: 'Multipart boundary not found' });
          return;
        }

        const result = await parseAndUploadMultipart(req, boundary, hostId, targetDir);
        if (!result.success) {
          res.status(500).json({ success: false, error: result.error || 'Failed to upload files' });
          return;
        }
        if (!result.uploaded || result.uploaded.length === 0) {
          res.status(400).json({ success: false, error: 'No files uploaded' });
          return;
        }
        res.status(200).json({ success: true, uploaded: result.uploaded });
        return;
      }

      // Direct binary stream upload with filename in header
      const rawHeaderFilename = req.headers['x-filename'] as string | undefined;
      let decodedFilename: string | undefined = undefined;
      if (rawHeaderFilename) {
        try {
          decodedFilename = decodeURIComponent(rawHeaderFilename);
        } catch {
          decodedFilename = rawHeaderFilename;
        }
      }
      const safeFilename = decodedFilename ? path.basename(decodedFilename.trim()) : '';
      const filename = (safeFilename && safeFilename !== '.' && safeFilename !== '..')
        ? safeFilename
        : `upload-${Date.now()}`;
      const saveRes = await terminalFileService.saveUploadedStream(hostId, targetDir, filename, req);
      res.status(saveRes.success ? 200 : 500).json(saveRes);
    } catch (err: any) {
      logger.error(`[TerminalFileController] upload processing error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

export const terminalFileController = new TerminalFileController();
export default terminalFileController;
