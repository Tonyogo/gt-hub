import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import request from 'supertest';
import { TaskManager } from '../src/agent/tasks/taskManager';
import { compressionMiddleware } from '../src/server/middlewares/compressionMiddleware';
import {
  BIN_MSG_TYPE,
  decodeBinaryJsonBufferPacket,
  encodeBinaryJsonBufferPacket,
} from '../src/shared/protocol/binaryProtocol';
import {
  DEFAULT_UPLOAD_CONCURRENCY,
  TerminalFileService,
  passthroughOrGzipAgentChunkAsync,
} from '../src/terminal/services/terminalFileService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import {
  getNextCronTime,
  isValidTimezone,
  parseCronExpression,
} from '../src/shared/utils/cronParser';
import logger from '../src/utils/logger';
import {
  parseAnsiToSegments,
  parseAnsiToSegmentsWithState,
} from '../frontend/src/utils/ansiLogFormatter';
import { sanitizeMarkdownHtml } from '../frontend/src/utils/markdownRenderer';

describe('Performance Optimizations Phase 1-3 Verification', () => {
  describe('Phase 1: TaskManager chunk buffer & includeFinishOutput controls', () => {
    let tmpDir: string;
    let manager: TaskManager;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tm-perf-'));
      manager = new TaskManager({ storageDir: tmpDir, persist: true });
    });

    afterEach(async () => {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('bounds memory for >5MB output while omitting cmd_task_finished output when includeFinishOutput=false', async () => {
      let finishedEvent: any = null;
      const done = new Promise<void>((resolve) => {
        const startRes = manager.startTask({
          taskId: 'perf-large-omit',
          command: `node -e "process.stdout.write('A'.repeat(5500000), () => process.exit(0))"`,
          includeFinishOutput: false,
          onFinish: (ev) => {
            finishedEvent = ev;
            resolve();
          },
        });
        expect(startRes.success).toBe(true);
      });

      await done;
      expect(finishedEvent).toBeTruthy();
      expect(finishedEvent.status).toBe('completed');
      expect(finishedEvent.exitCode).toBe(0);
      expect(finishedEvent.output).toBe('');
      expect(finishedEvent.stdout).toBe('');
      expect(finishedEvent.stderr).toBe('');

      const snapshot = manager.getTask('perf-large-omit', 0);
      expect(snapshot.success).toBe(true);
      expect(snapshot.status).toBe('completed');
      expect(snapshot.output.length).toBeGreaterThan(4 * 1024 * 1024);
      expect(snapshot.output.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    });

    it('truncates finish callback output to finishMaxOutputBytes without truncating task memory log', async () => {
      let finishedEvent: any = null;
      const done = new Promise<void>((resolve) => {
        const startRes = manager.startTask({
          taskId: 'perf-cap-callback',
          command: `node -e "process.stdout.write('0123456789'.repeat(500))"`,
          includeFinishOutput: true,
          finishMaxOutputBytes: 64,
          onFinish: (ev) => {
            finishedEvent = ev;
            resolve();
          },
        });
        expect(startRes.success).toBe(true);
      });

      await done;
      expect(finishedEvent.status).toBe('completed');
      expect(Buffer.byteLength(finishedEvent.output, 'utf8')).toBeLessThanOrEqual(64);
      expect(finishedEvent.output.length).toBeGreaterThan(0);

      const snapshot = manager.getTask('perf-cap-callback', 0);
      expect(snapshot.output.length).toBe(5000);
    });
  });

  describe('Phase 1: compressionMiddleware async gzip & fast-path skips', () => {
    const app = express();
    app.use(compressionMiddleware);
    app.get('/small-json', (_req, res) => {
      res.json({ ok: true, msg: 'tiny' });
    });
    app.get('/large-json', (_req, res) => {
      res.json({ ok: true, data: 'CompressiblePayload-'.repeat(120) });
    });
    app.get('/large-text', (_req, res) => {
      res.type('text/plain').send('TextLine\n'.repeat(200));
    });
    app.get('/large-binary', (_req, res) => {
      res.type('application/octet-stream').send(Buffer.alloc(2048, 0xaa));
    });

    it('skips gzip for <1KB JSON and compresses >=1KB JSON/text asynchronously', async () => {
      const smallRes = await request(app)
        .get('/small-json')
        .set('Accept-Encoding', 'gzip');
      expect(smallRes.status).toBe(200);
      expect(smallRes.headers['content-encoding']).toBeUndefined();
      expect(smallRes.body).toEqual({ ok: true, msg: 'tiny' });

      const largeJsonRes = await request(app)
        .get('/large-json')
        .set('Accept-Encoding', 'gzip');
      expect(largeJsonRes.status).toBe(200);
      expect(largeJsonRes.headers['content-encoding']).toBe('gzip');
      expect(largeJsonRes.body.ok).toBe(true);
      expect(largeJsonRes.body.data).toHaveLength('CompressiblePayload-'.repeat(120).length);

      const largeTextRes = await request(app)
        .get('/large-text')
        .set('Accept-Encoding', 'gzip');
      expect(largeTextRes.status).toBe(200);
      expect(largeTextRes.headers['content-encoding']).toBe('gzip');
      expect(largeTextRes.text).toBe('TextLine\n'.repeat(200));

      const binRes = await request(app)
        .get('/large-binary')
        .set('Accept-Encoding', 'gzip');
      expect(binRes.status).toBe(200);
      expect(binRes.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('Phase 2: Binary file chunk framing, RFC1952 passthrough & concurrent upload', () => {
    it('roundtrips FILE_CHUNK_REQ and FILE_CHUNK_RES binary JSON+Buffer frames', () => {
      const raw = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
      const encodedReq = encodeBinaryJsonBufferPacket(
        BIN_MSG_TYPE.FILE_CHUNK_REQ,
        'req-1',
        { action: 'upload_chunk', path: '/tmp/test.bin', offset: 0, truncate: true },
        raw
      );
      const decodedReq = decodeBinaryJsonBufferPacket(encodedReq);
      expect(decodedReq).toBeTruthy();
      expect(decodedReq!.msgType).toBe(BIN_MSG_TYPE.FILE_CHUNK_REQ);
      expect(decodedReq!.id).toBe('req-1');
      expect(decodedReq!.meta.action).toBe('upload_chunk');
      expect(decodedReq!.meta.truncate).toBe(true);
      expect(Buffer.compare(decodedReq!.rawData, raw)).toBe(0);

      const encodedRes = encodeBinaryJsonBufferPacket(
        BIN_MSG_TYPE.FILE_CHUNK_RES,
        'req-1',
        { success: true, data: { encoding: 'gzip' } },
        raw
      );
      const decodedRes = decodeBinaryJsonBufferPacket(encodedRes);
      expect(decodedRes).toBeTruthy();
      expect(decodedRes!.msgType).toBe(BIN_MSG_TYPE.FILE_CHUNK_RES);
      expect(decodedRes!.meta.success).toBe(true);
      expect(Buffer.compare(decodedRes!.rawData, raw)).toBe(0);
    });

    it('passes through pre-gzipped agent chunk Buffer directly without double-compressing', async () => {
      const original = Buffer.from('RepeatLine-'.repeat(300), 'utf8');
      const preGzipped = zlib.gzipSync(original, { level: zlib.constants.Z_BEST_SPEED });

      const passthrough = await passthroughOrGzipAgentChunkAsync({
        rawBuffer: preGzipped,
        encoding: 'gzip',
      });
      expect(passthrough).toBe(preGzipped);

      const compressed = await passthroughOrGzipAgentChunkAsync({
        rawBuffer: original,
      });
      expect(zlib.gunzipSync(compressed).equals(original)).toBe(true);
    });

    it('uploads multi-chunk Buffer via concurrent binary FILE_CHUNK_REQ frames after chunk 0 truncate', async () => {
      expect(DEFAULT_UPLOAD_CONCURRENCY).toBe(4);
      const fileService = new TerminalFileService();
      const hostId = 'perf-upload-binary-node';
      const totalSize = 1100 * 1024; // ~1.1MB -> 3 chunks (512KB, 512KB, ~76KB)
      const payload = Buffer.alloc(totalSize);
      for (let i = 0; i < totalSize; i += 1024) {
        payload.writeUInt32BE(i, i);
      }

      const receivedChunks: Array<{ truncate: boolean; offset: number; isLast: boolean; size: number }> = [];
      let inFlight = 0;
      let maxConcurrent = 0;

      const mockWs: any = {
        readyState: 1,
        _binaryFile: true,
        send: jest.fn((packet: Buffer | string) => {
          if (Buffer.isBuffer(packet)) {
            const decoded = decodeBinaryJsonBufferPacket(packet);
            if (!decoded || decoded.msgType !== BIN_MSG_TYPE.FILE_CHUNK_REQ) return;
            const reqId = decoded.id;
            const params = decoded.meta.params || {};
            receivedChunks.push({
              truncate: Boolean(params.truncate),
              offset: Number(params.offset ?? 0),
              isLast: Boolean(params.isLast),
              size: decoded.rawData.length,
            });
            inFlight += 1;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            setTimeout(() => {
              inFlight -= 1;
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
                data: { success: true, bytesWritten: decoded.rawData.length },
              });
            }, params.truncate ? 5 : 20);
          }
        }),
      };

      terminalHostManager.registerAgent({
        hostId,
        name: 'BinaryUploadNode',
        agentWs: mockWs,
      });

      try {
        const result = await fileService.saveUploadedFile(hostId, '/tmp', 'big.bin', payload);
        expect(result.success).toBe(true);
        expect(receivedChunks.length).toBe(3);
        expect(receivedChunks[0].truncate).toBe(true);
        expect(receivedChunks[0].offset).toBe(0);
        expect(receivedChunks[0].isLast).toBe(false);
        expect(receivedChunks[1].truncate).toBe(false);
        expect(receivedChunks[2].truncate).toBe(false);
        expect(receivedChunks[2].isLast).toBe(true);
        expect(maxConcurrent).toBeGreaterThanOrEqual(2);
        const totalUploaded = receivedChunks.reduce((sum, c) => sum + c.size, 0);
        expect(totalUploaded).toBe(totalSize);
      } finally {
        terminalHostManager.unregisterAgent(hostId);
      }
    });
  });

  describe('Phase 3: Intl.DateTimeFormat & cron parser caches + frontend incremental ANSI/markdown', () => {
    it('caches ParsedCron and Intl.DateTimeFormat instances across logger and cronParser calls', () => {
      const p1 = parseCronExpression('*/10 9-17 * * 1-5');
      const p2 = parseCronExpression('  */10 9-17 * * 1-5  ');
      expect(p1).toBe(p2);

      const tz = 'Pacific/Auckland';
      // Warm up both logger and target timezone once, then assert subsequent calls construct 0 formatters
      logger.info('warmup log timestamp formatter');
      expect(isValidTimezone(tz)).toBe(true);
      const base = new Date('2026-06-15T12:00:00Z');
      const t1 = getNextCronTime('0 */2 * * *', base, tz);

      const spy = jest.spyOn(Intl, 'DateTimeFormat');
      try {
        expect(isValidTimezone(tz)).toBe(true);
        const t2 = getNextCronTime('0 */2 * * *', base, tz);
        expect(t2.getTime()).toBe(t1.getTime());
        logger.info('cached log call 1');
        logger.info('cached log call 2');
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('parses ANSI log chunks incrementally across style boundaries matching one-shot output', () => {
      const chunk1 = '\x1b[32;1m[OK] first ';
      const chunk2 = 'part\x1b[0m plain text\x1b[31m error';
      const chunk3 = ' tail\x1b[0m';

      const r1 = parseAnsiToSegmentsWithState(chunk1);
      const r2 = parseAnsiToSegmentsWithState(chunk2, r1.endState);
      const r3 = parseAnsiToSegmentsWithState(chunk3, r2.endState);
      const incrementalCombined = [...r1.segments, ...r2.segments, ...r3.segments];

      const full = parseAnsiToSegments(chunk1 + chunk2 + chunk3);
      expect(incrementalCombined.map((s) => s.text).join('')).toBe(full.map((s) => s.text).join(''));
      expect(r2.segments[0]).toEqual({ text: 'part', colorClass: 'text-emerald-400', bold: true });
      expect(r3.segments[0]).toEqual({ text: ' tail', colorClass: 'text-rose-400', bold: false });
      expect(r3.endState).toEqual({ colorClass: undefined, bold: false });
    });

    it('sanitizes unsafe HTML vectors while retaining safe tags in sanitizeMarkdownHtml', () => {
      const input = '<h2>Docs</h2><script>alert(1)</script><p><a href="javascript:evil()" onclick="steal()">link</a></p>';
      const clean = sanitizeMarkdownHtml(input);
      expect(clean).toContain('<h2>Docs</h2>');
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('onclick');
      expect(clean).not.toContain('javascript:');
    });
  });
});
