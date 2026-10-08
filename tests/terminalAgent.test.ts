import fs from 'fs';
import path from 'path';

describe('Terminal Agent Script', () => {
  const agentPath = path.resolve(__dirname, '../scripts/gt.js');

  test('gt script exists and contains embedded agent capabilities', () => {
    expect(fs.existsSync(agentPath)).toBe(true);
    const content = fs.readFileSync(agentPath, 'utf-8');
    expect(content).toContain('node-pty');
    expect(content).toContain('WebSocket');
    expect(content).toContain('--server');
    expect(content).toContain('--key');
    expect(content).toContain("require('dotenv')");
    expect(content).toContain('[Agent] Loaded .env configuration');
    expect(content).toContain('isFirstSpawn');
    expect(content).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
    expect(content).toContain('sanitizedName');
  });

  test('derives deterministic hostId from name when id is omitted', () => {
    const parseHostId = (options: { id?: string; name?: string }, hostname: string, localIp: string) => {
      const sanitizedName = options.name ? options.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') : '';
      return options.id || (sanitizedName || `${hostname.toLowerCase().replace(/[^a-z0-9-_]/g, '-')}-${localIp.replace(/\./g, '-')}`);
    };

    expect(parseHostId({ name: 'demo' }, 'my-box', '192.168.1.10')).toBe('demo');
    expect(parseHostId({ name: 'Ubuntu GPU Server' }, 'my-box', '192.168.1.10')).toBe('ubuntu-gpu-server');
    expect(parseHostId({ id: 'explicit-id', name: 'demo' }, 'my-box', '192.168.1.10')).toBe('explicit-id');
    expect(parseHostId({}, 'my-box', '192.168.1.10')).toBe('my-box-192-168-1-10');
  });

  test('package.json includes gt script and removes deprecated scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
    expect(pkg.scripts['gt']).toBe('node scripts/gt.js');
    expect(pkg.scripts['gt:rs']).toBeUndefined();
    expect(pkg.scripts['build:agent']).toBeUndefined();
    expect(pkg.scripts['terminal-agent']).toBeUndefined();
    expect(pkg.scripts['terminal-exec']).toBeUndefined();
    expect(pkg.scripts['agent:rs']).toBeUndefined();
    expect(pkg.scripts['pm2:start']).toBeUndefined();
    expect(pkg.scripts['pm2:reload']).toBeUndefined();
    expect(pkg.scripts['pm2:stop']).toBeUndefined();
    expect(pkg.scripts['pm2:logs']).toBeUndefined();
  });
});
