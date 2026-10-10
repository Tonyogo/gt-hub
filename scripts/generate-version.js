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

function getExactTag() {
  try {
    return execSync('git describe --tags --exact-match 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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
  const exactTag = getExactTag();
  const buildTime = new Date().toISOString();
  const platform = `${process.platform}/${process.arch}`;

  // If the current commit is directly tagged with a release version (e.g. v1.0.1 or 1.0.1), use it cleanly
  let effectiveVersion = baseVersion;
  if (exactTag) {
    effectiveVersion = exactTag.replace(/^v/, '');
  } else if (gitCommit && gitCommit !== 'unknown') {
    // Dynamically derive semver build metadata with git commit and commit count
    // e.g. 1.0.0+d9ebcb4
    effectiveVersion = `${baseVersion}+${gitCommit}`;
  }

  const versionData = {
    version: effectiveVersion,
    rawVersion: baseVersion,
    gitCommit,
    commitCount,
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
