export interface ProtocolCapabilities {
  binaryControl?: boolean;
  binaryFile?: boolean;
  framedTerminal?: boolean;
  stdinEof?: boolean;
  binaryStdin?: boolean;
  binaryExec?: boolean;
}

export interface BaseWsMessage {
  type: string;
  [key: string]: any;
}

export interface WsPingMessage extends BaseWsMessage {
  type: 'ping';
  timestamp?: number;
}

export interface WsPongMessage extends BaseWsMessage {
  type: 'pong';
  timestamp?: number;
}

export interface WsResizeMessage extends BaseWsMessage {
  type: 'resize';
  cols: number;
  rows: number;
  paneId?: string;
  force?: boolean;
}

export interface WsResetMessage extends BaseWsMessage {
  type: 'reset';
  paneId?: string;
  reason?: string;
}

export interface WsPaneCloseMessage extends BaseWsMessage {
  type: 'pane_close';
  paneId: string;
}

export interface WsPaneExitMessage extends BaseWsMessage {
  type: 'pane_exit';
  paneId: string;
  exitCode?: number;
}

export interface WsAgentOfflineMessage extends BaseWsMessage {
  type: 'agent_offline';
  hostId: string;
  paneId?: string;
}

export interface WsHistoryReqMessage extends BaseWsMessage {
  type: 'history_req';
  paneId?: string;
}

export interface WsHistorySyncMessage extends BaseWsMessage {
  type: 'history_sync';
  paneId?: string;
  history: string;
}

export interface WsRegisteredMessage extends BaseWsMessage {
  type: 'registered';
  hostId: string;
  name?: string;
  status?: 'online';
  protocolVersion?: number;
  capabilities?: ProtocolCapabilities;
}

export interface WsRejectedMessage extends BaseWsMessage {
  type: 'rejected';
  reason: string;
  code?: number;
}

export interface WsMetaMessage extends BaseWsMessage {
  type: 'meta';
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  version?: string;
  startTime?: number;
  info?: any;
}

export interface CmdExecRpcRequest extends BaseWsMessage {
  type: 'cmd_exec';
  reqId: string;
  action: 'start' | 'poll' | 'status' | 'stream' | 'kill' | 'list' | 'start_stream' | string;
  taskId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
  offset?: number;
  signal?: string;
  limit?: number;
  tty?: boolean;
  interactive?: boolean;
  cols?: number;
  rows?: number;
  includeFinishOutput?: boolean;
  finishMaxOutputBytes?: number;
  [key: string]: any;
}

export interface CmdExecRpcResponse extends BaseWsMessage {
  type: 'cmd_exec_res';
  reqId: string;
  taskId?: string;
  success: boolean;
  data?: any;
  error?: string | null;
}

export interface CmdTaskFinishedMessage extends BaseWsMessage {
  type: 'cmd_task_finished';
  taskId: string;
  command: string;
  cwd: string;
  status: 'completed' | 'failed' | 'timeout' | 'killed';
  exitCode: number | null;
  startTime: number;
  endTime: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string;
  totalBytes: number;
}

export interface CmdStreamInputMessage extends BaseWsMessage {
  type: 'cmd_stream_input';
  taskId: string;
  data: string; // base64 encoded
}

export interface CmdStreamDataMessage extends BaseWsMessage {
  type: 'cmd_stream_data';
  taskId: string;
  data: string; // base64 encoded
}

export interface CmdStreamResizeMessage extends BaseWsMessage {
  type: 'cmd_stream_resize';
  taskId: string;
  cols: number;
  rows: number;
}

export interface CmdStreamKillMessage extends BaseWsMessage {
  type: 'cmd_stream_kill';
  taskId: string;
  signal?: string;
}

export interface CmdStreamExitMessage extends BaseWsMessage {
  type: 'cmd_stream_exit';
  taskId: string;
  exitCode: number;
  signal?: string | null;
}

export interface CmdStreamEofMessage extends BaseWsMessage {
  type: 'cmd_stream_eof';
  taskId: string;
}

export interface FileRpcRequest extends BaseWsMessage {
  type: 'file_rpc';
  reqId: string;
  action: 'list' | 'read' | 'write' | 'mkdir' | 'rename' | 'delete' | 'stat' | 'download_chunk' | 'upload_chunk' | string;
  path?: string;
  params?: Record<string, any>;
  [key: string]: any;
}

export interface FileRpcResponse extends BaseWsMessage {
  type: 'file_rpc_res';
  reqId: string;
  success: boolean;
  data?: any;
  error?: string | null;
}

export interface ExecStartMessage extends BaseWsMessage {
  type: 'exec_start';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tty?: boolean;
  interactive?: boolean;
  cols?: number;
  rows?: number;
  protocolVersion?: number;
}

export interface ExecStartedMessage extends BaseWsMessage {
  type: 'exec_started';
  taskId: string;
  protocolVersion?: number;
  capabilities?: ProtocolCapabilities;
}

export interface ExecExitMessage extends BaseWsMessage {
  type: 'exec_exit';
  exitCode: number;
  signal?: string | null;
}

export interface ExecStdinEofMessage extends BaseWsMessage {
  type: 'exec_stdin_eof';
}

export interface ExecKillMessage extends BaseWsMessage {
  type: 'exec_kill';
  signal?: string;
}

export interface ExecErrorMessage extends BaseWsMessage {
  type: 'exec_error';
  error: string;
  code?: string;
  exitCode?: number;
}

export interface CronSyncMessage extends BaseWsMessage {
  type: 'cron_sync';
  jobs: any[];
  serverTimezone?: string;
}

export interface CronSyncResMessage extends BaseWsMessage {
  type: 'cron_sync_res';
  success: boolean;
  count: number;
}

export interface CronTriggerMessage extends BaseWsMessage {
  type: 'cron_trigger';
  jobId: string;
  requestId?: string;
}

export interface CronTriggerResMessage extends BaseWsMessage {
  type: 'cron_trigger_res';
  requestId?: string;
  success: boolean;
  record?: any;
  error?: string;
}

export interface CronReportMessage extends BaseWsMessage {
  type: 'cron_report';
  record: any;
}

export interface CronListMessage extends BaseWsMessage {
  type: 'cron_list';
  requestId?: string;
}

export interface CronListResMessage extends BaseWsMessage {
  type: 'cron_list_res';
  requestId?: string;
  summaries: any[];
}

export interface CronHistoryMessage extends BaseWsMessage {
  type: 'cron_history';
  requestId?: string;
  jobId?: string;
  limit?: number;
}

export interface CronHistoryResMessage extends BaseWsMessage {
  type: 'cron_history_res';
  requestId?: string;
  history: any[];
}

export interface CronErrorMessage extends BaseWsMessage {
  type: 'cron_error';
  error: string;
}

export interface ProxyHttpStartMessage extends BaseWsMessage {
  type: 'proxy_http_start';
  reqId: string;
  method: string;
  url: string;
  headers?: Record<string, string | string[]>;
  timeoutMs?: number;
  bodyEnd?: boolean;
  insecure?: boolean;
}

export interface ProxyHttpHeadersMessage extends BaseWsMessage {
  type: 'proxy_http_headers';
  reqId: string;
  statusCode: number;
  statusMessage?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ProxyHttpEndMessage extends BaseWsMessage {
  type: 'proxy_http_end';
  reqId: string;
  error?: string;
  code?: string;
}

export interface ProxyTcpConnectMessage extends BaseWsMessage {
  type: 'proxy_tcp_connect';
  streamId: string;
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface ProxyTcpConnectedMessage extends BaseWsMessage {
  type: 'proxy_tcp_connected';
  streamId: string;
}

export interface ProxyTcpCloseMessage extends BaseWsMessage {
  type: 'proxy_tcp_close';
  streamId: string;
  error?: string;
  code?: string;
}

export interface TaskActionMessage extends BaseWsMessage {
  type: 'task_action';
  action: 'kill' | 'restart' | 'stop' | string;
  taskId?: string;
  hostId?: string;
}
