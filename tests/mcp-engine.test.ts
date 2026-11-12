import { McpEngine } from '../src/shared/mcp/server';
import { McpBackendAdapter, McpHostEntry } from '../src/shared/mcp/types';

function createMockAdapter(): jest.Mocked<McpBackendAdapter> {
  const hosts: McpHostEntry[] = [
    { id: 'node-1', name: 'web-prod', status: 'online' },
    { id: 'node-2', name: 'db-offline', status: 'offline' },
  ];
  return {
    listNodes: jest.fn().mockResolvedValue(hosts),
    startExec: jest.fn().mockResolvedValue({
      success: true,
      taskId: 'task-100',
      completed: true,
      exitCode: 0,
      output: 'hello world\n',
    }),
    getExecStatus: jest.fn().mockResolvedValue({
      success: true,
      taskId: 'task-100',
      status: 'completed',
      exitCode: 0,
      output: 'chunk-output-data',
      nextOffset: 17,
    }),
    killExec: jest.fn().mockResolvedValue({ success: true, taskId: 'task-100' }),
    listExec: jest.fn().mockResolvedValue({ success: true, tasks: [{ taskId: 'task-100' }] }),
    listFiles: jest.fn().mockResolvedValue({ success: true, currentPath: '/tmp', files: [] }),
    readFileContent: jest.fn().mockResolvedValue({
      success: true,
      path: '/tmp/a.txt',
      content: '0123456789abcdef',
      size: 16,
      isBinary: false,
    }),
    saveFileContent: jest.fn().mockResolvedValue({ success: true }),
    createDirectory: jest.fn().mockResolvedValue({ success: true }),
    deleteItem: jest.fn().mockResolvedValue({ success: true }),
    renameFile: jest.fn().mockResolvedValue({ success: true }),
    listCronJobs: jest.fn().mockResolvedValue({ success: true, data: [] }),
    addCronJob: jest.fn().mockResolvedValue({ success: true, data: { id: 'job-1' } }),
    updateCronJob: jest.fn().mockResolvedValue({ success: true, data: { id: 'job-1', status: 'paused' } }),
    deleteCronJob: jest.fn().mockResolvedValue({ success: true }),
    triggerCronJob: jest.fn().mockResolvedValue({ success: true }),
    getCronJobLogs: jest.fn().mockResolvedValue({ success: true, data: [{ output: 'cron-log-line' }] }),
  };
}

describe('McpEngine JSON-RPC 2.0 Dispatcher', () => {
  test('handles initialize, notifications/initialized, and ping', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const initRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(initRes.result.protocolVersion).toBe('2025-03-26');
    expect(initRes.result.serverInfo.name).toBe('gt-mcp');

    const notifRes = await engine.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notifRes).toBeNull();

    const pingRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 'ping-1',
      method: 'ping',
    });
    expect(pingRes.result).toEqual({});
  });

  test('distinguishes id: null (valid request) from omitted id (notification) and rejects empty batch []', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const nullIdRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: null,
      method: 'ping',
    });
    expect(nullIdRes).toEqual({ jsonrpc: '2.0', id: null, result: {} });

    const emptyBatchRes: any = await engine.handleMessage([]);
    expect(emptyBatchRes.error.code).toBe(-32600);
  });

  test('executes gt_list_nodes (filtering offline by default) and gt_exec with name resolution', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const listOnline: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gt_list_nodes', arguments: {} },
    });
    const parsedOnline = JSON.parse(listOnline.result.content[0].text);
    expect(parsedOnline.nodes).toHaveLength(1);
    expect(parsedOnline.nodes[0].id).toBe('node-1');

    const execCall: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'gt_exec',
        arguments: { node: 'web-prod', command: 'echo hi', detach: true },
      },
    });
    expect(adapter.startExec).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ command: 'echo hi', waitMs: 0 })
    );
    expect(execCall.result.isError).toBe(false);
  });

  test('handles gt_read_file slicing, binary file rejection, and output truncation', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter, { maxOutputChars: 8 });

    const sliceRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'gt_read_file',
        arguments: { node: 'node-1', path: '/tmp/a.txt', offset: 2, limit: 12 },
      },
    });
    const body = JSON.parse(sliceRes.result.content[0].text);
    expect(body.truncated).toBe(true);
    expect(body.nextOffset).toBe(10);
    expect(body.content).toContain('23456789');

    adapter.readFileContent.mockResolvedValueOnce({
      success: true,
      path: '/tmp/bin',
      size: 100,
      isBinary: true,
    });
    const binRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'gt_read_file', arguments: { node: 'node-1', path: '/tmp/bin' } },
    });
    expect(binRes.result.isError).toBe(true);
    expect(binRes.result.content[0].text).toContain('Cannot read binary file as text');
  });

  test('enforces readOnly and allowedNodes guardrails in tools/call', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter, { readOnly: true, allowedNodes: ['web-prod'] });

    const roBlock: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'gt_write_file', arguments: { node: 'web-prod', path: '/a', content: 'x' } },
    });
    expect(roBlock.result.isError).toBe(true);
    expect(roBlock.result.content[0].text).toContain('disabled in read-only mode');

    const nodeBlock: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'gt_list_files', arguments: { node: 'db-offline' } },
    });
    expect(nodeBlock.result.isError).toBe(true);
    expect(nodeBlock.result.content[0].text).toContain('not in the allowed nodes list');
  });
});
