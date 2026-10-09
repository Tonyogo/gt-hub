#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const distPath = path.resolve(__dirname, '../dist/gt.js');

// Auto-build if dist/gt.js doesn't exist
if (!fs.existsSync(distPath)) {
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
