import { EventEmitter } from 'events';

export interface TerminalLogEntry {
  id: number;
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
}

class TerminalLogService extends EventEmitter {
  private logsBuffer: TerminalLogEntry[] = [];
  private nextId = 1;
  private readonly maxCapacity = 100;

  public addLog(level: 'error' | 'warn' | 'info' | 'debug' | string, message: string): TerminalLogEntry {
    const validLevel = ['error', 'warn', 'info', 'debug'].includes(level)
      ? (level as 'error' | 'warn' | 'info' | 'debug')
      : 'info';

    const entry: TerminalLogEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level: validLevel,
      message
    };

    this.logsBuffer.push(entry);
    if (this.logsBuffer.length > this.maxCapacity) {
      this.logsBuffer.shift();
    }

    this.emit('log', entry);
    return entry;
  }

  public getHistory(): TerminalLogEntry[] {
    return [...this.logsBuffer];
  }

  public clearHistory(): void {
    this.logsBuffer = [];
  }
}

const terminalLogService = new TerminalLogService();
export default terminalLogService;
