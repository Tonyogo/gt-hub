# Terminal Script Management & Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build server-side script storage and management alongside an online WebTerminal drawer for selecting, editing, and safely dispatching multi-line scripts to active terminal sessions.

**Architecture:** Server stores scripts under a dedicated directory (`~/.gt/scripts/`) and exposes authenticated REST endpoints (`/api/admin/scripts`) with strict path traversal validation and metadata extraction. Frontend WebTerminal provides a slide-over drawer to browse, edit, and dispatch scripts into the active PTY session via an isolated `bash -c "$(echo '<base64>' | base64 -d)"` single-line evaluation wrapper that preserves PTY stdin interactivity.

**Tech Stack:** TypeScript, Node.js (Express, fs), Jest, React 18, Tailwind CSS, Lucide Icons, Xterm.js.

**Spec:** `docs/superpowers/specs/2026-10-13-terminal-script-dispatch-design.md`

## Global Constraints

- Storage directory defaults to `~/.gt/scripts/` (overridable via `process.env.GT_SCRIPTS_DIR` or `config.scriptsDir`), permissions `0o755`.
- Script name validation regex: `^[a-zA-Z0-9_\-\.]+$` with forbidden path traversal characters (`..`, `/`, `\`).
- File size limit: 1MB per script.
- Terminal dispatch command format:
  - bash/sh: `bash -c "$(echo '<base64>' | base64 -d)"`
  - python3: `python3 -c "$(echo '<base64>' | base64 -d)"`
  - node: `node -e "$(echo '<base64>' | base64 -d)"`
- All REST endpoints require admin authentication via `adminAuthMiddleware`.

## Review Focus

1. Path traversal attempts (`../../etc/passwd`, `foo/bar`, `..%2f`) must be rejected with 400 Bad Request.
2. Script content with multi-byte UTF-8 Chinese characters and special symbols (`$VAR`, `"quote"`, `'single'`, `` `backticks` ``) must be preserved without encoding corruption.
3. Script exceeding 1MB limit must be rejected with 400 Bad Request.
4. Scripts without metadata headers must gracefully fallback to filename as title and infer interpreter from file extension (`.sh` -> `bash`, `.py` -> `python3`, `.js` -> `node`, unknown -> `bash`).
5. Attempting to dispatch a script when terminal is disconnected must be disabled with a descriptive tooltip and prevent any action.

---

### Task 1: Script Service with Metadata Parsing & Path Traversal Guard

**Files:**
- Create: `src/server/modules/scripts/scriptService.ts`
- Test: `tests/scriptService.test.ts`

**Interfaces:**
- Produces:
  ```ts
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

  export class ScriptService {
    constructor(storageDir?: string);
    getStorageDir(): string;
    listScripts(): Promise<ScriptMetadata[]>;
    getScript(name: string): Promise<ScriptDetail>;
    saveScript(name: string, content: string): Promise<ScriptMetadata>;
    deleteScript(name: string): Promise<void>;
  }
  ```

- [x] **Step 1: Write the failing unit tests for ScriptService**

Create `tests/scriptService.test.ts`:
```ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ScriptService } from '../src/server/modules/scripts/scriptService';

describe('ScriptService', () => {
  let tempDir: string;
  let service: ScriptService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-scripts-test-'));
    service = new ScriptService(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates storage directory on initialization if missing', () => {
    const missingDir = path.join(tempDir, 'sub-scripts');
    const s = new ScriptService(missingDir);
    expect(fs.existsSync(missingDir)).toBe(true);
  });

  it('saves and lists scripts with parsed metadata comments', async () => {
    const content = `#!/usr/bin/env bash\n# @title: 系统检查\n# @description: 检查系统资源\n# @interpreter: bash\necho "ok"`;
    await service.saveScript('check.sh', content);

    const list = await service.listScripts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'check.sh',
      title: '系统检查',
      description: '检查系统资源',
      interpreter: 'bash',
    });
  });

  it('falls back to default title and infers interpreter when headers are missing', async () => {
    await service.saveScript('test.py', 'print("hello")');
    const list = await service.listScripts();
    expect(list[0]).toMatchObject({
      name: 'test.py',
      title: 'test.py',
      description: '',
      interpreter: 'python3',
    });
  });

  it('retrieves single script content accurately', async () => {
    const content = 'echo "hello world"';
    await service.saveScript('hello.sh', content);
    const detail = await service.getScript('hello.sh');
    expect(detail.content).toBe(content);
    expect(detail.name).toBe('hello.sh');
  });

  it('rejects path traversal attempts in script names', async () => {
    await expect(service.saveScript('../evil.sh', 'rm -rf /')).rejects.toThrow('Invalid script name');
    await expect(service.saveScript('foo/bar.sh', 'rm -rf /')).rejects.toThrow('Invalid script name');
    await expect(service.getScript('../../etc/passwd')).rejects.toThrow('Invalid script name');
    await expect(service.deleteScript('../evil.sh')).rejects.toThrow('Invalid script name');
  });

  it('rejects script content exceeding 1MB limit', async () => {
    const largeContent = 'a'.repeat(1024 * 1024 + 1);
    await expect(service.saveScript('big.sh', largeContent)).rejects.toThrow('exceeds 1MB limit');
  });

  it('deletes existing script successfully', async () => {
    await service.saveScript('to-del.sh', 'echo 1');
    expect(await service.listScripts()).toHaveLength(1);
    await service.deleteScript('to-del.sh');
    expect(await service.listScripts()).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/scriptService.test.ts --detectOpenHandles`
Expected: FAIL with "Cannot find module '../src/server/modules/scripts/scriptService'"

- [x] **Step 3: Implement ScriptService**

Create `src/server/modules/scripts/scriptService.ts`:
```ts
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
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/scriptService.test.ts --detectOpenHandles`
Expected: PASS (all tests green)

- [x] **Step 5: Commit**

```bash
git add src/server/modules/scripts/scriptService.ts tests/scriptService.test.ts
git commit -m "feat(server): implement scriptService with metadata parsing and path traversal validation

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: REST API Routes for Scripts Management

**Files:**
- Create: `src/server/modules/scripts/scriptRoutes.ts`
- Modify: `src/server/app.ts:1-25`
- Test: `tests/scriptRoutes.test.ts`

**Interfaces:**
- Consumes: `ScriptService` from `src/server/modules/scripts/scriptService.ts`, `adminAuthMiddleware` from `src/server/middlewares/adminAuth.ts`.
- Produces: Router mounted at `/api/admin/scripts` (and `/api/scripts`).

- [x] **Step 1: Write the failing tests for scriptRoutes**

Create `tests/scriptRoutes.test.ts`:
```ts
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createScriptRouter } from '../src/server/modules/scripts/scriptRoutes';
import { ScriptService } from '../src/server/modules/scripts/scriptService';
import config from '../config/default';

describe('Script Routes (/api/admin/scripts)', () => {
  let tempDir: string;
  let service: ScriptService;
  let app: express.Express;
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    config.adminSecretKey = 'test-secret-key';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-routes-test-'));
    service = new ScriptService(tempDir);
    app = express();
    app.use(express.json());
    app.use('/api/admin/scripts', createScriptRouter(service));
  });

  afterEach(() => {
    config.adminSecretKey = originalKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unauthorized requests when adminSecretKey is set', async () => {
    const res = await request(app).get('/api/admin/scripts');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/scripts returns script list when authorized', async () => {
    await service.saveScript('test.sh', '# @title: Test\necho 1');
    const res = await request(app)
      .get('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('test.sh');
  });

  it('POST /api/admin/scripts creates a new script', async () => {
    const res = await request(app)
      .post('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key')
      .send({
        name: 'hello.sh',
        content: '#!/usr/bin/env bash\necho "hello"',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('hello.sh');
  });

  it('GET /api/admin/scripts/:name returns script detail and content', async () => {
    await service.saveScript('run.sh', 'echo "run"');
    const res = await request(app)
      .get('/api/admin/scripts/run.sh')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.content).toBe('echo "run"');
  });

  it('PUT /api/admin/scripts/:name updates existing script', async () => {
    await service.saveScript('update.sh', 'echo "old"');
    const res = await request(app)
      .put('/api/admin/scripts/update.sh')
      .set('x-admin-key', 'test-secret-key')
      .send({ content: 'echo "new"' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const detail = await service.getScript('update.sh');
    expect(detail.content).toBe('echo "new"');
  });

  it('DELETE /api/admin/scripts/:name removes script', async () => {
    await service.saveScript('del.sh', 'echo "del"');
    const res = await request(app)
      .delete('/api/admin/scripts/del.sh')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await service.listScripts()).toHaveLength(0);
  });

  it('returns 400 when invalid name or path traversal attempted', async () => {
    const res = await request(app)
      .post('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key')
      .send({ name: '../bad.sh', content: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/scriptRoutes.test.ts --detectOpenHandles`
Expected: FAIL with "Cannot find module '../src/server/modules/scripts/scriptRoutes'"

- [x] **Step 3: Implement scriptRoutes and mount in app.ts**

Create `src/server/modules/scripts/scriptRoutes.ts`:
```ts
import { Router, Request, Response } from 'express';
import { ScriptService, scriptService as defaultService } from './scriptService';
import adminAuthMiddleware from '../../middlewares/adminAuth';

export function createScriptRouter(service: ScriptService = defaultService): Router {
  const router = Router();

  router.use(adminAuthMiddleware);

  // List all scripts
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await service.listScripts();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to list scripts' });
    }
  });

  // Get script detail
  router.get('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await service.getScript(req.params.name);
      res.json({ success: true, data });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ success: false, error: err.message || 'Failed to get script' });
    }
  });

  // Create new script
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, content } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, error: 'Script name is required' });
        return;
      }
      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Script content must be a string' });
        return;
      }
      const data = await service.saveScript(name.trim(), content);
      res.status(201).json({ success: true, data });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to create script' });
    }
  });

  // Update script
  router.put('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Script content must be a string' });
        return;
      }
      const data = await service.saveScript(req.params.name, content);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to update script' });
    }
  });

  // Delete script
  router.delete('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      await service.deleteScript(req.params.name);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to delete script' });
    }
  });

  return router;
}

export default createScriptRouter();
```

Modify `src/server/app.ts`:
Mount `/api/admin/scripts` and `/api/scripts`:
```ts
import scriptRoutes from './modules/scripts/scriptRoutes';
// ...
app.use('/api/admin/scripts', scriptRoutes);
app.use('/api/scripts', scriptRoutes);
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/scriptRoutes.test.ts --detectOpenHandles`
Expected: PASS (all tests green)

- [x] **Step 5: Commit**

```bash
git add src/server/modules/scripts/scriptRoutes.ts src/server/app.ts tests/scriptRoutes.test.ts
git commit -m "feat(server): expose /api/admin/scripts CRUD endpoints

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Terminal Script Execution Wrapper & Base64 Encoder Utility

**Files:**
- Create: `frontend/src/utils/terminalScriptExecutor.ts`
- Test: `tests/terminalScriptExecutor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function encodeScriptToBase64(content: string): string;
  export function generateScriptExecutionCommand(content: string, interpreter?: string): string;
  ```

- [x] **Step 1: Write the failing tests for terminalScriptExecutor**

Create `tests/terminalScriptExecutor.test.ts`:
```ts
import {
  encodeScriptToBase64,
  generateScriptExecutionCommand,
} from '../frontend/src/utils/terminalScriptExecutor';

describe('terminalScriptExecutor', () => {
  it('correctly encodes multi-byte UTF-8 strings into Base64', () => {
    const text = 'echo "你好，世界！🚀"';
    const b64 = encodeScriptToBase64(text);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(decoded).toBe(text);
  });

  it('correctly handles special characters, quotes, and backticks', () => {
    const text = 'VAR="test"\necho `$VAR`\necho \'single\'\necho "double"';
    const b64 = encodeScriptToBase64(text);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(decoded).toBe(text);
  });

  it('generates bash-c evaluation command by default', () => {
    const script = 'echo "hello"';
    const cmd = generateScriptExecutionCommand(script);
    expect(cmd).toMatch(/^bash -c "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });

  it('generates python3 -c command when interpreter is python3', () => {
    const script = 'print("hello")';
    const cmd = generateScriptExecutionCommand(script, 'python3');
    expect(cmd).toMatch(/^python3 -c "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });

  it('generates node -e command when interpreter is node', () => {
    const script = 'console.log("hello")';
    const cmd = generateScriptExecutionCommand(script, 'node');
    expect(cmd).toMatch(/^node -e "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalScriptExecutor.test.ts --detectOpenHandles`
Expected: FAIL with "Cannot find module '../frontend/src/utils/terminalScriptExecutor'"

- [x] **Step 3: Implement terminalScriptExecutor**

Create `frontend/src/utils/terminalScriptExecutor.ts`:
```ts
/**
 * Safely encodes a UTF-8 string to Base64 in both browser and Node.js environments.
 */
export function encodeScriptToBase64(content: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(content, 'utf-8').toString('base64');
  }
  // Browser standard UTF-8 Base64 conversion
  return window.btoa(unescape(encodeURIComponent(content)));
}

/**
 * Generates an isolated single-line execution command for the terminal PTY.
 * Avoids stdin piping so that interactive prompts (sudo, read -p) continue to work properly.
 */
export function generateScriptExecutionCommand(content: string, interpreter?: string): string {
  const base64Str = encodeScriptToBase64(content);
  const normalizedInterp = (interpreter || 'bash').trim().toLowerCase();

  if (normalizedInterp === 'python' || normalizedInterp === 'python3') {
    return `python3 -c "$(echo '${base64Str}' | base64 -d)"`;
  }

  if (normalizedInterp === 'node' || normalizedInterp === 'nodejs') {
    return `node -e "$(echo '${base64Str}' | base64 -d)"`;
  }

  return `bash -c "$(echo '${base64Str}' | base64 -d)"`;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalScriptExecutor.test.ts --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScriptExecutor.ts tests/terminalScriptExecutor.test.ts
git commit -m "feat(frontend): add terminalScriptExecutor for base64 command encapsulation

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Frontend i18n Localization for Script Management

**Files:**
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Test: `tests/frontendI18nScripts.test.ts`

- [x] **Step 1: Write test verifying i18n keys exist in both locales**

Create `tests/frontendI18nScripts.test.ts`:
```ts
import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('i18n scripts keys', () => {
  const requiredKeys = [
    'scripts.title',
    'scripts.searchPlaceholder',
    'scripts.newScript',
    'scripts.runInTerminal',
    'scripts.notConnected',
    'scripts.emptyTitle',
    'scripts.emptyDesc',
    'scripts.deleteConfirm',
    'scripts.saveSuccess',
    'scripts.saveError',
    'scripts.edit',
    'scripts.preview',
    'scripts.namePlaceholder',
  ];

  it('contains all required keys in Chinese and English locales', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/frontendI18nScripts.test.ts --detectOpenHandles`
Expected: FAIL (keys not defined)

- [x] **Step 3: Update `zh.ts` and `en.ts`**

Add to `frontend/src/i18n/locales/zh.ts`:
```ts
  'scripts.title': '常用脚本库',
  'scripts.searchPlaceholder': '搜索脚本名称、描述或标签...',
  'scripts.newScript': '新建脚本',
  'scripts.runInTerminal': '执行到当前终端',
  'scripts.notConnected': '终端未连接，无法下发执行',
  'scripts.emptyTitle': '暂无脚本',
  'scripts.emptyDesc': '点击新建脚本或在服务端 ~/.gt/scripts/ 添加脚本',
  'scripts.deleteConfirm': '确定要删除该脚本吗？此操作无法撤销。',
  'scripts.saveSuccess': '脚本保存成功',
  'scripts.saveError': '保存脚本失败',
  'scripts.edit': '编辑',
  'scripts.preview': '预览',
  'scripts.namePlaceholder': '请输入脚本文件名 (例如: check-disk.sh)',
```

Add to `frontend/src/i18n/locales/en.ts`:
```ts
  'scripts.title': 'Script Library',
  'scripts.searchPlaceholder': 'Search scripts by name, description or tag...',
  'scripts.newScript': 'New Script',
  'scripts.runInTerminal': 'Run in Terminal',
  'scripts.notConnected': 'Terminal is disconnected, cannot dispatch',
  'scripts.emptyTitle': 'No Scripts Found',
  'scripts.emptyDesc': 'Click New Script or add scripts to ~/.gt/scripts/ on server',
  'scripts.deleteConfirm': 'Are you sure you want to delete this script? This cannot be undone.',
  'scripts.saveSuccess': 'Script saved successfully',
  'scripts.saveError': 'Failed to save script',
  'scripts.edit': 'Edit',
  'scripts.preview': 'Preview',
  'scripts.namePlaceholder': 'Enter script filename (e.g., check-disk.sh)',
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/frontendI18nScripts.test.ts --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts tests/frontendI18nScripts.test.ts
git commit -m "feat(i18n): add script management translations for zh and en

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: TerminalScriptDrawer Component

**Files:**
- Create: `frontend/src/components/terminal/TerminalScriptDrawer.tsx`
- Test: `tests/terminalScriptDrawer.test.tsx`

**Interfaces:**
- Consumes:
  `apiFetch` from `../../utils/apiClient`
  `generateScriptExecutionCommand` from `../../utils/terminalScriptExecutor`
  `useTranslation` from `../../i18n/LanguageContext`
- Produces:
  `TerminalScriptDrawer` React Component with props:
  ```ts
  export interface TerminalScriptDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    onExecute: (command: string) => void;
    isConnected: boolean;
    activeHostTitle?: string;
    adminKey?: string;
  }
  ```

- [x] **Step 1: Write component unit test**

Create `tests/terminalScriptDrawer.test.tsx`:
```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalScriptDrawer } from '../frontend/src/components/terminal/TerminalScriptDrawer';
import * as apiClient from '../frontend/src/utils/apiClient';

describe('TerminalScriptDrawer', () => {
  const mockScripts = [
    {
      name: 'cleanup.sh',
      title: '清理日志',
      description: '清除系统多余缓存与日志',
      interpreter: 'bash',
      size: 100,
      updatedAt: '2026-10-13T00:00:00.000Z',
    },
  ];

  beforeEach(() => {
    jest.spyOn(apiClient, 'apiFetch').mockImplementation((url: any) => {
      if (typeof url === 'string' && url.endsWith('/cleanup.sh')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              name: 'cleanup.sh',
              title: '清理日志',
              description: '清除系统多余缓存与日志',
              interpreter: 'bash',
              content: 'echo "cleaning"',
            },
          }),
        } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: mockScripts }),
      } as any);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders drawer when isOpen is true and loads scripts', async () => {
    render(
      <TerminalScriptDrawer
        isOpen={true}
        onClose={jest.fn()}
        onExecute={jest.fn()}
        isConnected={true}
        activeHostTitle="Node-01"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('清理日志')).toBeInTheDocument();
    });
  });

  it('disables execute button when isConnected is false', async () => {
    render(
      <TerminalScriptDrawer
        isOpen={true}
        onClose={jest.fn()}
        onExecute={jest.fn()}
        isConnected={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('清理日志')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('清理日志'));

    await waitFor(() => {
      const executeBtn = screen.getByTestId('execute-script-btn');
      expect(executeBtn).toBeDisabled();
    });
  });

  it('triggers onExecute with wrapped command when execute clicked', async () => {
    const onExecuteMock = jest.fn();
    render(
      <TerminalScriptDrawer
        isOpen={true}
        onClose={jest.fn()}
        onExecute={onExecuteMock}
        isConnected={true}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('清理日志')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('清理日志'));

    await waitFor(() => {
      const executeBtn = screen.getByTestId('execute-script-btn');
      expect(executeBtn).not.toBeDisabled();
      fireEvent.click(executeBtn);
    });

    expect(onExecuteMock).toHaveBeenCalledWith(
      expect.stringContaining('bash -c')
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalScriptDrawer.test.tsx --detectOpenHandles`
Expected: FAIL with "Cannot find module '../frontend/src/components/terminal/TerminalScriptDrawer'"

- [x] **Step 3: Implement TerminalScriptDrawer**

Create `frontend/src/components/terminal/TerminalScriptDrawer.tsx`:
```tsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  Play,
  Plus,
  Trash2,
  Save,
  Search,
  Code2,
  FileCode,
  AlertCircle,
  Check,
  Edit3,
  Eye,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { apiFetch } from '../../utils/apiClient';
import { generateScriptExecutionCommand } from '../../utils/terminalScriptExecutor';

export interface ScriptItem {
  name: string;
  title: string;
  description: string;
  interpreter: string;
  size: number;
  updatedAt: string;
}

export interface TerminalScriptDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onExecute: (command: string) => void;
  isConnected: boolean;
  activeHostTitle?: string;
  adminKey?: string;
}

export const TerminalScriptDrawer: React.FC<TerminalScriptDrawerProps> = ({
  isOpen,
  onClose,
  onExecute,
  isConnected,
  activeHostTitle,
  adminKey,
}) => {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedScriptName, setSelectedScriptName] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string>('');
  const [currentMeta, setCurrentMeta] = useState<ScriptItem | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (adminKey) {
      headers['x-admin-key'] = adminKey;
    }
    return headers;
  }, [adminKey]);

  const loadScripts = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/admin/scripts', { headers: authHeaders });
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setScripts(json.data);
        if (json.data.length > 0 && !selectedScriptName) {
          setSelectedScriptName(json.data[0].name);
        }
      }
    } catch {
      setStatusMessage({ text: t('scripts.saveError', '获取脚本列表失败'), type: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [authHeaders, selectedScriptName, t]);

  useEffect(() => {
    if (isOpen) {
      loadScripts();
    }
  }, [isOpen, loadScripts]);

  useEffect(() => {
    if (!selectedScriptName || isCreating) return;
    let isCancelled = false;

    async function fetchDetail() {
      try {
        const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName!)}`, {
          headers: authHeaders,
        });
        const json = await res.json();
        if (!isCancelled && json.success && json.data) {
          setCurrentContent(json.data.content || '');
          setCurrentMeta(json.data);
          setIsEditing(false);
        }
      } catch {
        if (!isCancelled) {
          setStatusMessage({ text: '加载脚本详情失败', type: 'error' });
        }
      }
    }

    fetchDetail();
    return () => {
      isCancelled = true;
    };
  }, [selectedScriptName, isCreating, authHeaders]);

  const filteredScripts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q))
    );
  }, [scripts, searchQuery]);

  const handleStartCreate = () => {
    setIsCreating(true);
    setSelectedScriptName(null);
    setNewFileName('');
    setCurrentContent('#!/usr/bin/env bash\n# @title: 新脚本\n# @description: 描述信息\n\necho "Hello World"\n');
    setCurrentMeta(null);
    setIsEditing(true);
  };

  const handleSave = async () => {
    setStatusMessage(null);
    try {
      if (isCreating) {
        if (!newFileName.trim()) {
          setStatusMessage({ text: '请输入脚本文件名', type: 'error' });
          return;
        }
        const res = await apiFetch('/api/admin/scripts', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newFileName.trim(), content: currentContent }),
        });
        const json = await res.json();
        if (json.success) {
          setIsCreating(false);
          setSelectedScriptName(newFileName.trim());
          setIsEditing(false);
          await loadScripts();
          setStatusMessage({ text: t('scripts.saveSuccess', '脚本保存成功'), type: 'success' });
        } else {
          setStatusMessage({ text: json.error || t('scripts.saveError', '保存失败'), type: 'error' });
        }
      } else if (selectedScriptName) {
        const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName)}`, {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: currentContent }),
        });
        const json = await res.json();
        if (json.success) {
          setIsEditing(false);
          await loadScripts();
          setStatusMessage({ text: t('scripts.saveSuccess', '脚本保存成功'), type: 'success' });
        } else {
          setStatusMessage({ text: json.error || t('scripts.saveError', '保存失败'), type: 'error' });
        }
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || t('scripts.saveError', '保存失败'), type: 'error' });
    }
  };

  const handleDelete = async () => {
    if (!selectedScriptName) return;
    if (!window.confirm(t('scripts.deleteConfirm', '确定要删除该脚本吗？'))) return;

    try {
      const res = await apiFetch(`/api/admin/scripts/${encodeURIComponent(selectedScriptName)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      const json = await res.json();
      if (json.success) {
        setSelectedScriptName(null);
        setCurrentContent('');
        await loadScripts();
      }
    } catch {
      setStatusMessage({ text: '删除失败', type: 'error' });
    }
  };

  const handleExecute = () => {
    if (!isConnected || !currentContent) return;
    const interp = currentMeta?.interpreter || 'bash';
    const command = generateScriptExecutionCommand(currentContent, interp);
    onExecute(command);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-2xl h-full bg-[var(--bg-surface-sub,#18181b)] border-l border-[var(--border-subtle,#27272a)] flex flex-col shadow-2xl text-slate-200">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--border-subtle,#27272a)] flex items-center justify-between shrink-0 bg-white/[0.02]">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <FileCode className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-semibold text-white tracking-wide">
              {t('scripts.title', '常用脚本库')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status Alert */}
        {statusMessage && (
          <div
            className={`px-4 py-2 text-xs flex items-center justify-between ${
              statusMessage.type === 'success'
                ? 'bg-emerald-500/15 text-emerald-400 border-b border-emerald-500/20'
                : 'bg-rose-500/15 text-rose-400 border-b border-rose-500/20'
            }`}
          >
            <span className="flex items-center space-x-1.5">
              {statusMessage.type === 'success' ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span>{statusMessage.text}</span>
            </span>
            <button type="button" onClick={() => setStatusMessage(null)} className="opacity-70 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Content Body: Split Left & Right */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Scripts list */}
          <div className="w-56 sm:w-64 border-r border-[var(--border-subtle,#27272a)] flex flex-col shrink-0 bg-black/20">
            {/* Search & New */}
            <div className="p-2.5 border-b border-[var(--border-subtle,#27272a)] space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder={t('scripts.searchPlaceholder', '搜索脚本...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
                />
              </div>
              <button
                type="button"
                onClick={handleStartCreate}
                className="w-full flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('scripts.newScript', '新建脚本')}</span>
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
              {isLoading && scripts.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">加载中...</div>
              ) : filteredScripts.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  {t('scripts.emptyTitle', '暂无脚本')}
                </div>
              ) : (
                filteredScripts.map((item) => {
                  const isSelected = !isCreating && selectedScriptName === item.name;
                  return (
                    <button
                      type="button"
                      key={item.name}
                      onClick={() => {
                        setIsCreating(false);
                        setSelectedScriptName(item.name);
                      }}
                      className={`w-full text-left p-2.5 transition-colors flex flex-col space-y-1 ${
                        isSelected
                          ? 'bg-indigo-600/15 border-l-2 border-indigo-500 text-white'
                          : 'hover:bg-white/[0.04] text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium truncate">{item.title || item.name}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded-sm bg-white/[0.08] text-slate-400 font-mono">
                          {item.interpreter || 'sh'}
                        </span>
                      </div>
                      {item.description && (
                        <p className="text-[11px] text-slate-400 line-clamp-1">{item.description}</p>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Detail / Preview / Edit */}
          <div className="flex-1 flex flex-col overflow-hidden bg-black/10">
            {/* Meta bar */}
            <div className="px-4 py-2 border-b border-[var(--border-subtle,#27272a)] flex items-center justify-between shrink-0 bg-white/[0.01]">
              <div className="min-w-0 flex-1">
                {isCreating ? (
                  <input
                    type="text"
                    placeholder={t('scripts.namePlaceholder', '脚本文件名 (如: test.sh)')}
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="w-full bg-white/[0.05] border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-hidden focus:border-indigo-500"
                  />
                ) : (
                  <div className="flex items-center space-x-2">
                    <Code2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span className="text-xs font-mono font-medium text-white truncate">
                      {selectedScriptName || '未选择脚本'}
                    </span>
                  </div>
                )}
              </div>

              {!isCreating && selectedScriptName && (
                <div className="flex items-center space-x-1 ml-2">
                  <button
                    type="button"
                    onClick={() => setIsEditing(!isEditing)}
                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 hover:text-white text-xs flex items-center space-x-1"
                  >
                    {isEditing ? <Eye className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                    <span>{isEditing ? t('scripts.preview', '预览') : t('scripts.edit', '编辑')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="p-1 rounded text-rose-400 hover:bg-rose-500/10 transition-colors"
                    title="删除脚本"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Editor / Viewer area */}
            <div className="flex-1 p-3 overflow-hidden flex flex-col">
              {isEditing || isCreating ? (
                <textarea
                  value={currentContent}
                  onChange={(e) => setCurrentContent(e.target.value)}
                  className="w-full h-full bg-[#121214] border border-white/[0.08] rounded-lg p-3 text-xs font-mono text-slate-200 resize-none focus:outline-hidden focus:border-indigo-500 leading-relaxed"
                  spellCheck={false}
                />
              ) : (
                <pre className="w-full h-full bg-[#121214] border border-white/[0.08] rounded-lg p-3 text-xs font-mono text-slate-200 overflow-auto whitespace-pre leading-relaxed select-text">
                  {currentContent || '# 空内容'}
                </pre>
              )}
            </div>

            {/* Footer Action Bar */}
            <div className="p-3 border-t border-[var(--border-subtle,#27272a)] bg-white/[0.02] flex items-center justify-between shrink-0">
              <div>
                {(isEditing || isCreating) && (
                  <button
                    type="button"
                    onClick={handleSave}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>保存</span>
                  </button>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  data-testid="execute-script-btn"
                  onClick={handleExecute}
                  disabled={!isConnected || !currentContent}
                  title={!isConnected ? t('scripts.notConnected', '终端未连接') : undefined}
                  className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    isConnected && currentContent
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm active:scale-95'
                      : 'bg-white/[0.05] text-slate-500 cursor-not-allowed border border-white/[0.05]'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {t('scripts.runInTerminal', '执行到当前终端')}
                    {activeHostTitle ? ` (${activeHostTitle})` : ''}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TerminalScriptDrawer;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalScriptDrawer.test.tsx --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalScriptDrawer.tsx tests/terminalScriptDrawer.test.tsx
git commit -m "feat(frontend): implement TerminalScriptDrawer component

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Integrate Script Drawer in WebTerminalView

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Test: `tests/terminalScriptIntegration.test.tsx`

**Interfaces:**
- Consumes: `TerminalScriptDrawer` component.
- Produces: Header toolbar button and execution handler routing into `sendInput(command + '\r')`.

- [x] **Step 1: Write integration test**

Create `tests/terminalScriptIntegration.test.tsx`:
```tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WebTerminalView } from '../frontend/src/components/WebTerminalView';

jest.mock('../frontend/src/components/terminal/hooks/useTerminalWebSocket', () => ({
  useTerminalWebSocket: () => ({
    isConnected: true,
    isConnecting: false,
    sendInput: jest.fn(),
    sendResize: jest.fn(),
    reconnect: jest.fn(),
  }),
}));

describe('WebTerminalView Script Integration', () => {
  it('renders script library button in toolbar and toggles drawer', () => {
    render(
      <WebTerminalView
        adminKey="test"
        activeHostId="host-1"
        hosts={[{ hostId: 'host-1', name: 'Host 1' } as any]}
      />
    );

    const scriptBtn = screen.getByTestId('open-scripts-btn');
    expect(scriptBtn).toBeInTheDocument();

    fireEvent.click(scriptBtn);
    expect(screen.getByText(/常用脚本库|Script Library/)).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalScriptIntegration.test.tsx --detectOpenHandles`
Expected: FAIL (button with testid open-scripts-btn not found)

- [x] **Step 3: Update WebTerminalView.tsx**

1. Import `TerminalScriptDrawer` and `ScrollText` (or `FileCode`).
2. Add state `const [isScriptDrawerOpen, setIsScriptDrawerOpen] = useState<boolean>(false);`.
3. In Header Action Buttons, add:
   ```tsx
   <button
     type="button"
     data-testid="open-scripts-btn"
     onClick={() => setIsScriptDrawerOpen(true)}
     className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white border border-white/[0.06] transition-all flex items-center space-x-1 text-xs"
     title={t('scripts.title', '常用脚本库')}
   >
     <ScrollText className="w-3.5 h-3.5 text-indigo-400" />
     <span className="hidden md:inline font-sans text-[11px]">{t('scripts.title', '常用脚本库')}</span>
   </button>
   ```
4. Handle script execution:
   ```tsx
   const handleExecuteScript = useCallback((command: string) => {
     sendInput(command + '\r', true);
     terminalRef.current?.focus();
   }, [sendInput]);
   ```
5. Render `<TerminalScriptDrawer ... />` at the bottom of the container.

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalScriptIntegration.test.tsx --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalScriptIntegration.test.tsx
git commit -m "feat(frontend): integrate TerminalScriptDrawer into WebTerminalView

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Full System Verification & Build Check

**Files:**
- Test all: backend tests, frontend tests, project build.

- [x] **Step 1: Run full test suite**

Run: `npm test`
Expected: All test suites PASS without broken dependencies.

- [x] **Step 2: Run frontend and backend builds**

Run: `npm run build`
Expected: Successful compile of backend and frontend without errors.

- [x] **Step 3: Commit any lingering build or config assets**

```bash
git commit -m "chore: verify full test suite and production build

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
