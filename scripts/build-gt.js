const esbuild = require('esbuild');
const { execSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}

const buildTime = new Date().toISOString();
const version = pkg.version || '1.0.0';

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/bin/gt.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, '../dist/gt.js'),
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty', 'ws'],
  define: {
    '__GT_VERSION__': JSON.stringify(version),
    '__GT_GIT_COMMIT__': JSON.stringify(gitCommit),
    '__GT_BUILD_TIME__': JSON.stringify(buildTime),
  },
});
console.log(`[build:gt] Built dist/gt.js v${version} (${gitCommit}) built at ${buildTime}`);
