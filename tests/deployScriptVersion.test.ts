import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Deploy Script & Git Describe Version Derivation', () => {
  let tmpRepoDir: string;
  let initialCommit: string;

  beforeAll(() => {
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deploy-test-'));
    execSync('git init', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: tmpRepoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpRepoDir, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tmpRepoDir, 'init.txt'), 'initial');
    execSync('git add .', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: tmpRepoDir, stdio: 'ignore' });
    initialCommit = execSync('git rev-parse HEAD', { cwd: tmpRepoDir }).toString().trim();
  });

  afterAll(() => {
    try {
      if (tmpRepoDir && fs.existsSync(tmpRepoDir)) {
        fs.rmSync(tmpRepoDir, { recursive: true, force: true });
      }
    } catch {}
  });

  beforeEach(() => {
    // Reset repository back to initial commit and remove all tags for test isolation
    execSync(`git reset --hard ${initialCommit}`, { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git clean -fd', { cwd: tmpRepoDir, stdio: 'ignore' });
    const tagOutput = execSync('git tag', { cwd: tmpRepoDir }).toString().trim();
    if (tagOutput) {
      const tags = tagOutput.split(/\s+/).filter(Boolean);
      for (const tag of tags) {
        execSync(`git tag -d "${tag}"`, { cwd: tmpRepoDir, stdio: 'ignore' });
      }
    }
  });

  const buildGtPath = path.resolve(__dirname, '../scripts/build-gt.js');

  // Executes the exact bash version derivation snippet used in scripts/deploy.sh
  function runDeployScriptVersionSnippet(cwd: string, baseVersion = '1.0.0'): string {
    const script = `
      GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
      GIT_DESCRIBE=$(git describe --tags --always 2>/dev/null || echo "\${GIT_COMMIT}")
      TARGET_VERSION=$(node "${buildGtPath}" --version-only --silent --root . 2>/dev/null && node -p "require('./src/shared/version.json').version" 2>/dev/null || true)
      if [ -z "$TARGET_VERSION" ]; then
        BASE_VERSION="${baseVersion}"
        if [[ "$GIT_DESCRIBE" =~ ^v?[0-9]+\\.[0-9]+(\\.[0-9]+)?$ ]]; then
          TARGET_VERSION="\${GIT_DESCRIBE#v}"
        else
          TARGET_VERSION="\${BASE_VERSION}+\${GIT_COMMIT}"
        fi
      fi
      echo "$TARGET_VERSION"
    `;
    return execSync(script, { cwd, shell: '/bin/bash' }).toString().trim();
  }

  // TypeScript equivalent of the version derivation logic
  function resolveDeployVersion(describeOut: string, commitHash: string, baseVersion = '1.0.0'): string {
    if (/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(describeOut)) {
      return describeOut.replace(/^v/, '');
    } else {
      return `${baseVersion}+${commitHash}`;
    }
  }

  it('derives clean version without suffix on tagged commit (v1.0.1)', () => {
    execSync('git tag v1.0.1', { cwd: tmpRepoDir, stdio: 'ignore' });
    const describeOut = execSync('git describe --tags --always', {
      cwd: tmpRepoDir,
    }).toString().trim();
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: tmpRepoDir,
    }).toString().trim();

    expect(describeOut).toBe('v1.0.1');

    const targetVersion = resolveDeployVersion(describeOut, commitHash);
    expect(targetVersion).toBe('1.0.1');
    expect(targetVersion.includes('+')).toBe(false);

    const scriptVersion = runDeployScriptVersionSnippet(tmpRepoDir);
    expect(scriptVersion).toBe('1.0.1');
  });

  it('derives clean version without suffix on tagged commit without leading v (1.0.1)', () => {
    execSync('git tag 1.0.1', { cwd: tmpRepoDir, stdio: 'ignore' });
    const describeOut = execSync('git describe --tags --always', {
      cwd: tmpRepoDir,
    }).toString().trim();
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: tmpRepoDir,
    }).toString().trim();

    expect(describeOut).toBe('1.0.1');

    const targetVersion = resolveDeployVersion(describeOut, commitHash);
    expect(targetVersion).toBe('1.0.1');
    expect(targetVersion.includes('+')).toBe(false);

    const scriptVersion = runDeployScriptVersionSnippet(tmpRepoDir);
    expect(scriptVersion).toBe('1.0.1');
  });

  it('derives clean version without suffix on 2-segment tagged commit (v1.0)', () => {
    execSync('git tag v1.0', { cwd: tmpRepoDir, stdio: 'ignore' });
    const describeOut = execSync('git describe --tags --always', {
      cwd: tmpRepoDir,
    }).toString().trim();
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: tmpRepoDir,
    }).toString().trim();

    expect(describeOut).toBe('v1.0');

    const targetVersion = resolveDeployVersion(describeOut, commitHash);
    expect(targetVersion).toBe('1.0');
    expect(targetVersion.includes('+')).toBe(false);

    const scriptVersion = runDeployScriptVersionSnippet(tmpRepoDir);
    expect(scriptVersion).toBe('1.0');
  });

  it('derives version with commit suffix on untagged commit', () => {
    const describeOut = execSync('git describe --tags --always', {
      cwd: tmpRepoDir,
    }).toString().trim();
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: tmpRepoDir,
    }).toString().trim();

    expect(describeOut).toBe(commitHash);

    const targetVersion = resolveDeployVersion(describeOut, commitHash);
    expect(targetVersion).toBe(`1.0.0+${commitHash}`);
    expect(targetVersion.includes('+')).toBe(true);

    const scriptVersion = runDeployScriptVersionSnippet(tmpRepoDir);
    expect(scriptVersion).toBe(`1.0.0+${commitHash}`);
  });

  it('derives version with commit suffix when commits exist after tag (e.g. v1.0.1-1-g...)', () => {
    execSync('git tag v1.0.1', { cwd: tmpRepoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpRepoDir, 'second.txt'), 'second');
    execSync('git add second.txt', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git commit -m "second commit"', { cwd: tmpRepoDir, stdio: 'ignore' });

    const describeOut = execSync('git describe --tags --always', {
      cwd: tmpRepoDir,
    }).toString().trim();
    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: tmpRepoDir,
    }).toString().trim();

    expect(describeOut).toMatch(/^v1\.0\.1-\d+-g[0-9a-f]+$/);

    // scripts/deploy.sh uses ${BASE_VERSION}+${GIT_COMMIT} when not directly on a clean tag
    const targetVersion = resolveDeployVersion(describeOut, commitHash);
    expect(targetVersion).toBe(`1.0.0+${commitHash}`);
    expect(targetVersion.includes('+')).toBe(true);

    const scriptVersion = runDeployScriptVersionSnippet(tmpRepoDir);
    expect(scriptVersion).toBe(`1.0.0+${commitHash}`);
  });

  it('handles fallback when git describe output is invalid or empty', () => {
    expect(resolveDeployVersion('', 'abc1234')).toBe('1.0.0+abc1234');
    expect(resolveDeployVersion('unknown', 'unknown')).toBe('1.0.0+unknown');
  });
});
