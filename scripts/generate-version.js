const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function getCommitCount() {
  try {
    return execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '0';
  }
}

function getGitDescribe() {
  try {
    return execSync('git describe --tags --always 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function generateVersionData() {
  const pkgPath = path.join(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const baseVersion = pkg.version || '1.0.0';

  const gitCommit = getGitCommit();
  const commitCount = getCommitCount();
  const gitDescribe = getGitDescribe();
  const buildTime = new Date().toISOString();
  const platform = `${process.platform}/${process.arch}`;

  // Directly derive version from git describe --tags --always
  let effectiveVersion = baseVersion;
  if (gitDescribe && /^v?[0-9]+\.[0-9]+/.test(gitDescribe)) {
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

  const targetPath = path.join(__dirname, '../src/shared/version.json');
  fs.writeFileSync(targetPath, JSON.stringify(versionData, null, 2) + '\n', 'utf8');

  // Also write to dist/src/shared/version.json if dist directory structure exists or can be created
  try {
    const distTargetPath = path.join(__dirname, '../dist/src/shared/version.json');
    fs.mkdirSync(path.dirname(distTargetPath), { recursive: true });
    fs.writeFileSync(distTargetPath, JSON.stringify(versionData, null, 2) + '\n', 'utf8');
  } catch {}

  return versionData;
}

if (require.main === module) {
  const data = generateVersionData();
  console.log(`[version] Generated src/shared/version.json: ${data.version} (${data.gitCommit}) built at ${data.buildTime}`);
}

module.exports = { generateVersionData };
