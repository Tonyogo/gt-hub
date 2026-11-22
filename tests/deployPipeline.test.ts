import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT_DIR = path.resolve(__dirname, '..');

describe('Deploy Pipeline Optimization - Build & Package Contracts', () => {
  it('removes postinstall and duplicate frontend installs from package.json and registers typecheck/esbuild backend', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.scripts['install:all']).toBe(
      'npm install --no-audit --no-fund && npm --prefix frontend install --no-audit --no-fund'
    );
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts['build:frontend']).not.toMatch(/^cd frontend && npm install &&/);
    expect(pkg.scripts['build:frontend']).toContain('npm --prefix frontend run build');
    expect(pkg.scripts['build:backend']).toBe('node scripts/build-gt.js --server');
    expect(pkg.scripts.build).toBe('npm run build:frontend && npm run build:backend && npm run build:gt');
    expect(pkg.scripts.deploy).toBe('bash scripts/deploy.sh');
  });

  it('buildServer bundles src/index.ts with externalized packages, valid JS syntax, and matching version info', () => {
    const buildGtModule = require('../scripts/build-gt.js');
    expect(typeof buildGtModule.buildServer).toBe('function');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-server-build-'));
    const outfile = path.join(tmpDir, 'index.js');

    try {
      const result = buildGtModule.buildServer({ outfile, silent: true });
      expect(fs.existsSync(outfile)).toBe(true);
      expect(result.versionData.version).toBeTruthy();

      execFileSync('node', ['--check', outfile]);

      const bundleContent = fs.readFileSync(outfile, 'utf8');
      expect(bundleContent).toContain('require("express")');
      expect(bundleContent).toContain('require("ws")');

      // Verify buildGt externalizes node-pty
      const gtOutfile = path.join(tmpDir, 'gt.js');
      buildGtModule.buildGt({ outfile: gtOutfile, silent: true });
      const gtContent = fs.readFileSync(gtOutfile, 'utf8');
      expect(gtContent).toContain('node-pty');

      // Verify runtime startup under NODE_ENV=test resolves express & injected version
      const probeOut = execFileSync(
        'node',
        [
          '-e',
          `const mod = require(${JSON.stringify(outfile)});
           const http = require('http');
           const server = http.createServer(mod.app);
           server.listen(0, '127.0.0.1', () => {
             const port = server.address().port;
             http.get('http://127.0.0.1:' + port + '/health', (res) => {
               let body = '';
               res.on('data', (c) => (body += c));
               res.on('end', () => {
                 console.log(body);
                 try { mod.wss && mod.wss.close(); } catch {}
                 server.close(() => process.exit(0));
               });
             });
           });`,
        ],
        {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            NODE_PATH: path.join(ROOT_DIR, 'node_modules'),
          },
          encoding: 'utf8',
        }
      ).trim();

      const health = JSON.parse(probeOut) as { status: string; version: string };
      expect(health.status).toBe('ok');
      expect(health.version).toBe(result.versionData.version);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
