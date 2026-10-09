import os from 'os';
import path from 'path';
import { spawn, execSync, ChildProcess } from 'child_process';
import { killProcessTree } from '../tasks/taskManager';

export function tryRequirePty(): any {
  if (process.env.GT_DISABLE_NODE_PTY) return null;
  try {
    return require('node-pty');
  } catch {}
  try {
    const cwdReq = require('module').createRequire(path.join(process.cwd(), 'dummy.js'));
    return cwdReq('node-pty');
  } catch {}
  try {
    const candidatePaths = [
      process.env.NODE_PATH,
      '/usr/lib/node_modules',
      '/usr/local/lib/node_modules',
      process.env.HOME ? path.join(process.env.HOME, '.node_modules') : null,
      process.env.HOME ? path.join(process.env.HOME, 'node_modules') : null,
    ].filter(Boolean) as string[];
    for (const p of candidatePaths) {
      try {
        const req = require('module').createRequire(path.join(p, 'dummy.js'));
        const mod = req('node-pty');
        if (mod) return mod;
      } catch {}
    }
  } catch {}
  return null;
}

let _cachedHasPython3: boolean | undefined = undefined;
export function hasSystemPython3(forceRefresh: boolean = false): boolean {
  if (!forceRefresh && _cachedHasPython3 !== undefined) return _cachedHasPython3;
  if (os.platform() === 'win32') {
    _cachedHasPython3 = false;
    return false;
  }
  try {
    const res = execSync('python3 -c "import pty; print(1)"', { stdio: 'pipe', timeout: 1000 });
    _cachedHasPython3 = res.toString().trim() === '1';
  } catch {
    _cachedHasPython3 = false;
  }
  return _cachedHasPython3;
}

export interface PtyDriverOptions {
  command: string;
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  onData: (data: Buffer | string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class NodePtyDriver {
  public onData: (data: any) => void;
  public onExit: (code: number | null, signal: string | null) => void;
  public proc: any;

  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }: PtyDriverOptions) {
    this.onData = onData;
    this.onExit = onExit;
    const isWindows = os.platform() === 'win32';
    const shellArgs = isWindows
      ? (shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command])
      : ['-c', command];

    const pty = tryRequirePty();
    if (!pty) {
      throw new Error('node-pty module is not available');
    }

    this.proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });

    this.proc.onData((data: any) => this.onData(data));
    this.proc.onExit(({ exitCode, signal }: { exitCode: number; signal: string }) => this.onExit(exitCode, signal));
  }

  write(buf: Buffer | string): void {
    if (this.proc) {
      try {
        const str = Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
        this.proc.write(str);
      } catch {}
    }
  }

  resize(cols: number, rows: number): void {
    if (this.proc && typeof this.proc.resize === 'function') {
      try {
        this.proc.resize(Math.max(10, cols || 80), Math.max(5, rows || 24));
      } catch {}
    }
  }

  kill(signal: string = 'SIGTERM'): void {
    if (this.proc) {
      try {
        this.proc.kill(signal);
      } catch {}
    }
  }
}

export class PosixPtyDriver {
  public onData: (data: any) => void;
  public onExit: (code: number | null, signal: string | null) => void;
  public cols: number;
  public rows: number;
  public proc: ChildProcess;
  public ctlStream: any;
  private _nudgeTimer: any = null;
  private _lastNudge: number = 0;

  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }: PtyDriverOptions) {
    this.onData = onData;
    this.onExit = onExit;
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));

    const pyScript = `
import os, sys, pty, termios, fcntl, struct, select, signal, atexit

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd_to_run = sys.argv[3:]

master, slave = pty.openpty()
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except:
    pass

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvp(cmd_to_run[0], cmd_to_run)
else:
    os.close(slave)
    def sig_resize(signum, frame):
        pass
    signal.signal(signal.SIGWINCH, sig_resize)

    def cleanup():
        try:
            os.killpg(pid, signal.SIGKILL)
        except:
            try:
                os.kill(pid, signal.SIGKILL)
            except:
                pass
    atexit.register(cleanup)

    def sig_cleanup(signum, frame):
        cleanup()
        sys.exit(128 + signum)
    signal.signal(signal.SIGTERM, sig_cleanup)
    signal.signal(signal.SIGINT, sig_cleanup)

    # Non-blocking IO loop between sys.stdin/stdout, ctl_fd, and master
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    stdin_fileno = sys.stdin.fileno()
    stdin_closed = False

    ctl_fd = 3
    ctl_closed = False
    try:
        fl_ctl = fcntl.fcntl(ctl_fd, fcntl.F_GETFL)
        fcntl.fcntl(ctl_fd, fcntl.F_SETFL, fl_ctl | os.O_NONBLOCK)
    except Exception:
        ctl_closed = True

    ctl_buf = ""

    while True:
        read_fds = [master]
        if not stdin_closed:
            read_fds.append(stdin_fileno)
        if not ctl_closed:
            read_fds.append(ctl_fd)
        try:
            r, w, x = select.select(read_fds, [], [], 0.05)
        except (InterruptedError, select.error):
            continue

        if not ctl_closed and ctl_fd in r:
            try:
                ctl_data = os.read(ctl_fd, 1024)
                if not ctl_data:
                    ctl_closed = True
                else:
                    ctl_buf += ctl_data.decode("utf-8", "replace")
                    while "\\n" in ctl_buf:
                        line, ctl_buf = ctl_buf.split("\\n", 1)
                        line = line.strip()
                        if line.startswith("RESIZE "):
                            parts = line.split()
                            if len(parts) >= 3:
                                try:
                                    new_cols, new_rows = int(parts[1]), int(parts[2])
                                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", new_rows, new_cols, 0, 0))
                                except Exception:
                                    pass
            except (OSError, EOFError):
                ctl_closed = True

        if not stdin_closed and stdin_fileno in r:
            try:
                data = os.read(stdin_fileno, 4096)
                if not data:
                    stdin_closed = True
                else:
                    os.write(master, data)
            except (OSError, EOFError):
                stdin_closed = True

        if master in r:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
                sys.stdout.flush()
            except (BlockingIOError, OSError):
                pass

        # Check child status
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            # Drain remaining
            try:
                while True:
                    data = os.read(master, 4096)
                    if not data: break
                    os.write(sys.stdout.fileno(), data)
                    sys.stdout.flush()
            except:
                pass
            if hasattr(os, "waitstatus_to_exitcode"):
                exit_code = os.waitstatus_to_exitcode(status)
            else:
                exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128 + os.WTERMSIG(status))
            sys.exit(exit_code)

    try:
        _, status = os.waitpid(pid, 0)
        if hasattr(os, "waitstatus_to_exitcode"):
            exit_code = os.waitstatus_to_exitcode(status)
        else:
            exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128 + os.WTERMSIG(status))
    except:
        exit_code = 0
    sys.exit(exit_code)
`;

    const trimmed = (command || '').trim();
    const isSimpleShell = ['bash', 'sh', 'zsh'].includes(trimmed) ||
      ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'].includes(trimmed);
    const targetArgs = isSimpleShell ? [trimmed, '-i'] : [shell, '-c', command];

    this.proc = spawn('python3', [
      '-c', pyScript,
      String(this.cols),
      String(this.rows),
      ...targetArgs
    ], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });

    this.ctlStream = this.proc.stdio && this.proc.stdio[3] ? this.proc.stdio[3] : null;

    if (this.proc.stdout) this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    if (this.proc.stderr) this.proc.stderr.on('data', (chunk) => this.onData(chunk));
    this.proc.on('close', (code, signal) => this.onExit(code, signal));
  }

  write(buf: Buffer | string): void {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed && !this.proc.stdin.writableEnded) {
      try {
        const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        this.proc.stdin.write(buffer);
      } catch {}
    }
  }

  resize(cols: number, rows: number): void {
    const targetCols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    const targetRows = Math.max(5, Math.min(200, Math.floor(rows || 24)));
    if (this.cols === targetCols && this.rows === targetRows) {
      const now = Date.now();
      if (!this._nudgeTimer && (!this._lastNudge || now - this._lastNudge > 1000)) {
        this._lastNudge = now;
        const nudgeRows = targetRows > 5 ? targetRows - 1 : targetRows + 1;
        if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
          try {
            this.ctlStream.write(`RESIZE ${targetCols} ${nudgeRows}\n`);
            this._nudgeTimer = setTimeout(() => {
              this._nudgeTimer = null;
              if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
                try {
                  this.ctlStream.write(`RESIZE ${targetCols} ${targetRows}\n`);
                } catch {}
              }
            }, 30);
          } catch {}
        }
      }
      return;
    }
    if (this._nudgeTimer) {
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = null;
    }
    this.cols = targetCols;
    this.rows = targetRows;
    if (this.ctlStream && !this.ctlStream.destroyed && !this.ctlStream.writableEnded) {
      try {
        this.ctlStream.write(`RESIZE ${this.cols} ${this.rows}\n`);
      } catch {}
    }
  }

  kill(signal: string = 'SIGTERM'): void {
    if (this.ctlStream) {
      try {
        this.ctlStream.end();
      } catch {}
    }
    if (this.proc) {
      killProcessTree(this.proc, signal);
    }
  }
}

export class InteractivePipeDriver {
  public onData: (data: any) => void;
  public onExit: (code: number | null, signal: string | null) => void;
  public cols: number;
  public rows: number;
  public proc: ChildProcess;

  constructor({ command, shell, cwd, env, cols, rows, onData, onExit }: PtyDriverOptions) {
    this.onData = onData;
    this.onExit = onExit;
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));

    const isWindows = os.platform() === 'win32';
    const trimmed = (command || '').trim();
    const isSimpleShell = ['bash', 'sh', 'zsh'].includes(trimmed) ||
      ['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'].includes(trimmed);

    let spawnCmd = shell;
    let spawnArgs: string[] = [];

    if (isWindows) {
      spawnArgs = shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command];
    } else {
      if (isSimpleShell) {
        spawnCmd = trimmed;
        spawnArgs = ['-i'];
      } else {
        spawnArgs = ['-c', command];
      }
    }

    this.proc = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
    });

    if (this.proc.stdout) this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    if (this.proc.stderr) this.proc.stderr.on('data', (chunk) => this.onData(chunk));
    this.proc.on('close', (code, signal) => this.onExit(code, signal));
  }

  write(buf: Buffer | string): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) return;
    try {
      const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (buffer.length === 1 && buffer[0] === 0x03) {
        this.kill('SIGINT');
        return;
      }
      if (buffer.length === 1 && buffer[0] === 0x04) {
        this.proc.stdin.end();
        return;
      }

      const normalized = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        normalized[i] = buffer[i] === 0x0d ? 0x0a : buffer[i];
      }
      this.proc.stdin.write(normalized);
    } catch {}
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows || 24)));
  }

  kill(signal: string = 'SIGTERM'): void {
    if (this.proc) {
      killProcessTree(this.proc, signal);
    }
  }
}
