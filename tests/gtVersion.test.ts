import { getVersionInfo, formatShortVersion, VersionInfo } from '../src/shared/version';
import pkg from '../package.json';

describe('Version Metadata Resolver', () => {
  it('returns valid VersionInfo with package version in fallback/dev mode', () => {
    const info = getVersionInfo();
    expect(info).toBeDefined();
    expect(info.version.startsWith(pkg.version)).toBe(true);
    expect(typeof info.gitCommit).toBe('string');
    expect(typeof info.buildTime).toBe('string');
    expect(info.platform).toBe(`${process.platform}/${process.arch}`);
  });

  it('formats short version line correctly', () => {
    const mockInfo: VersionInfo = {
      version: '1.2.3',
      gitCommit: 'abcdef1',
      buildTime: '2026-10-10T12:00:00Z',
      platform: 'linux/x64',
    };
    const line = formatShortVersion(mockInfo);
    expect(line).toBe('gt version 1.2.3 (commit: abcdef1, built: 2026-10-10T12:00:00Z, linux/x64)');
  });

  it('generates unified version data using generateVersionData()', () => {
    const { generateVersionData } = require('../scripts/build-gt');
    const data = generateVersionData();
    expect(data).toBeDefined();
    expect(typeof data.version).toBe('string');
    expect(data.rawVersion).toBe(pkg.version);
    expect(typeof data.gitCommit).toBe('string');
    expect(typeof data.buildTime).toBe('string');
    // If on a tagged release, version should not contain + suffix; otherwise semver+hash
    if (data.gitDescribe && /^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(data.gitDescribe)) {
      expect(data.version.includes('+')).toBe(false);
      expect(data.version).toBe(data.gitDescribe.replace(/^v/, ''));
    } else if (data.gitCommit && data.gitCommit !== 'unknown') {
      expect(data.version).toBe(`${pkg.version}+${data.gitCommit}`);
      expect(data.version.includes('+')).toBe(true);
    }
  });

  it('exports buildGt and helper functions from scripts/build-gt', () => {
    const { buildGt, getGitCommit, getCommitCount, getGitDescribe } = require('../scripts/build-gt');
    expect(typeof buildGt).toBe('function');
    expect(typeof getGitCommit).toBe('function');
    expect(typeof getCommitCount).toBe('function');
    expect(typeof getGitDescribe).toBe('function');
  });

  it('supports generateVersionData with writeFiles: false', () => {
    const { generateVersionData } = require('../scripts/build-gt');
    const data = generateVersionData({ writeFiles: false });
    expect(data).toBeDefined();
    expect(typeof data.version).toBe('string');
    expect(data.rawVersion).toBe(pkg.version);
  });

  it('resolves git metadata even when executed from a foreign cwd', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const os = require('os');
    const scriptPath = path.resolve(__dirname, '../scripts/build-gt.js');
    const output = execSync(`node "${scriptPath}" --version-only`, {
      cwd: os.tmpdir(),
    }).toString();
    expect(output).toContain('[version] Generated src/shared/version.json:');
    // Git commit should NOT be 'unknown' when resolving from repo root
    expect(output).not.toContain('(unknown)');
  });

  it('displays usage and exits 0 on --help', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const output = execSync('node scripts/build-gt.js --help', {
      cwd: path.resolve(__dirname, '..'),
    }).toString();
    expect(output).toContain('Usage: node scripts/build-gt.js');
    expect(output).toContain('--version-only');
    expect(output).toContain('--silent');
  });

  it('suppresses output when --silent flag is provided with --version-only', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const output = execSync('node scripts/build-gt.js --version-only --silent', {
      cwd: path.resolve(__dirname, '..'),
    }).toString();
    expect(output.trim()).toBe('');
  });

  it('buildGt builds bundle and accepts custom options', () => {
    const { buildGt } = require('../scripts/build-gt');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const tmpOut = path.join(os.tmpdir(), `gt-test-bundle-${Date.now()}.js`);

    try {
      const result = buildGt({
        outfile: tmpOut,
        silent: true,
        esbuildOptions: {
          banner: {
            js: '// custom-gt-banner-test',
          },
        },
      });

      expect(result).toBeDefined();
      expect(result.outfile).toBe(tmpOut);
      expect(fs.existsSync(tmpOut)).toBe(true);

      const content = fs.readFileSync(tmpOut, 'utf8');
      expect(content).toContain('// custom-gt-banner-test');
      expect(content).toContain(result.versionData.version);
    } finally {
      try {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      } catch {}
    }
  });

  it('gracefully handles git helper fallbacks in non-git directories', () => {
    const { getGitCommit, getCommitCount, getGitDescribe } = require('../scripts/build-gt');
    const os = require('os');
    const tmp = os.tmpdir();
    expect(getGitCommit(tmp)).toBe('unknown');
    expect(getCommitCount(tmp)).toBe('0');
    expect(getGitDescribe(tmp)).toBeNull();
  });

  it('executes scripts/build-gt.js with --version-only flag', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const output = execSync('node scripts/build-gt.js --version-only', {
      cwd: path.resolve(__dirname, '..'),
    }).toString();
    expect(output).toContain('[version] Generated src/shared/version.json:');
  });
});
