import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import staticMiddleware, { createStaticMiddleware } from '../src/server/modules/static/staticMiddleware';

describe('Static Frontend Asset Compression & Cache-Control', () => {
  let tempDistDir: string;
  let app: express.Express;

  const sampleJs = 'console.log("gt-hub static bundle payload chunk");\n'.repeat(120);
  const sampleCss = '.terminal-container { background: #090d16; color: #f1f5f9; }\n'.repeat(80);
  const sampleHtml =
    '<!doctype html><html><head><title>gt-hub</title></head><body><div id="root"></div>' +
    '<!-- ' +
    'padding '.repeat(200) +
    ' --></body></html>';
  const largeJs = '/* large-stream-chunk */\n'.repeat(220 * 1024); // > 5MB streaming threshold

  beforeAll(() => {
    expect(staticMiddleware).toBeDefined();
    tempDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-static-test-'));
    fs.mkdirSync(path.join(tempDistDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tempDistDir, 'index.html'), sampleHtml, 'utf-8');
    fs.writeFileSync(path.join(tempDistDir, 'assets', 'vendor-xterm-abc123.js'), sampleJs, 'utf-8');
    fs.writeFileSync(path.join(tempDistDir, 'assets', 'index-xyz789.css'), sampleCss, 'utf-8');
    fs.writeFileSync(path.join(tempDistDir, 'assets', 'huge-chunk.js'), largeJs, 'utf-8');
    fs.writeFileSync(path.join(tempDistDir, 'assets', 'pixel.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    app = express();
    app.use(createStaticMiddleware(tempDistDir));
  });

  afterAll(() => {
    fs.rmSync(tempDistDir, { recursive: true, force: true });
  });

  it('serves /assets/*.js with gzip compression and immutable long-term Cache-Control', async () => {
    const res = await request(app)
      .get('/assets/vendor-xterm-abc123.js')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toContain('Accept-Encoding');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBeTruthy();
    expect(res.text).toBe(sampleJs);
  });

  it('serves /assets/*.css with brotli compression when br is accepted', async () => {
    const res = await request(app)
      .get('/assets/index-xyz789.css')
      .set('Accept-Encoding', 'gzip, deflate, br');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text).toBe(sampleCss);
  });

  it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const first = await request(app)
      .get('/assets/vendor-xterm-abc123.js')
      .set('Accept-Encoding', 'gzip');

    const etag = first.headers['etag'];
    expect(etag).toBeTruthy();

    const second = await request(app)
      .get('/assets/vendor-xterm-abc123.js')
      .set('Accept-Encoding', 'gzip')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('streams compressed response for oversized static assets (>4MB)', async () => {
    const res = await request(app)
      .get('/assets/huge-chunk.js')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text.length).toBe(largeJs.length);
  });

  it('serves SPA fallback index.html compressed with Cache-Control: no-cache', async () => {
    const res = await request(app)
      .get('/some/spa/route')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toBe(sampleHtml);
  });

  it('supports Range requests uncompressed and sets immutable Cache-Control on non-compressible assets', async () => {
    const rangeRes = await request(app)
      .get('/assets/vendor-xterm-abc123.js')
      .set('Accept-Encoding', 'gzip')
      .set('Range', 'bytes=0-19');

    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers['content-encoding']).toBeUndefined();
    expect(rangeRes.text).toBe(sampleJs.slice(0, 20));

    const pngRes = await request(app)
      .get('/assets/pixel.png')
      .set('Accept-Encoding', 'gzip');

    expect(pngRes.status).toBe(200);
    expect(pngRes.headers['content-encoding']).toBeUndefined();
    expect(pngRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
