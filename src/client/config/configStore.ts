import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const DEFAULT_SERVER_URL = 'http://localhost:8000';

export interface ContextConfig {
  server: string;
  key: string;
}

export interface ConfigData {
  currentContext: string;
  contexts: Record<string, ContextConfig>;
  machineId: string;
  [key: string]: any;
}

export class ConfigStore {
  static getConfigDir(): string {
    return process.env.GT_CONFIG_DIR || path.join(os.homedir(), '.gt');
  }

  static getConfigFile(): string {
    return path.join(this.getConfigDir(), 'config.json');
  }

  static load(): ConfigData {
    let data: any = {};
    try {
      const p = this.getConfigFile();
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}

    let needsSave = false;

    if (!data.machineId || typeof data.machineId !== 'string') {
      data.machineId = crypto.randomBytes(6).toString('hex');
      needsSave = true;
    }

    if (!data.contexts || typeof data.contexts !== 'object') {
      data.contexts = {};
      needsSave = true;
    }

    if (!data.contexts.default) {
      data.contexts.default = {
        server: data.server || DEFAULT_SERVER_URL,
        key: data.key || '',
      };
      needsSave = true;
    }

    if (!data.currentContext || !data.contexts[data.currentContext]) {
      data.currentContext = 'default';
      needsSave = true;
    }

    if (needsSave) {
      this.save(data);
    }

    return data as ConfigData;
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
    if (key === 'server') {
      return data.server || (data.contexts && data.contexts[data.currentContext]?.server) || DEFAULT_SERVER_URL;
    }
    if (key === 'key') {
      return data.key !== undefined ? data.key : (data.contexts && data.contexts[data.currentContext]?.key);
    }
    return data[key];
  }

  static set(key: string, val: any): void {
    const data = this.load();
    if (val === undefined || val === null || val === '') {
      delete data[key];
      if (key === 'key' && data.contexts && data.contexts[data.currentContext]) {
        data.contexts[data.currentContext].key = '';
      }
    } else {
      data[key] = val;
      if (key === 'server' && data.contexts && data.contexts[data.currentContext]) {
        data.contexts[data.currentContext].server = val;
      } else if (key === 'key' && data.contexts && data.contexts[data.currentContext]) {
        data.contexts[data.currentContext].key = val;
      }
    }
    this.save(data);
  }

  static getMachineId(): string {
    return this.load().machineId;
  }

  static getContexts(): Record<string, ContextConfig> {
    return this.load().contexts;
  }

  static getCurrentContext(): string {
    return this.load().currentContext;
  }

  static useContext(name: string): void {
    const data = this.load();
    if (!data.contexts[name]) {
      throw new Error(`Context '${name}' does not exist.`);
    }
    data.currentContext = name;
    data.server = data.contexts[name].server;
    data.key = data.contexts[name].key;
    this.save(data);
  }

  static setContext(name: string, cfg: Partial<ContextConfig>): void {
    const data = this.load();
    const existing = data.contexts[name] || { server: DEFAULT_SERVER_URL, key: '' };
    data.contexts[name] = {
      server: cfg.server !== undefined ? cfg.server : existing.server,
      key: cfg.key !== undefined ? cfg.key : existing.key,
    };
    if (!data.currentContext) {
      data.currentContext = name;
    }
    if (data.currentContext === name) {
      if (cfg.server !== undefined) data.server = cfg.server;
      if (cfg.key !== undefined) data.key = cfg.key;
    }
    this.save(data);
  }

  static deleteContext(name: string): { resetDefault?: boolean; deleted?: boolean } {
    const data = this.load();
    if (name === 'default') {
      data.contexts.default = { server: DEFAULT_SERVER_URL, key: '' };
      data.currentContext = 'default';
      data.server = DEFAULT_SERVER_URL;
      data.key = '';
      this.save(data);
      return { resetDefault: true };
    }

    if (!data.contexts[name]) {
      throw new Error(`Context '${name}' does not exist.`);
    }

    delete data.contexts[name];
    if (data.currentContext === name) {
      data.currentContext = 'default';
      if (data.contexts.default) {
        data.server = data.contexts.default.server;
        data.key = data.contexts.default.key;
      }
    }
    this.save(data);
    return { deleted: true };
  }

  static getEffectiveConfig(
    cliOpts: { server?: string; key?: string; context?: string } = {},
    env: Record<string, string | undefined> = process.env
  ): { server: string; key: string; context: string } {
    const data = this.load();
    const targetContextName = cliOpts.context || data.currentContext || 'default';
    const contextConfig = (data.contexts && data.contexts[targetContextName]) || (data.contexts && data.contexts.default) || { server: DEFAULT_SERVER_URL, key: '' };

    const server =
      cliOpts.server ||
      env.GT_SERVER ||
      contextConfig.server ||
      data.server ||
      DEFAULT_SERVER_URL;

    const key =
      cliOpts.key ||
      env.GT_KEY ||
      contextConfig.key ||
      data.key ||
      '';

    return { server, key, context: targetContextName };
  }
}
