let _esbuild = null;
function getEsbuild() {
  if (!_esbuild) {
    _esbuild = require('esbuild');
  }
  return _esbuild;
}
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function getGitCommit(rootDir = ROOT_DIR) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function getCommitCount(rootDir = ROOT_DIR) {
  try {
    return execSync('git rev-list --count HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return '0';
  }
}

function getGitDescribe(rootDir = ROOT_DIR) {
  try {
    return execSync('git describe --tags --always', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

function generateVersionData(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const pkgPath = options.pkgPath || path.join(rootDir, 'package.json');
  let pkg = { version: '1.0.0' };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {}
  const baseVersion = pkg.version || '1.0.0';

  const gitCommit = options.gitCommit !== undefined ? options.gitCommit : getGitCommit(rootDir);
  const commitCount = options.commitCount !== undefined ? options.commitCount : getCommitCount(rootDir);
  const gitDescribe = options.gitDescribe !== undefined ? options.gitDescribe : getGitDescribe(rootDir);
  const buildTime = options.buildTime || new Date().toISOString();
  const platform = options.platform || `${process.platform}/${process.arch}`;

  // If the current commit is directly tagged with a release version (e.g. v1.0.1 or 1.0.1), use it cleanly
  let effectiveVersion = baseVersion;
  if (gitDescribe && /^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(gitDescribe)) {
    effectiveVersion = gitDescribe.replace(/^v/, '');
  } else if (gitCommit && gitCommit !== 'unknown') {
    effectiveVersion = `${baseVersion}+${gitCommit}`;
  }

  const versionData = {
    version: effectiveVersion,
    rawVersion: baseVersion,
    gitCommit,
    commitCount,
    gitDescribe,
    buildTime,
    platform,
  };

  const shouldWrite = options.writeFiles !== false;
  if (shouldWrite) {
    const targetPath = options.targetPath || path.join(rootDir, 'src/shared/version.json');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(versionData, null, 2) + '\n', 'utf8');

    // Also write to dist/src/shared/version.json if dist directory structure exists or can be created
    try {
      const distTargetPath = options.distTargetPath || path.join(rootDir, 'dist/src/shared/version.json');
      fs.mkdirSync(path.dirname(distTargetPath), { recursive: true });
      fs.writeFileSync(distTargetPath, JSON.stringify(versionData, null, 2) + '\n', 'utf8');
    } catch {}
  }

  return versionData;
}

function buildGt(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  // Ensure version data is generated and unified
  const versionData = options.versionData || generateVersionData({ rootDir });
  const outfile = options.outfile || path.join(rootDir, 'dist/gt.js');

  const esbuildOptions = options.esbuildOptions || {};
  const define = {
    '__GT_VERSION__': JSON.stringify(versionData.version),
    '__GT_GIT_COMMIT__': JSON.stringify(versionData.gitCommit),
    '__GT_BUILD_TIME__': JSON.stringify(versionData.buildTime),
    ...(esbuildOptions.define || {}),
  };

  const buildResult = getEsbuild().buildSync({
    entryPoints: [path.join(rootDir, 'src/bin/gt.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile,
    banner: { js: '#!/usr/bin/env node' },
    external: ['node-pty', 'ws'],
    ...esbuildOptions,
    define,
  });

  try {
    fs.chmodSync(outfile, 0o755);
  } catch {}

  if (!options.silent) {
    console.log(`[build:gt] Built dist/gt.js v${versionData.version} (${versionData.gitCommit}) built at ${versionData.buildTime}`);
  }

  return { versionData, outfile, buildResult };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/build-gt.js [options]

Options:
  --version-only  Only generate version metadata (src/shared/version.json)
  --silent        Suppress standard build log output
  --root <path>   Specify repository root directory (default: current project root)
  --help, -h      Show this help message
`);
    process.exit(0);
  }

  const isSilent = args.includes('--silent');
  const isVersionOnly = args.includes('--version-only');
  let customRootDir = process.env.GT_ROOT_DIR || null;
  const rootIndex = args.indexOf('--root');
  if (rootIndex !== -1 && args[rootIndex + 1]) {
    customRootDir = path.resolve(args[rootIndex + 1]);
  }

  if (isVersionOnly) {
    const data = generateVersionData(customRootDir ? { rootDir: customRootDir } : {});
    if (!isSilent) {
      console.log(`[version] Generated src/shared/version.json: ${data.version} (${data.gitCommit}) built at ${data.buildTime}`);
    }
  } else {
    buildGt({ rootDir: customRootDir || undefined, silent: isSilent });
  }
}

module.exports = {
  generateVersionData,
  buildGt,
  getGitCommit,
  getCommitCount,
  getGitDescribe,
};
