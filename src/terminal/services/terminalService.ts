import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type * as pty from 'node-pty';
import logger from '../../utils/logger';

let _cachedNodePty: any = null;

export function getNodePty(): any {
  if (_cachedNodePty) return _cachedNodePty;
  try {
    _cachedNodePty = require('node-pty');
    return _cachedNodePty;
  } catch (err: any) {
    throw new Error(
      `Failed to load native node-pty module. Please run 'npm rebuild node-pty'. Original error: ${err.message}`
    );
  }
}

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

function ensureSpawnHelperPermissions(): void {
  if (os.platform() === 'win32') return;
  try {
    const candidateDirs = [
      path.resolve(__dirname, '../../../node_modules/node-pty/prebuilds'),
      path.resolve(__dirname, '../../../../node_modules/node-pty/prebuilds'),
      path.resolve(process.cwd(), 'node_modules/node-pty/prebuilds'),
    ];

    for (const prebuildsDir of candidateDirs) {
      if (fs.existsSync(prebuildsDir)) {
        const archDirs = fs.readdirSync(prebuildsDir);
        for (const arch of archDirs) {
          const helper = path.join(prebuildsDir, arch, 'spawn-helper');
          if (fs.existsSync(helper)) {
            const stat = fs.statSync(helper);
            if ((stat.mode & 0o111) === 0) {
              fs.chmodSync(helper, 0o755);
            }
          }
        }
      }
    }
  } catch {
    // Silently continue
  }
}

export function getDefaultShell(): string {
  if (os.platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  if (fs.existsSync('/usr/bin/bash')) return '/usr/bin/bash';
  if (fs.existsSync('/bin/sh')) return '/bin/sh';
  return '/bin/sh';
}

export function spawnTerminalSession(options: TerminalSessionOptions = {}): pty.IPty {
  ensureSpawnHelperPermissions();

  const shell = getDefaultShell();
  const cols = options.cols || 80;
  const rows = options.rows || 24;
  const fallbackDir = process.env.HOME || os.homedir() || process.cwd();
  let cwd = options.cwd ? options.cwd.trim() : fallbackDir;
  if (cwd === '~') {
    cwd = fallbackDir;
  } else if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    cwd = path.resolve(path.join(fallbackDir, cwd.slice(2)));
  } else {
    cwd = path.resolve(cwd);
  }
  if (!fs.existsSync(cwd)) {
    cwd = fallbackDir;
  }

  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
    TERM_PROGRAM: 'gemini-proxy-terminal',
    PROMPT_EOL_MARK: '',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN || '1',
    COLUMNS: String(cols),
    LINES: String(rows),
    ...options.env,
  } as { [key: string]: string };

  logger.info(`Spawning PTY shell: ${shell} (${cols}x${rows}) in ${cwd}`);

  const pty = getNodePty();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  return ptyProcess;
}
