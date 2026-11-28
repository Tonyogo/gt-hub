export const PROTOCOL_VERSION = 2;

export const DEFAULT_PROTOCOL_CAPABILITIES = {
  binaryControl: false,
  binaryFile: false,
  framedTerminal: false,
  stdinEof: false,
  binaryExec: false,
} as const;

export const WS_PREFIX = {
  JSON: 'JSON:',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export const WS_MSG_TYPES = {
  // Lifecycle & Keepalive
  PING: 'ping',
  PONG: 'pong',
  REGISTERED: 'registered',
  REJECTED: 'rejected',
  META: 'meta',
  STATUS: 'status',

  // Interactive Terminal & Split Panes
  RESIZE: 'resize',
  RESET: 'reset',
  PANE_CLOSE: 'pane_close',
  PANE_EXIT: 'pane_exit',
  AGENT_OFFLINE: 'agent_offline',
  HISTORY_REQ: 'history_req',
  HISTORY_SYNC: 'history_sync',

  // File & Command RPC
  FILE_RPC: 'file_rpc',
  FILE_RPC_RES: 'file_rpc_res',
  CMD_EXEC: 'cmd_exec',
  CMD_EXEC_RES: 'cmd_exec_res',
  CMD_TASK_FINISHED: 'cmd_task_finished',

  // Streaming Execution (Agent <-> Hub)
  CMD_STREAM_INPUT: 'cmd_stream_input',
  CMD_STREAM_DATA: 'cmd_stream_data',
  CMD_STREAM_RESIZE: 'cmd_stream_resize',
  CMD_STREAM_KILL: 'cmd_stream_kill',
  CMD_STREAM_EXIT: 'cmd_stream_exit',
  CMD_STREAM_EOF: 'cmd_stream_eof',

  // CLI Exec WebSocket (CLI <-> Hub /api/terminal/exec-ws)
  EXEC_START: 'exec_start',
  EXEC_STARTED: 'exec_started',
  EXEC_EXIT: 'exec_exit',
  EXEC_STDIN_EOF: 'exec_stdin_eof',
  EXEC_KILL: 'exec_kill',
  EXEC_ERROR: 'exec_error',

  // Distributed Cron
  CRON_SYNC: 'cron_sync',
  CRON_SYNC_RES: 'cron_sync_res',
  CRON_TRIGGER: 'cron_trigger',
  CRON_TRIGGER_RES: 'cron_trigger_res',
  CRON_REPORT: 'cron_report',
  CRON_LIST: 'cron_list',
  CRON_LIST_RES: 'cron_list_res',
  CRON_HISTORY: 'cron_history',
  CRON_HISTORY_RES: 'cron_history_res',
  CRON_ERROR: 'cron_error',

  // Reverse HTTP/TCP Proxy & Speedtest
  PROXY_HTTP_START: 'proxy_http_start',
  PROXY_HTTP_REQ_END: 'proxy_http_req_end',
  PROXY_HTTP_ABORT: 'proxy_http_abort',
  PROXY_HTTP_PAUSE: 'proxy_http_pause',
  PROXY_HTTP_RESUME: 'proxy_http_resume',
  PROXY_HTTP_HEADERS: 'proxy_http_headers',
  PROXY_HTTP_END: 'proxy_http_end',
  PROXY_TCP_CONNECT: 'proxy_tcp_connect',
  PROXY_TCP_CONNECTED: 'proxy_tcp_connected',
  PROXY_TCP_CLOSE: 'proxy_tcp_close',
  PROXY_LIST_PORTS: 'proxy_list_ports',
  PROXY_LIST_PORTS_RES: 'proxy_list_ports_res',
  PROXY_NET_PING: 'proxy_net_ping',
  PROXY_NET_PING_RES: 'proxy_net_ping_res',
  PROXY_NET_PROBE: 'proxy_net_probe',
  PROXY_NET_PROBE_RES: 'proxy_net_probe_res',

  // Legacy / Reserved
  TASK_ACTION: 'task_action',
} as const;

export const RPC_FILE_ACTIONS = {
  LIST: 'list',
  READ: 'read',
  WRITE: 'write',
  MKDIR: 'mkdir',
  RENAME: 'rename',
  DELETE: 'delete',
  STAT: 'stat',
  DOWNLOAD_CHUNK: 'download_chunk',
  UPLOAD_CHUNK: 'upload_chunk',
} as const;
