const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { generateVersionData } = require('./generate-version');

// Ensure version data is generated and unified
const versionData = generateVersionData();

const outfile = path.join(__dirname, '../dist/gt.js');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/bin/gt.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty', 'ws'],
  define: {
    '__GT_VERSION__': JSON.stringify(versionData.version),
    '__GT_GIT_COMMIT__': JSON.stringify(versionData.gitCommit),
    '__GT_BUILD_TIME__': JSON.stringify(versionData.buildTime),
  },
});
try {
  fs.chmodSync(outfile, 0o755);
} catch {}
console.log(`[build:gt] Built dist/gt.js v${versionData.version} (${versionData.gitCommit}) built at ${versionData.buildTime}`);
