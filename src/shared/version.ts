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

  // 1. Compile-time esbuild definition takes highest precedence (standalone dist/gt.js)
  if (typeof __GT_VERSION__ !== 'undefined') {
    version = __GT_VERSION__;
    gitCommit = typeof __GT_GIT_COMMIT__ !== 'undefined' ? __GT_GIT_COMMIT__ : 'dev';
    buildTime = typeof __GT_BUILD_TIME__ !== 'undefined' ? __GT_BUILD_TIME__ : new Date().toISOString();
  } else {
    // 2. Check generated version.json (used by tsc backend dist/src/index.js and local runtime)
    let versionJson: any = null;
    try {
      versionJson = require('./version.json');
    } catch {
      try {
        versionJson = require(path.join(__dirname, 'version.json'));
      } catch {
        try {
          versionJson = require(path.join(process.cwd(), 'src/shared/version.json'));
        } catch {}
      }
    }

    if (versionJson && versionJson.version) {
      version = versionJson.version;
      gitCommit = versionJson.gitCommit || 'dev';
      buildTime = versionJson.buildTime || new Date().toISOString();
    } else {
      // 3. Fallback to package.json
      try {
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
      gitCommit = typeof __GT_GIT_COMMIT__ !== 'undefined' ? __GT_GIT_COMMIT__ : 'dev';
      buildTime = typeof __GT_BUILD_TIME__ !== 'undefined' ? __GT_BUILD_TIME__ : new Date().toISOString();
    }
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
