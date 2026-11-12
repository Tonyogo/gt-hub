export interface McpSecurityPolicy {
  readOnly?: boolean;
  allowedNodes?: string[];
  maxOutputChars?: number;
}

export interface McpHostEntry {
  id: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  status?: string;
  online?: boolean;
  connected?: boolean;
  [key: string]: any;
}

export interface McpBackendAdapter {
  // 1. Cluster Nodes
  listNodes(): Promise<McpHostEntry[]>;

  // 2. Command & Task Execution
  startExec(
    hostId: string,
    opts: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      waitMs?: number;
      env?: Record<string, string>;
      stdin?: string;
    }
  ): Promise<any>;
  getExecStatus(hostId: string, taskId: string, offset?: number): Promise<any>;
  killExec(hostId: string, taskId: string, signal?: string): Promise<any>;
  listExec(hostId: string, limit?: number): Promise<any>;

  // 3. Remote File Management
  listFiles(hostId: string, targetPath?: string): Promise<any>;
  readFileContent(hostId: string, targetPath: string): Promise<any>;
  saveFileContent(hostId: string, targetPath: string, content: string): Promise<any>;
  createDirectory(hostId: string, parentPath: string, dirName: string): Promise<any>;
  deleteItem(hostId: string, targetPath: string): Promise<any>;
  renameFile(hostId: string, oldPath: string, newPath: string): Promise<any>;

  // 4. Distributed Cron Management
  listCronJobs(hostId: string): Promise<any>;
  addCronJob(hostId: string, body: Record<string, any>): Promise<any>;
  updateCronJob(hostId: string, jobId: string, body: Record<string, any>): Promise<any>;
  deleteCronJob(hostId: string, jobId: string): Promise<any>;
  triggerCronJob(hostId: string, jobId: string): Promise<any>;
  getCronJobLogs(hostId: string, jobId: string, offset?: number): Promise<any>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    [key: string]: any;
  };
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: JsonRpcError;
}

export interface McpToolCallResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}
