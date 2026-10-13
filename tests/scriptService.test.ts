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
