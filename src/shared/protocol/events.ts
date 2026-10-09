export const WS_PREFIX = {
  JSON: 'JSON:',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export const WS_MSG_TYPES = {
  PING: 'ping',
  PONG: 'pong',
  RESIZE: 'resize',
  RESET: 'reset',
  REGISTERED: 'registered',
  REJECTED: 'rejected',
  META: 'meta',
  CMD_EXEC: 'cmd_exec',
  CMD_EXEC_RES: 'cmd_exec_res',
  FILE_RPC: 'file_rpc',
  FILE_RPC_RES: 'file_rpc_res',
  TASK_ACTION: 'task_action',
} as const;

export const RPC_FILE_ACTIONS = {
  LIST: 'list',
  STAT: 'stat',
  READ_CHUNK: 'read_chunk',
  WRITE_CHUNK: 'write_chunk',
  RM: 'rm',
  MKDIR: 'mkdir',
  MOVE: 'move',
} as const;
