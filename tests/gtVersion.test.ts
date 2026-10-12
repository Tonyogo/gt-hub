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
    const { generateVersionData } = require('../scripts/generate-version');
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
});
