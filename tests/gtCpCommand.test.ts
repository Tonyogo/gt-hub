import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { parseCpArgs, uploadLocalFile, downloadRemoteFile, runCp } = require('../scripts/gt.js');

describe('gt parseCpArgs', () => {
  it('identifies remote source and local destination', () => {
    const res = parseCpArgs(['node-1:/var/log/app.log', './app.log']);
    expect(res.src.isRemote).toBe(true);
    expect(res.src.host).toBe('node-1');
    expect(res.src.path).toBe('/var/log/app.log');
    expect(res.dest.isRemote).toBe(false);
    expect(res.dest.path).toBe('./app.log');
  });

  it('identifies local source and remote destination', () => {
    const res = parseCpArgs(['./build.tar.gz', 'prod-srv:/opt/app/build.tar.gz']);
    expect(res.src.isRemote).toBe(false);
    expect(res.src.path).toBe('./build.tar.gz');
    expect(res.dest.isRemote).toBe(true);
    expect(res.dest.host).toBe('prod-srv');
    expect(res.dest.path).toBe('/opt/app/build.tar.gz');
  });

  it('does not treat Windows drive letters as remote hosts', () => {
    const res = parseCpArgs(['C:\\users\\test.txt', 'node-1:/tmp/test.txt']);
    expect(res.src.isRemote).toBe(false);
    expect(res.src.path).toBe('C:\\users\\test.txt');
    expect(res.dest.isRemote).toBe(true);
    expect(res.dest.host).toBe('node-1');
  });

  it('rejects copy when neither or both are remote', () => {
    expect(() => parseCpArgs(['local1', 'local2'])).toThrow(/one argument must be remote/i);
    expect(() => parseCpArgs(['h1:/a', 'h2:/b'])).toThrow(/cannot copy between two remote hosts/i);
  });
});

describe('gt cp upload and download', () => {
  let server: http.Server;
  let serverUrl: string;
  let tmpDir: string;
  let uploadedData: { path?: string; hostId?: string; body?: string } = {};

  beforeAll((done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cp-test-'));

    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || '', 'http://127.0.0.1');

      if (parsedUrl.pathname === '/api/terminal/hosts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts: [{ id: 'host-100', name: 'my-node' }] }));
        return;
      }

      if (parsedUrl.pathname === '/api/terminal/files/upload') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          uploadedData = {
            hostId: parsedUrl.searchParams.get('hostId') || undefined,
            path: parsedUrl.searchParams.get('path') || undefined,
            body,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
        return;
      }

      if (parsedUrl.pathname === '/api/terminal/files/download') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="remote.txt"',
        });
        res.end('remote file content for test');
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      done();
    });
  });

  it('uploads a local file via uploadLocalFile', async () => {
    const localFile = path.join(tmpDir, 'test-upload.txt');
    fs.writeFileSync(localFile, 'hello upload world');

    const code = await uploadLocalFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'host-100',
      localPath: localFile,
      remotePath: '/remote/dir/test-upload.txt',
    });

    expect(code).toBe(0);
    expect(uploadedData.hostId).toBe('host-100');
    expect(uploadedData.body).toContain('hello upload world');
  });

  it('downloads a remote file via downloadRemoteFile', async () => {
    const destFile = path.join(tmpDir, 'downloaded.txt');
    const code = await downloadRemoteFile({
      serverUrl,
      apiKey: 'test-key',
      hostId: 'host-100',
      remotePath: '/remote/path/remote.txt',
      localPath: destFile,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe('remote file content for test');
  });

  it('executes runCp with resolved host name', async () => {
    const destFile = path.join(tmpDir, 'cp-downloaded.txt');
    const code = await runCp(serverUrl, 'test-key', ['my-node:/remote/remote.txt', destFile]);
    expect(code).toBe(0);
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf-8')).toBe('remote file content for test');
  });
});
