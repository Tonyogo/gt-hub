import readline from 'readline';
import { McpEngine } from '../../shared/mcp/server';
import {
  McpBackendAdapter,
  McpHostEntry,
  McpSecurityPolicy,
} from '../../shared/mcp/types';
import { makeRequest } from '../utils/terminalUI';

export class RestApiClientAdapter implements McpBackendAdapter {
  constructor(private serverUrl: string, private apiKey: string) {}

  private async req(endpoint: string, method: string = 'GET', body: any = null): Promise<any> {
    const res = await makeRequest({
      serverUrl: this.serverUrl,
      endpoint,
      method,
      body,
      apiKey: this.apiKey,
    });
    return res.data;
  }

  // 1. Cluster Nodes
  public async listNodes(): Promise<McpHostEntry[]> {
    const res = await this.req('/api/terminal/hosts');
    const hosts = Array.isArray(res?.hosts) ? res.hosts : [];
    return hosts.map((h: any) => ({
      id: h.id,
      name: h.name,
      hostname: h.hostname,
      ip: h.ip,
      platform: h.platform,
      status: h.status,
      online: h.status === 'online',
      lastSeen: h.lastSeen,
      type: h.type,
      version: h.version,
    }));
  }

  // 2. Command & Task Execution
  public async startExec(
    hostId: string,
    opts: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      waitMs?: number;
      env?: Record<string, string>;
      stdin?: string;
    }
  ): Promise<any> {
    return this.req(`/api/terminal/exec/${encodeURIComponent(hostId)}`, 'POST', opts);
  }

  public async getExecStatus(hostId: string, taskId: string, offset?: number): Promise<any> {
    const query = offset !== undefined ? `?offset=${encodeURIComponent(offset)}` : '';
    return this.req(
      `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}${query}`,
      'GET'
    );
  }

  public async killExec(hostId: string, taskId: string, signal?: string): Promise<any> {
    return this.req(
      `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}/kill`,
      'POST',
      { signal: signal ?? 'SIGTERM' }
    );
  }

  public async listExec(hostId: string, limit?: number): Promise<any> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(limit)}` : '';
    return this.req(`/api/terminal/exec/${encodeURIComponent(hostId)}${query}`, 'GET');
  }

  // 3. Remote File Management
  public async listFiles(hostId: string, targetPath?: string): Promise<any> {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/list${query}`, 'GET');
  }

  public async readFileContent(hostId: string, targetPath: string): Promise<any> {
    const query = `?path=${encodeURIComponent(targetPath)}`;
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/content${query}`, 'GET');
  }

  public async saveFileContent(hostId: string, targetPath: string, content: string): Promise<any> {
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/save`, 'POST', {
      path: targetPath,
      content,
    });
  }

  public async createDirectory(hostId: string, parentPath: string, dirName: string): Promise<any> {
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/mkdir`, 'POST', {
      path: parentPath,
      dirName,
    });
  }

  public async deleteItem(hostId: string, targetPath: string): Promise<any> {
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/delete`, 'DELETE', {
      path: targetPath,
    });
  }

  public async renameFile(hostId: string, oldPath: string, newPath: string): Promise<any> {
    return this.req(`/api/terminal/files/${encodeURIComponent(hostId)}/rename`, 'POST', {
      oldPath,
      newPath,
    });
  }

  // 4. Distributed Cron Management
  public async listCronJobs(hostId: string): Promise<any> {
    return this.req(`/api/terminal/cron/${encodeURIComponent(hostId)}`, 'GET');
  }

  public async addCronJob(hostId: string, body: Record<string, any>): Promise<any> {
    return this.req(`/api/terminal/cron/${encodeURIComponent(hostId)}`, 'POST', body);
  }

  public async updateCronJob(hostId: string, jobId: string, body: Record<string, any>): Promise<any> {
    return this.req(
      `/api/terminal/cron/${encodeURIComponent(hostId)}/${encodeURIComponent(jobId)}`,
      'PATCH',
      body
    );
  }

  public async deleteCronJob(hostId: string, jobId: string): Promise<any> {
    return this.req(
      `/api/terminal/cron/${encodeURIComponent(hostId)}/${encodeURIComponent(jobId)}`,
      'DELETE'
    );
  }

  public async triggerCronJob(hostId: string, jobId: string): Promise<any> {
    return this.req(
      `/api/terminal/cron/${encodeURIComponent(hostId)}/${encodeURIComponent(jobId)}/run`,
      'POST'
    );
  }

  public async getCronJobLogs(hostId: string, jobId: string, offset?: number): Promise<any> {
    const query = offset !== undefined ? `?offset=${encodeURIComponent(offset)}` : '';
    return this.req(
      `/api/terminal/cron/${encodeURIComponent(hostId)}/${encodeURIComponent(jobId)}/logs${query}`,
      'GET'
    );
  }
}

export async function attachMcpStdioTransport(
  engine: McpEngine,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<void> {
  const rl = readline.createInterface({
    input,
    output: undefined,
    terminal: false,
  });

  for await (const line of rl) {
    try {
      const responseText = await engine.handleRawLine(line);
      if (responseText !== null) {
        output.write(responseText + '\n');
      }
    } catch (err: any) {
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: err?.message || 'Internal error',
          },
        }) + '\n'
      );
    }
  }
}

export async function handleMcpCommand(opts: {
  server: string;
  key: string;
  readOnly?: boolean;
  nodes?: string[];
  maxOutputChars?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;

  const isDefaultStdout = output === process.stdout;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  if (isDefaultStdout) {
    console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.info = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.warn = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
  }

  const adapter = new RestApiClientAdapter(opts.server, opts.key);
  const policy: McpSecurityPolicy = {
    readOnly: opts.readOnly,
    allowedNodes: opts.nodes,
    maxOutputChars: opts.maxOutputChars,
  };
  const engine = new McpEngine(adapter, policy);

  try {
    await attachMcpStdioTransport(engine, input, output);
  } finally {
    if (isDefaultStdout) {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
    }
  }
}
