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

describe('Deploy Script Incremental Plan & Contract', () => {
  const deployScriptPath = path.join(ROOT_DIR, 'scripts/deploy.sh');

  it('deploy.sh exists, has executable permissions, passes bash -n, and satisfies security/build contract', () => {
    expect(fs.existsSync(deployScriptPath)).toBe(true);
    const stat = fs.statSync(deployScriptPath);
    expect((stat.mode & 0o111) !== 0).toBe(true);

    execFileSync('bash', ['-n', deployScriptPath]);

    const content = fs.readFileSync(deployScriptPath, 'utf8');
    expect(content).toContain('ensure_pm2');
    expect(content).toContain('resolve_env_port');
    expect(content).toContain('compute_deploy_plan');
    expect(content).toContain('npm run typecheck');
    expect(content).toContain('npm run build:backend');
    expect(content).toContain('npm run build:gt');
    expect(content).toContain('ecosystem.config.js');
    expect(content).not.toContain('--ignore-scripts');
  });

  describe('resolve_env_port and compute_deploy_plan functional behavior in git repo', () => {
    let tmpRepoDir: string;
    let commitA: string;

    const runScriptFunc = (cmd: string, env: Record<string, string> = {}) => {
      const wrapped = `
        source "${deployScriptPath}"
        ${cmd}
      `;
      return execFileSync('bash', ['-c', wrapped], {
        cwd: tmpRepoDir,
        env: { ...process.env, ...env },
        encoding: 'utf8',
      }).trim();
    };

    beforeAll(() => {
      tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deploy-sh-test-'));
      execFileSync('git', ['init'], { cwd: tmpRepoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepoDir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpRepoDir });

      fs.writeFileSync(path.join(tmpRepoDir, 'package.json'), JSON.stringify({ name: 'test' }));
      fs.mkdirSync(path.join(tmpRepoDir, 'src/server'), { recursive: true });
      fs.writeFileSync(path.join(tmpRepoDir, 'src/server/app.ts'), 'console.log("init");');
      fs.mkdirSync(path.join(tmpRepoDir, 'frontend/src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRepoDir, 'frontend/package.json'), JSON.stringify({ name: 'test-front' }));
      fs.writeFileSync(path.join(tmpRepoDir, 'frontend/src/App.tsx'), 'export default () => null;');

      execFileSync('git', ['add', '.'], { cwd: tmpRepoDir });
      execFileSync('git', ['commit', '-m', 'commit A'], { cwd: tmpRepoDir });
      commitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();
    });

    afterAll(() => {
      try {
        fs.rmSync(tmpRepoDir, { recursive: true, force: true });
      } catch {}
    });

    it('resolve_env_port resolves default 8000 when .env is absent or lacks PORT, and parses custom PORT with quotes/whitespace', () => {
      expect(runScriptFunc('resolve_env_port non-existent.env')).toBe('8000');

      const envFile = path.join(tmpRepoDir, 'custom.env');
      fs.writeFileSync(envFile, '# Comment\nPORT="9123"\n');
      expect(runScriptFunc(`resolve_env_port "${envFile}"`)).toBe('9123');

      fs.writeFileSync(envFile, "PORT='9234'");
      expect(runScriptFunc(`resolve_env_port "${envFile}"`)).toBe('9234');

      fs.writeFileSync(envFile, 'PORT=  9345  # inline comment');
      expect(runScriptFunc(`resolve_env_port "${envFile}"`)).toBe('9345');

      fs.writeFileSync(envFile, 'OTHER_VAR=123');
      expect(runScriptFunc(`resolve_env_port "${envFile}"`)).toBe('8000');
    });

    it('unreachable or empty PREV_COMMIT conservatively flags all installs and frontend build', () => {
      const out = runScriptFunc('compute_deploy_plan "" "HEAD" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"');
      expect(out).toBe('0,1,1,1');

      const outNonExistent = runScriptFunc('compute_deploy_plan "0000000000000000000000000000000000000000" "HEAD" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"');
      expect(outNonExistent).toBe('0,1,1,1');
    });

    describe('with mock installed node_modules and built frontend', () => {
      beforeEach(() => {
        execFileSync('git', ['reset', '--hard', commitA], { cwd: tmpRepoDir });
        execFileSync('git', ['clean', '-fd'], { cwd: tmpRepoDir });

        // Setup mock installed bins and dist/frontend
        fs.mkdirSync(path.join(tmpRepoDir, 'node_modules/.bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpRepoDir, 'node_modules/.bin/tsc'), '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(tmpRepoDir, 'node_modules/.bin/esbuild'), '#!/bin/sh\n', { mode: 0o755 });
        fs.mkdirSync(path.join(tmpRepoDir, 'node_modules/node-pty'), { recursive: true });

        fs.mkdirSync(path.join(tmpRepoDir, 'frontend/node_modules/.bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpRepoDir, 'frontend/node_modules/.bin/vite'), '#!/bin/sh\n', { mode: 0o755 });

        fs.mkdirSync(path.join(tmpRepoDir, 'dist/frontend'), { recursive: true });
        fs.writeFileSync(path.join(tmpRepoDir, 'dist/frontend/index.html'), '<html/>');
      });

      it('skips installs and frontend build on backend-only commit when dist/frontend/index.html exists', () => {
        fs.writeFileSync(path.join(tmpRepoDir, 'src/server/app.ts'), 'console.log("backend updated");');
        execFileSync('git', ['add', 'src/server/app.ts'], { cwd: tmpRepoDir });
        execFileSync('git', ['commit', '-m', 'backend update'], { cwd: tmpRepoDir });
        const commitB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();

        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitB}" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`);
        expect(out).toBe('1,0,0,0');
      });

      it('triggers frontend build on backend-only commit if dist/frontend/index.html is missing', () => {
        fs.writeFileSync(path.join(tmpRepoDir, 'src/server/app.ts'), 'console.log("backend updated 2");');
        execFileSync('git', ['add', 'src/server/app.ts'], { cwd: tmpRepoDir });
        execFileSync('git', ['commit', '-m', 'backend update 2'], { cwd: tmpRepoDir });
        const commitB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();

        fs.rmSync(path.join(tmpRepoDir, 'dist/frontend/index.html'), { force: true });

        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitB}" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`);
        expect(out).toBe('1,0,0,1');
      });

      it('triggers frontend install and frontend build when frontend/package.json is modified', () => {
        fs.writeFileSync(path.join(tmpRepoDir, 'frontend/package.json'), JSON.stringify({ name: 'test-front', version: '1.0.1' }));
        execFileSync('git', ['add', 'frontend/package.json'], { cwd: tmpRepoDir });
        execFileSync('git', ['commit', '-m', 'update frontend package'], { cwd: tmpRepoDir });
        const commitC = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();

        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitC}" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`);
        expect(out).toBe('1,0,1,1');
      });

      it('triggers frontend build but skips install when frontend/src/App.tsx is modified', () => {
        fs.writeFileSync(path.join(tmpRepoDir, 'frontend/src/App.tsx'), 'export default () => <div>Updated</div>;');
        execFileSync('git', ['add', 'frontend/src/App.tsx'], { cwd: tmpRepoDir });
        execFileSync('git', ['commit', '-m', 'update App.tsx'], { cwd: tmpRepoDir });
        const commitD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();

        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitD}" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`);
        expect(out).toBe('1,0,0,1');
      });

      it('triggers root install but skips frontend build when root package.json is modified', () => {
        fs.writeFileSync(path.join(tmpRepoDir, 'package.json'), JSON.stringify({ name: 'test', version: '2.0.0' }));
        execFileSync('git', ['add', 'package.json'], { cwd: tmpRepoDir });
        execFileSync('git', ['commit', '-m', 'update root package'], { cwd: tmpRepoDir });
        const commitE = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();

        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitE}" && echo "$DIFF_AVAILABLE,$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`);
        expect(out).toBe('1,1,0,0');
      });

      it('FORCE_INSTALL=1 and FORCE_BUILD=1 overrides force all flags to 1', () => {
        const commitE = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepoDir, encoding: 'utf8' }).trim();
        const out = runScriptFunc(`compute_deploy_plan "${commitA}" "${commitE}" && echo "$ROOT_INSTALL_NEEDED,$FRONTEND_INSTALL_NEEDED,$FRONTEND_BUILD_NEEDED"`, {
          FORCE_INSTALL: '1',
          FORCE_BUILD: '1',
        });
        expect(out).toBe('1,1,1');
      });
    });
  });
});

describe('GitHub Actions CI/CD Workflows', () => {
  const deployYmlPath = path.join(ROOT_DIR, '.github/workflows/deploy.yml');
  const ciYmlPath = path.join(ROOT_DIR, '.github/workflows/ci.yml');

  describe('deploy.yml', () => {
    it('implements fast gt download with local fallback, proper triggers, and valid remote bash script', () => {
      expect(fs.existsSync(deployYmlPath)).toBe(true);
      const content = fs.readFileSync(deployYmlPath, 'utf8');

      // Triggers & concurrency
      expect(content).toContain('push:');
      expect(content).toContain('branches:');
      expect(content).toContain('main');
      expect(content).toContain('workflow_dispatch:');
      expect(content).toContain('group: deploy');
      expect(content).toContain('cancel-in-progress: false');

      // Env defaults
      expect(content).toContain("DEPLOY_PATH: ${{ secrets.DEPLOY_PATH || '~/gt-hub' }}");
      expect(content).toContain("TARGET_HOST: ${{ secrets.GT_HOST || 'gt-hub' }}");

      // No unconditional install step
      expect(content).not.toContain('Install dependencies & Build local gt CLI');

      // Fast-path download and verification
      expect(content).toContain('${GT_SERVER%/}/gt');
      expect(content).toContain('./gt.cjs');
      expect(content).toContain("grep -q 'gt (Gemini Terminal)' ./gt.cjs");

      // Local build fallback
      expect(content).toContain('npm install --no-audit --no-fund --prefer-offline');
      expect(content).toContain('npm run build:gt');
      expect(content).toContain('cp ./dist/gt.js ./gt.cjs');

      // Execution via node ./gt.cjs exec
      expect(content).toContain('node ./gt.cjs exec');
      expect(content).toContain('npm run deploy');

      // Remote bash script syntax check
      const bashMatch = content.match(/bash -c '([\s\S]*?)'\s*(\n|$)/);
      expect(bashMatch).toBeTruthy();
      const remoteBash = bashMatch![1];
      expect(remoteBash).toContain('npm run deploy');
      execFileSync('bash', ['-n', '-c', remoteBash]);
    });
  });

  describe('ci.yml', () => {
    it('scopes triggers to PR and workflow_dispatch, enables dual-lockfile caching, and uses single-pass installs', () => {
      expect(fs.existsSync(ciYmlPath)).toBe(true);
      const content = fs.readFileSync(ciYmlPath, 'utf8');

      // Triggers: pull_request & workflow_dispatch, NO push trigger on main
      expect(content).toContain('pull_request:');
      expect(content).toContain('workflow_dispatch:');
      expect(content).not.toMatch(/push:\s*branches:\s*-\s*main/);

      // Concurrency
      expect(content).toContain('group: ci-${{ github.ref }}');
      expect(content).toContain('cancel-in-progress: true');

      // Caching
      expect(content).toContain("cache: 'npm'");
      expect(content).toContain('package-lock.json');
      expect(content).toContain('frontend/package-lock.json');

      // Single-pass dependencies install
      expect(content).toContain('npm install --no-audit --no-fund --prefer-offline');
      expect(content).toContain('npm --prefix frontend install --no-audit --no-fund --prefer-offline');

      // Test, typecheck, build
      expect(content).toContain('npm test');
      expect(content).toContain('npm run typecheck');
      expect(content).toContain('npm run build');
    });
  });
});
