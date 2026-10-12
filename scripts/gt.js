#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const distPath = path.resolve(__dirname, '../dist/gt.js');

const pkgPath = path.resolve(__dirname, '../package.json');

// Auto-build if dist/gt.js doesn't exist or is older than package.json or git HEAD
let needsBuild = !fs.existsSync(distPath);
if (!needsBuild) {
  try {
    const distMtime = fs.statSync(distPath).mtimeMs;
    const pkgMtime = fs.statSync(pkgPath).mtimeMs;
    if (pkgMtime > distMtime) {
      needsBuild = true;
    } else {
      const gitHeadPath = path.resolve(__dirname, '../.git/HEAD');
      if (fs.existsSync(gitHeadPath) && fs.statSync(gitHeadPath).mtimeMs > distMtime) {
        needsBuild = true;
      }
    }
  } catch {}
}

if (needsBuild) {
  const { execSync } = require('child_process');
  execSync('npm run build:gt', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
}

const gt = require(distPath);
module.exports = gt;

if (require.main === module) {
  if (typeof gt.main === 'function') {
    gt.main(process.argv.slice(2));
  } else if (typeof gt.runClient === 'function') {
    gt.runClient(process.argv.slice(2));
  }
}
