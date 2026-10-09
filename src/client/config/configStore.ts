import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const DEFAULT_SERVER_URL = 'http://localhost:8000';

export class ConfigStore {
  static getConfigDir(): string {
    return process.env.GT_CONFIG_DIR || path.join(os.homedir(), '.gt');
  }

  static getConfigFile(): string {
    return path.join(this.getConfigDir(), 'config.json');
  }

  static load(): Record<string, any> {
    try {
      const p = this.getConfigFile();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}
    return {};
  }

  static save(data: Record<string, any>): void {
    const dir = this.getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }

  static clear(): void {
    try {
      const file = this.getConfigFile();
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {}
  }

  static get(key: string): any {
    const data = this.load();
    return data[key];
  }

  static getMachineId(): string {
    const config = this.load();
    if (config.machineId && typeof config.machineId === 'string' && config.machineId.length > 0) {
      return config.machineId;
    }
    const id = crypto.randomBytes(6).toString('hex');
    config.machineId = id;
    this.save(config);
    return id;
  }

  static set(key: string, val: any): void {
    const data = this.load();
    if (val === undefined || val === null || val === '') {
      delete data[key];
    } else {
      data[key] = val;
    }
    this.save(data);
  }

  static getEffectiveConfig(cliOpts: { server?: string; key?: string } = {}): { server: string; key: string } {
    const stored = this.load();
    const server = (cliOpts && cliOpts.server) ||
      process.env.TERMINAL_SERVER ||
      process.env.GEMINI_PROXY_URL ||
      stored.server ||
      DEFAULT_SERVER_URL;
    const key = (cliOpts && cliOpts.key) ||
      process.env.ADMIN_SECRET_KEY ||
      stored.key ||
      '';
    return { server, key };
  }
}
