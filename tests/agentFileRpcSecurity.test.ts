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
});
