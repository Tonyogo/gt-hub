import { getVersionInfo, formatShortVersion, VersionInfo } from '../src/shared/version';
import pkg from '../package.json';

describe('Version Metadata Resolver', () => {
  it('returns valid VersionInfo with package version in fallback/dev mode', () => {
    const info = getVersionInfo();
    expect(info).toBeDefined();
    expect(info.version).toBe(pkg.version);
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
});
