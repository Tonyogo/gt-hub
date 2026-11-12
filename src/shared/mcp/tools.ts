import { McpSecurityPolicy, McpToolDefinition } from './types';

export const MCP_TOOLS: McpToolDefinition[] = [
  // 1. Cluster Nodes
  {
    name: 'gt_list_nodes',
    description: 'List registered agent nodes (all: false by default for online-only; filtered by allowedNodes if configured).',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Include offline nodes if true (default: false)',
        },
      },
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },

  // 2. Command & Task Execution
  {
    name: 'gt_exec',
    description: 'Execute a shell command on node. Defaults to synchronous wait (waitMs: 30000); if detach: true, sets waitMs: 0 and returns taskId immediately.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        command: {
          type: 'string',
          description: 'Shell command string to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory on target host',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Custom environment variables',
        },
        stdin: {
          type: 'string',
          description: 'Optional initial standard input',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Hard execution timeout in milliseconds (default: 300000)',
        },
        waitMs: {
          type: 'integer',
          description: 'Time to wait for completion in milliseconds (default: 30000)',
        },
        detach: {
          type: 'boolean',
          description: 'If true, runs in background and returns taskId immediately',
        },
      },
      required: ['node', 'command'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_task_list',
    description: 'List recent execution tasks on node (default limit: 20).',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        limit: {
          type: 'integer',
          description: 'Max number of tasks to return (default: 20)',
        },
      },
      required: ['node'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
  {
    name: 'gt_task_status',
    description: 'Get task status, exit code, and incremental output starting at byte/char offset.',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        taskId: {
          type: 'string',
          description: 'Task ID returned by gt_exec',
        },
        offset: {
          type: 'integer',
          description: 'Character/byte offset for streaming incremental output (default: 0)',
        },
      },
      required: ['node', 'taskId'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
  {
    name: 'gt_task_kill',
    description: 'Terminate a running task on node (default signal SIGTERM).',
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        taskId: {
          type: 'string',
          description: 'Task ID to terminate',
        },
        signal: {
          type: 'string',
          description: 'Signal to send (default: SIGTERM)',
        },
      },
      required: ['node', 'taskId'],
    },
    annotations: {
      readOnly: false,
      destructive: true,
    },
  },

  // 3. Remote File Management
  {
    name: 'gt_list_files',
    description: 'List directory entries on node.',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        path: {
          type: 'string',
          description: 'Target directory path on remote host (defaults to agent root/home)',
        },
      },
      required: ['node'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
  {
    name: 'gt_read_file',
    description: 'Read text file content from node with optional character offset and limit.',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        path: {
          type: 'string',
          description: 'Target file path on remote host',
        },
        offset: {
          type: 'integer',
          description: 'Starting character offset for reading (default: 0)',
        },
        limit: {
          type: 'integer',
          description: 'Max characters to read',
        },
      },
      required: ['node', 'path'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
  {
    name: 'gt_write_file',
    description: 'Write or overwrite text file content on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        path: {
          type: 'string',
          description: 'Target file path on remote host',
        },
        content: {
          type: 'string',
          description: 'Text content to write',
        },
      },
      required: ['node', 'path', 'content'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_mkdir',
    description: 'Create a new directory dirName inside path on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        path: {
          type: 'string',
          description: 'Parent directory path on remote host',
        },
        dirName: {
          type: 'string',
          description: 'Name of directory to create',
        },
      },
      required: ['node', 'path', 'dirName'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_delete_file',
    description: 'Delete a file or directory at path on node.',
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        path: {
          type: 'string',
          description: 'Target file or directory path to delete',
        },
      },
      required: ['node', 'path'],
    },
    annotations: {
      readOnly: false,
      destructive: true,
    },
  },
  {
    name: 'gt_rename_file',
    description: 'Rename or move a file/directory from oldPath to newPath on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        oldPath: {
          type: 'string',
          description: 'Source path on remote host',
        },
        newPath: {
          type: 'string',
          description: 'Destination path on remote host',
        },
      },
      required: ['node', 'oldPath', 'newPath'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },

  // 4. Distributed Cron Management
  {
    name: 'gt_cron_list',
    description: 'List scheduled cron jobs on node.',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
      },
      required: ['node'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
  {
    name: 'gt_cron_add',
    description: 'Create a scheduled cron job on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        name: {
          type: 'string',
          description: 'Descriptive job name',
        },
        cron: {
          type: 'string',
          description: 'Standard 5-segment cron expression (e.g. "*/5 * * * *")',
        },
        command: {
          type: 'string',
          description: 'Shell command string to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for execution',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Execution timeout in ms (default: 60000)',
        },
        concurrency: {
          type: 'string',
          enum: ['forbid', 'allow'],
          description: 'Concurrency policy (default: forbid)',
        },
        paused: {
          type: 'boolean',
          description: 'Whether the job is initially paused (default: false)',
        },
      },
      required: ['node', 'name', 'cron', 'command'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_cron_update',
    description: 'Update or pause/resume an existing cron job on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        jobId: {
          type: 'string',
          description: 'Cron job ID',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'Set status to active or paused',
        },
        name: {
          type: 'string',
          description: 'Updated job name',
        },
        cron: {
          type: 'string',
          description: 'Updated cron expression',
        },
        command: {
          type: 'string',
          description: 'Updated command',
        },
        cwd: {
          type: 'string',
          description: 'Updated working directory',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Updated timeout in ms',
        },
        concurrency: {
          type: 'string',
          enum: ['forbid', 'allow'],
          description: 'Updated concurrency policy',
        },
      },
      required: ['node', 'jobId'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_cron_delete',
    description: 'Delete a cron job jobId on node.',
    readOnly: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        jobId: {
          type: 'string',
          description: 'Cron job ID to remove',
        },
      },
      required: ['node', 'jobId'],
    },
    annotations: {
      readOnly: false,
      destructive: true,
    },
  },
  {
    name: 'gt_cron_run',
    description: 'Trigger immediate execution of cron job jobId on node.',
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        jobId: {
          type: 'string',
          description: 'Cron job ID to trigger',
        },
      },
      required: ['node', 'jobId'],
    },
    annotations: {
      readOnly: false,
      destructive: false,
    },
  },
  {
    name: 'gt_cron_logs',
    description: 'Fetch execution logs for cron job jobId on node.',
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Target node ID, name, or unique prefix',
        },
        jobId: {
          type: 'string',
          description: 'Cron job ID',
        },
        offset: {
          type: 'integer',
          description: 'Log offset for incremental reading',
        },
      },
      required: ['node', 'jobId'],
    },
    annotations: {
      readOnly: true,
      destructive: false,
    },
  },
];

export function getMcpToolByName(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

export function listMcpTools(
  policy?: McpSecurityPolicy
): Array<Omit<McpToolDefinition, 'readOnly' | 'destructive'>> {
  const tools = policy?.readOnly ? MCP_TOOLS.filter((t) => t.readOnly) : MCP_TOOLS;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
}
