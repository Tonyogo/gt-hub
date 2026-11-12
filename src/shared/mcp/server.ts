import {
  JsonRpcResponse,
  McpBackendAdapter,
  McpSecurityPolicy,
  McpToolCallResult,
} from './types';
import { listMcpTools } from './tools';
import {
  checkToolPermission,
  filterAllowedNodes,
  resolveTargetNode,
  truncateText,
} from './guard';
import { getVersionInfo } from '../version';

export class McpEngine {
  constructor(
    private adapter: McpBackendAdapter,
    private policy?: McpSecurityPolicy
  ) {}

  public async handleRawLine(line: string): Promise<string | null> {
    if (!line || line.trim() === '') {
      return null;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      });
    }

    const res = await this.handleMessage(parsed);
    if (res === null) {
      return null;
    }
    return JSON.stringify(res);
  }

  public async handleMessage(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: 'Invalid Request: empty batch',
          },
        };
      }
      const responses = await Promise.all(
        payload.map((item) => this.handleSingleMessage(item))
      );
      const nonNull = responses.filter((r): r is JsonRpcResponse => r !== null);
      return nonNull.length > 0 ? nonNull : null;
    }

    return this.handleSingleMessage(payload);
  }

  private async handleSingleMessage(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: payload must be an object' },
      };
    }

    const raw = msg as Record<string, any>;
    const hasId = Object.prototype.hasOwnProperty.call(raw, 'id');
    const id = hasId ? raw.id : undefined;
    const isNotification = !hasId;

    if (raw.jsonrpc !== '2.0') {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    if (typeof raw.method !== 'string' || !raw.method) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32600, message: 'Invalid Request: method is required' },
      };
    }

    const method = raw.method;

    if (method.startsWith('notifications/')) {
      return null;
    }

    if (isNotification) {
      return null;
    }

    switch (method) {
      case 'initialize': {
        const protocolVersion = raw.params?.protocolVersion || '2024-11-05';
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: 'gt-mcp',
              version: getVersionInfo().version,
            },
          },
        };
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {},
        };
      }

      case 'tools/list': {
        const tools = listMcpTools(this.policy);
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { tools },
        };
      }

      case 'tools/call': {
        const params = raw.params;
        if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32602, message: 'Invalid params: name is required' },
          };
        }
        const callResult = await this.executeToolCall(params.name, params.arguments || {});
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: callResult,
        };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, any>
  ): Promise<McpToolCallResult> {
    const perm = checkToolPermission(name, this.policy);
    if (!perm.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: perm.error }),
          },
        ],
        isError: true,
      };
    }

    try {
      if (name === 'gt_list_nodes') {
        const hosts = await this.adapter.listNodes();
        const permitted = filterAllowedNodes(hosts, this.policy);
        const includeAll = Boolean(args.all);
        const filtered = includeAll
          ? permitted
          : permitted.filter(
              (h) =>
                h.status === 'online' ||
                (h.status !== 'offline' && h.online !== false && h.connected !== false)
            );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, nodes: filtered }, null, 2),
            },
          ],
          isError: false,
        };
      }

      // All remaining tools require a target node
      if (!args.node || typeof args.node !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: 'Parameter "node" is required.' }),
            },
          ],
          isError: true,
        };
      }

      const hosts = await this.adapter.listNodes();
      const resolveRes = resolveTargetNode(args.node, hosts, this.policy);
      if (!resolveRes.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: resolveRes.error }),
            },
          ],
          isError: true,
        };
      }
      const hostId = resolveRes.hostId;

      switch (name) {
        case 'gt_exec': {
          if (!args.command || typeof args.command !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "command" is required.' }),
                },
              ],
              isError: true,
            };
          }
          let waitMs = typeof args.waitMs === 'number' ? args.waitMs : 30000;
          if (args.detach) {
            waitMs = 0;
          }
          const rawRes = await this.adapter.startExec(hostId, {
            command: args.command,
            cwd: args.cwd,
            env: args.env,
            stdin: args.stdin,
            timeoutMs: args.timeoutMs,
            waitMs,
          });

          if (rawRes && typeof rawRes.output === 'string') {
            const trunc = truncateText(rawRes.output, this.policy?.maxOutputChars, 0);
            rawRes.output = trunc.text;
            if (trunc.truncated) {
              rawRes.truncated = true;
              rawRes.totalChars = trunc.totalChars;
              rawRes.nextOffset = trunc.nextOffset;
            }
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_task_list': {
          const limit = typeof args.limit === 'number' ? args.limit : 20;
          const rawRes = await this.adapter.listExec(hostId, limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_task_status': {
          if (!args.taskId || typeof args.taskId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "taskId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const offset =
            typeof args.offset === 'number' && !isNaN(args.offset) && args.offset >= 0
              ? args.offset
              : 0;
          const rawRes = await this.adapter.getExecStatus(hostId, args.taskId, offset);

          if (rawRes && typeof rawRes.output === 'string') {
            const trunc = truncateText(rawRes.output, this.policy?.maxOutputChars, offset);
            rawRes.output = trunc.text;
            if (trunc.truncated) {
              rawRes.truncated = true;
              rawRes.totalChars = trunc.totalChars;
              rawRes.nextOffset = trunc.nextOffset;
            }
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_task_kill': {
          if (!args.taskId || typeof args.taskId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "taskId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.killExec(hostId, args.taskId, args.signal || 'SIGTERM');
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_list_files': {
          const rawRes = await this.adapter.listFiles(hostId, args.path);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_read_file': {
          if (!args.path || typeof args.path !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "path" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.readFileContent(hostId, args.path);
          if (rawRes && rawRes.success === false) {
            return {
              content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
              isError: true,
            };
          }
          if (rawRes && rawRes.isBinary === true) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Cannot read binary file as text' }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const offset =
            typeof args.offset === 'number' && !isNaN(args.offset) && args.offset >= 0
              ? Math.floor(args.offset)
              : 0;
          const limit =
            typeof args.limit === 'number' && !isNaN(args.limit) && args.limit > 0
              ? Math.floor(args.limit)
              : undefined;

          const fullContent = typeof rawRes?.content === 'string' ? rawRes.content : '';
          const sliced = fullContent.slice(offset, limit !== undefined ? offset + limit : undefined);
          const trunc = truncateText(sliced, this.policy?.maxOutputChars, offset);

          const resultObj = {
            ...rawRes,
            content: trunc.text,
          };
          if (trunc.truncated) {
            resultObj.truncated = true;
            resultObj.totalChars = trunc.totalChars;
            resultObj.nextOffset = trunc.nextOffset;
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(resultObj, null, 2) }],
            isError: false,
          };
        }

        case 'gt_write_file': {
          if (!args.path || typeof args.path !== 'string' || args.content === undefined) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'Parameters "path" and "content" are required.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.saveFileContent(hostId, args.path, String(args.content));
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_mkdir': {
          if (!args.path || typeof args.path !== 'string' || !args.dirName || typeof args.dirName !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'Parameters "path" and "dirName" are required.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.createDirectory(hostId, args.path, args.dirName);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_delete_file': {
          if (!args.path || typeof args.path !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "path" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.deleteItem(hostId, args.path);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_rename_file': {
          if (!args.oldPath || typeof args.oldPath !== 'string' || !args.newPath || typeof args.newPath !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'Parameters "oldPath" and "newPath" are required.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.renameFile(hostId, args.oldPath, args.newPath);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_list': {
          const rawRes = await this.adapter.listCronJobs(hostId);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_add': {
          if (!args.name || !args.cron || !args.command) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'Parameters "name", "cron", and "command" are required.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.addCronJob(hostId, {
            name: args.name,
            cron: args.cron,
            command: args.command,
            cwd: args.cwd,
            timeoutMs: args.timeoutMs,
            concurrency: args.concurrency,
            paused: args.paused,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_update': {
          if (!args.jobId || typeof args.jobId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "jobId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.updateCronJob(hostId, args.jobId, {
            status: args.status,
            name: args.name,
            cron: args.cron,
            command: args.command,
            cwd: args.cwd,
            timeoutMs: args.timeoutMs,
            concurrency: args.concurrency,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_delete': {
          if (!args.jobId || typeof args.jobId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "jobId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.deleteCronJob(hostId, args.jobId);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_run': {
          if (!args.jobId || typeof args.jobId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "jobId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const rawRes = await this.adapter.triggerCronJob(hostId, args.jobId);
          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        case 'gt_cron_logs': {
          if (!args.jobId || typeof args.jobId !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'Parameter "jobId" is required.' }),
                },
              ],
              isError: true,
            };
          }
          const offset =
            typeof args.offset === 'number' && !isNaN(args.offset) && args.offset >= 0
              ? args.offset
              : 0;
          const rawRes = await this.adapter.getCronJobLogs(hostId, args.jobId, offset);

          if (rawRes && typeof rawRes.output === 'string') {
            const trunc = truncateText(rawRes.output, this.policy?.maxOutputChars, offset);
            rawRes.output = trunc.text;
            if (trunc.truncated) {
              rawRes.truncated = true;
              rawRes.totalChars = trunc.totalChars;
              rawRes.nextOffset = trunc.nextOffset;
            }
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(rawRes, null, 2) }],
            isError: Boolean(rawRes && rawRes.success === false),
          };
        }

        default: {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: `Unhandled tool: ${name}` }),
              },
            ],
            isError: true,
          };
        }
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: err.message || String(err) }),
          },
        ],
        isError: true,
      };
    }
  }
}
