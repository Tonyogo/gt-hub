import path from 'path';

export interface VersionInfo {
  version: string;
  gitCommit: string;
  buildTime: string;
  platform: string;
}

declare const __GT_VERSION__: string | undefined;
declare const __GT_GIT_COMMIT__: string | undefined;
declare const __GT_BUILD_TIME__: string | undefined;

export function getVersionInfo(): VersionInfo {
  let version: string;
  let gitCommit: string;
  let buildTime: string;

  if (typeof __GT_VERSION__ !== 'undefined') {
    version = __GT_VERSION__;
  } else {
    try {
      // Fallback for unbundled/dev/test execution
      let pkg: any;
      try {
        pkg = require(path.join(__dirname, '../../package.json'));
      } catch {
        try {
          pkg = require(path.join(__dirname, '../../../package.json'));
        } catch {
          pkg = require(path.join(process.cwd(), 'package.json'));
        }
      }
      version = pkg.version || '0.0.0';
    } catch {
      version = '0.0.0';
    }
  }

  if (typeof __GT_GIT_COMMIT__ !== 'undefined') {
    gitCommit = __GT_GIT_COMMIT__;
  } else {
    gitCommit = 'dev';
  }

  if (typeof __GT_BUILD_TIME__ !== 'undefined') {
    buildTime = __GT_BUILD_TIME__;
  } else {
    buildTime = new Date().toISOString();
  }

  const platform = `${process.platform}/${process.arch}`;

  return {
    version,
    gitCommit,
    buildTime,
    platform,
  };
}

export function formatShortVersion(info: VersionInfo = getVersionInfo()): string {
  return `gt version ${info.version} (commit: ${info.gitCommit}, built: ${info.buildTime}, ${info.platform})`;
}
