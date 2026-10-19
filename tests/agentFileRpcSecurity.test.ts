import os from 'os';
import path from 'path';
import { handleFileRpc } from '../src/agent/handlers/fileRpcHandler';

describe('handleFileRpc Security Integration', () => {
  it('rejects read request to sensitive path in default mode', async () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');
    let sentMessage = '';
    const mockWs = {
      readyState: 1,
      send: (msg: string) => { sentMessage = msg; },
    };

    await handleFileRpc({
      reqId: 'test-req-1',
      action: 'read',
      path: sshPath,
      permissionMode: 'default',
    }, mockWs);

    expect(sentMessage).toContain('file_rpc_res');
    const data = JSON.parse(sentMessage.slice(5));
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/SecurityException/i);
  });

  it('permits read request in bypass mode', async () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'non_existent_file_xyz');
    let sentMessage = '';
    const mockWs = {
      readyState: 1,
      send: (msg: string) => { sentMessage = msg; },
    };

    await handleFileRpc({
      reqId: 'test-req-2',
      action: 'read',
      path: sshPath,
      permissionMode: 'bypass',
    }, mockWs);

    const data = JSON.parse(sentMessage.slice(5));
    // Should fail with File not found, NOT SecurityException
    expect(data.error).not.toMatch(/SecurityException/i);
  });

  it('sanitizes filename on upload_chunk preventing directory escape', async () => {
    const fs = await import('fs');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-agent-test-'));
    try {
      let sentMessage = '';
      const mockWs = {
        readyState: 1,
        send: (msg: string) => { sentMessage = msg; },
      };

      // 1. Path traversal filename is stripped to basename
      await handleFileRpc({
        reqId: 'test-req-3',
        action: 'upload_chunk',
        path: tempDir,
        params: {
          filename: '../../safe_escaped.txt',
          data: Buffer.from('chunk content').toString('base64'),
          offset: 0,
        },
        permissionMode: 'bypass',
      }, mockWs);

      const data1 = JSON.parse(sentMessage.slice(5));
      expect(data1.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'safe_escaped.txt'))).toBe(true);
      // Ensure file was not created in parent dir
      expect(fs.existsSync(path.join(tempDir, '..', 'safe_escaped.txt'))).toBe(false);

      // 2. Pure '..' or '.' filename is rejected
      sentMessage = '';
      await handleFileRpc({
        reqId: 'test-req-4',
        action: 'upload_chunk',
        path: tempDir,
        params: {
          filename: '..',
          data: Buffer.from('chunk content').toString('base64'),
          offset: 0,
        },
        permissionMode: 'bypass',
      }, mockWs);

      const data2 = JSON.parse(sentMessage.slice(5));
      expect(data2.success).toBe(false);
      expect(data2.error).toMatch(/Invalid filename/i);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
