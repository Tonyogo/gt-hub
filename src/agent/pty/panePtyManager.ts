import { StringDecoder } from 'string_decoder';
import { tryRequirePty, hasSystemPython3, PosixPtyDriver, InteractivePipeDriver } from './drivers';
import { TerminalHistoryBuffer } from './terminalHistoryBuffer';
import { StreamBatcher } from '../../shared/utils/streamBatcher';
import { BIN_MSG_TYPE, encodeBinaryPacket } from '../../shared/protocol/binaryProtocol';
import { getDefaultShell } from '../tasks/taskManager';

export interface SecondaryPanePtyManagerOptions {
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  maxScrollbackBytes?: number;
  sendBinary: (packet: Buffer) => void;
  sendControl: (msg: Record<string, any>) => void;
}

interface ManagedSecondaryPane {
  paneId: string;
  ptyProcess: any;
  batcher: StreamBatcher | null;
  decoder: StringDecoder;
  history: TerminalHistoryBuffer;
  cols: number;
  rows: number;
  isClosing: boolean;
}

export class SecondaryPanePtyManager {
  private panes: Map<string, ManagedSecondaryPane> = new Map();
  private options: SecondaryPanePtyManagerOptions;
  private maxScrollbackBytes: number;
  private sendBinary: (packet: Buffer) => void;
  private sendControl: (msg: Record<string, any>) => void;

  constructor(opts: SecondaryPanePtyManagerOptions) {
    this.options = opts;
    this.maxScrollbackBytes = opts.maxScrollbackBytes || 1 * 1024 * 1024;
    this.sendBinary = opts.sendBinary;
    this.sendControl = opts.sendControl;
  }

  public hasPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  private spawnPane(paneId: string, initialCols: number = 80, initialRows: number = 24): ManagedSecondaryPane {
    const existing = this.panes.get(paneId);
    if (existing) {
      return existing;
    }

    const shell = this.options.shell || getDefaultShell();
    const cwd = this.options.cwd || process.env.HOME || process.cwd();
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM_PROGRAM: 'gemini-proxy-agent',
      PROMPT_EOL_MARK: '',
      ...(this.options.env || {}),
    };
    delete baseEnv.TMUX;
    delete baseEnv.TMUX_PANE;
    delete baseEnv.STY;
    delete baseEnv.WINDOW;
    delete baseEnv.TERM_SESSION_ID;

    const cols = Math.max(10, Math.min(500, initialCols));
    const rows = Math.max(5, Math.min(200, initialRows));

    const pane: ManagedSecondaryPane = {
      paneId,
      ptyProcess: null,
      batcher: null,
      decoder: new StringDecoder('utf8'),
      history: new TerminalHistoryBuffer(this.maxScrollbackBytes),
      cols,
      rows,
      isClosing: false,
    };

    const sendToHub = (data: Buffer | string) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      pane.history.push(buf);
      try {
        this.sendBinary(encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, paneId, buf));
      } catch (err: any) {
        console.warn(`[SecondaryPane:${paneId}] Failed to send raw binary packet: ${err.message}`);
      }
    };

    const getPtyBatcher = (): StreamBatcher => {
      if (!pane.batcher) {
        pane.batcher = new StreamBatcher((batched) => {
          sendToHub(batched);
        }, 8, 64 * 1024, 4096);
      }
      return pane.batcher;
    };

    const pushDecodedPtyChunk = (data: any) => {
      const text = typeof data === 'string'
        ? data
        : pane.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (text) {
        getPtyBatcher().push(text);
      }
    };

    const flushDecodedPtyEnd = () => {
      const tail = pane.decoder.end();
      if (tail) {
        getPtyBatcher().push(tail);
      }
      if (pane.batcher) {
        pane.batcher.flush();
      }
    };

    const onPtyExit = (exitCode: number = 0) => {
      flushDecodedPtyEnd();
      const wasClosing = pane.isClosing;
      pane.history.clear();
      this.panes.delete(paneId);
      if (!wasClosing) {
        this.sendControl({ type: 'pane_exit', paneId, exitCode: exitCode ?? 0 });
      }
    };

    // Layer 1: node-pty
    const pty = tryRequirePty();
    if (pty) {
      try {
        const proc = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: baseEnv,
        });

        proc.onData((data: any) => pushDecodedPtyChunk(data));
        proc.onExit(({ exitCode }: { exitCode: number }) => onPtyExit(exitCode));

        pane.ptyProcess = proc;
        this.panes.set(paneId, pane);
        return pane;
      } catch (err: any) {
        console.warn(`[SecondaryPane:${paneId}] node-pty spawn failed: ${err.message}, attempting fallback...`);
      }
    }

    // Layer 2: PosixPtyDriver (Python 3)
    if (!pane.ptyProcess && hasSystemPython3()) {
      try {
        const driver = new PosixPtyDriver({
          command: shell,
          shell,
          cwd,
          env: baseEnv,
          cols,
          rows,
          onData: (data: any) => pushDecodedPtyChunk(data),
          onExit: (code: any) => onPtyExit(code ?? 0),
        });

        pane.ptyProcess = {
          pid: driver.proc ? driver.proc.pid : 0,
          cols,
          rows,
          write: (data: any) => driver.write(data),
          resize: (c: number, r: number) => {
            pane.cols = c;
            pane.rows = r;
            driver.resize(c, r);
          },
          kill: (sig?: any) => driver.kill(sig),
        };
        this.panes.set(paneId, pane);
        return pane;
      } catch (err: any) {
        console.warn(`[SecondaryPane:${paneId}] PosixPty fallback failed: ${err.message}, attempting pipe...`);
      }
    }

    // Layer 3: InteractivePipeDriver
    try {
      const driver = new InteractivePipeDriver({
        command: shell,
        shell,
        cwd,
        env: baseEnv,
        cols,
        rows,
        onData: (data: any) => pushDecodedPtyChunk(data),
        onExit: (code: any) => onPtyExit(code ?? 0),
      });

      pane.ptyProcess = {
        pid: driver.proc ? driver.proc.pid : 0,
        cols,
        rows,
        write: (data: any) => driver.write(data),
        resize: (c: number, r: number) => {
          pane.cols = c;
          pane.rows = r;
          driver.resize(c, r);
        },
        kill: (sig?: any) => driver.kill(sig),
      };
      this.panes.set(paneId, pane);
      sendToHub(Buffer.from('\r\n\x1b[33m[Notice] Running secondary pane in interactive pipe fallback mode.\x1b[0m\r\n'));
      return pane;
    } catch (err: any) {
      console.error(`[SecondaryPane:${paneId}] All PTY drivers failed to spawn secondary shell: ${err.message}`);
      pane.ptyProcess = null;
      sendToHub(Buffer.from(`\r\n\x1b[31m[Error] Failed to spawn secondary shell: ${err.message}\x1b[0m\r\n`));
      this.panes.set(paneId, pane);
      return pane;
    }
  }

  private getOrCreatePane(paneId: string, cols?: number, rows?: number): ManagedSecondaryPane {
    let pane = this.panes.get(paneId);
    if (!pane) {
      pane = this.spawnPane(paneId, cols, rows);
    }
    return pane;
  }

  public write(paneId: string, data: string | Buffer): void {
    const pane = this.getOrCreatePane(paneId);
    if (pane && pane.ptyProcess) {
      const str = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
      try {
        pane.ptyProcess.write(str);
      } catch (err: any) {
        console.warn(`[SecondaryPane:${paneId}] Write error: ${err.message}`);
      }
    }
  }

  public resize(paneId: string, cols: number, rows: number): void {
    const validCols = Math.max(10, Math.min(500, Math.floor(cols || 80)));
    const validRows = Math.max(5, Math.min(200, Math.floor(rows || 24)));

    let pane = this.panes.get(paneId);
    if (!pane) {
      this.spawnPane(paneId, validCols, validRows);
      return;
    }

    if (pane.cols === validCols && pane.rows === validRows) {
      return;
    }
    pane.cols = validCols;
    pane.rows = validRows;
    if (pane.ptyProcess && typeof pane.ptyProcess.resize === 'function') {
      try {
        pane.ptyProcess.resize(validCols, validRows);
      } catch {}
    }
  }

  public reset(paneId: string): void {
    const existing = this.panes.get(paneId);
    const cols = existing ? existing.cols : 80;
    const rows = existing ? existing.rows : 24;
    this.closePane(paneId);
    this.spawnPane(paneId, cols, rows);
  }

  public sendHistorySync(paneId: string): void {
    const pane = this.getOrCreatePane(paneId);
    const histBuf = pane.history.getBuffer();
    if (histBuf.length === 0) return;
    try {
      this.sendBinary(encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, paneId, histBuf));
    } catch (err: any) {
      console.warn(`[SecondaryPane:${paneId}] Failed to send history sync: ${err.message}`);
    }
  }

  public sendAllHistorySync(): void {
    for (const pane of this.panes.values()) {
      const histBuf = pane.history.getBuffer();
      if (histBuf.length > 0) {
        try {
          this.sendBinary(encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, pane.paneId, histBuf));
        } catch (err: any) {
          console.warn(`[SecondaryPane:${pane.paneId}] Failed to send history sync: ${err.message}`);
        }
      }
    }
  }

  public closePane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.isClosing = true;
    if (pane.batcher) {
      pane.batcher.flush();
    }
    if (pane.ptyProcess) {
      try {
        pane.ptyProcess.kill('SIGTERM');
      } catch {}
    }
    pane.history.clear();
    this.panes.delete(paneId);
  }

  public destroyAll(): void {
    for (const paneId of Array.from(this.panes.keys())) {
      this.closePane(paneId);
    }
  }
}
