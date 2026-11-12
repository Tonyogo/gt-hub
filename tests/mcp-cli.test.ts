import { PassThrough } from 'stream';
import http from 'http';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { handleMcpCommand } from '../src/client/commands/mcp';
import { createProgram } from '../src/client/index';

describe('CLI gt mcp Stdio & RestApiClientAdapter', () => {
  let server: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  test('createProgram registers mcp command with expected flags', () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === 'mcp');
    expect(mcpCmd).toBeDefined();
    const optionFlags = mcpCmd!.options.map((o) => o.long);
    expect(optionFlags).toEqual(
      expect.arrayContaining(['--read-only', '--nodes', '--max-output', '--server', '--key', '--context'])
    );
  });

  test('processes newline-delimited JSON-RPC over stdio, ignores blank lines, and handles parse errors without crashing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines: string[] = [];

    output.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) outputLines.push(line.trim());
      }
    });

    const sessionPromise = handleMcpCommand({
      server: serverUrl,
      key: config.adminSecretKey,
      readOnly: true,
      input,
      output,
    });

    // 1. Blank line (should be ignored)
    input.write('\n   \n');
    // 2. Malformed JSON (should emit -32700 parse error and continue)
    input.write('{bad json\n');
    // 3. Notification (should produce no output)
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    // 4. Call gt_list_nodes over RestApiClientAdapter
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'gt_list_nodes', arguments: { all: true } },
      }) + '\n'
    );
    input.end();

    await sessionPromise;

    expect(outputLines).toHaveLength(2);
    const errFrame = JSON.parse(outputLines[0]);
    expect(errFrame.error.code).toBe(-32700);

    const nodesFrame = JSON.parse(outputLines[1]);
    expect(nodesFrame.id).toBe(42);
    expect(nodesFrame.result.isError).toBe(false);
    const parsedContent = JSON.parse(nodesFrame.result.content[0].text);
    expect(parsedContent.success).toBe(true);
    expect(Array.isArray(parsedContent.nodes)).toBe(true);
  });
});
