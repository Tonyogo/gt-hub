import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ScriptMetadata {
  name: string;
  title: string;
  description: string;
  interpreter: string;
  size: number;
  updatedAt: string;
}

export interface ScriptDetail extends ScriptMetadata {
  content: string;
}

const NAME_REGEX = /^[a-zA-Z0-9_\-\.]+$/;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export class ScriptService {
  private storageDir: string;

  constructor(storageDir?: string) {
    if (storageDir) {
      this.storageDir = path.resolve(storageDir);
    } else if (process.env.GT_SCRIPTS_DIR) {
      this.storageDir = path.resolve(process.env.GT_SCRIPTS_DIR);
    } else {
      this.storageDir = path.join(os.homedir(), '.gt', 'scripts');
    }
    this.ensureDir();
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o755 });
    }
  }

  private validateName(name: string): string {
    if (!name || typeof name !== 'string' || !NAME_REGEX.test(name)) {
      throw new Error(`Invalid script name: "${name}". Only letters, numbers, dots, dashes, and underscores are allowed.`);
    }
    const resolvedPath = path.resolve(this.storageDir, name);
    if (!resolvedPath.startsWith(this.storageDir + path.sep)) {
      throw new Error(`Invalid script name: Path traversal detected.`);
    }
    return resolvedPath;
  }

  private parseMetadata(name: string, content: string, stat: fs.Stats): ScriptMetadata {
    const lines = content.split(/\r?\n/).slice(0, 25);
    let title = '';
    let description = '';
    let interpreter = '';

    for (const line of lines) {
      const trimmed = line.trim();
      const titleMatch = trimmed.match(/^#\s*@title:\s*(.+)$/i);
      if (titleMatch && !title) {
        title = titleMatch[1].trim();
      }
      const descMatch = trimmed.match(/^#\s*@description:\s*(.+)$/i);
      if (descMatch && !description) {
        description = descMatch[1].trim();
      }
      const interpMatch = trimmed.match(/^#\s*@interpreter:\s*(.+)$/i);
      if (interpMatch && !interpreter) {
        interpreter = interpMatch[1].trim();
      }
    }

    if (!title) {
      title = name;
    }

    if (!interpreter) {
      const ext = path.extname(name).toLowerCase();
      if (ext === '.py') {
        interpreter = 'python3';
      } else if (ext === '.js') {
        interpreter = 'node';
      } else {
        interpreter = 'bash';
      }
    }

    return {
      name,
      title,
      description,
      interpreter,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  public async listScripts(): Promise<ScriptMetadata[]> {
    this.ensureDir();
    const entries = await fs.promises.readdir(this.storageDir, { withFileTypes: true });
    const results: ScriptMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) {
        continue;
      }
      try {
        const filePath = path.join(this.storageDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        const fd = await fs.promises.open(filePath, 'r');
        const buf = Buffer.alloc(Math.min(stat.size, 4096));
        await fd.read(buf, 0, buf.length, 0);
        await fd.close();
        const headerText = buf.toString('utf-8');
        results.push(this.parseMetadata(entry.name, headerText, stat));
      } catch {
        // Skip unreadable files
      }
    }

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }

  public async getScript(name: string): Promise<ScriptDetail> {
    const filePath = this.validateName(name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Script "${name}" not found`);
    }
    const stat = await fs.promises.stat(filePath);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const meta = this.parseMetadata(name, content, stat);
    return { ...meta, content };
  }

  public async saveScript(name: string, content: string): Promise<ScriptMetadata> {
    const filePath = this.validateName(name);
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      throw new Error(`Script size exceeds 1MB limit`);
    }
    await fs.promises.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o755 });
    const stat = await fs.promises.stat(filePath);
    return this.parseMetadata(name, content, stat);
  }

  public async deleteScript(name: string): Promise<void> {
    const filePath = this.validateName(name);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }
}

export const scriptService = new ScriptService();
