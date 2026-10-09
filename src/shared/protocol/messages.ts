export interface BaseWsMessage {
  type: string;
  [key: string]: any;
}

export interface WsResizeMessage extends BaseWsMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface WsResetMessage extends BaseWsMessage {
  type: 'reset';
  reason?: string;
}

export interface WsRegisteredMessage extends BaseWsMessage {
  type: 'registered';
  hostId: string;
  name?: string;
}

export interface WsRejectedMessage extends BaseWsMessage {
  type: 'rejected';
  reason: string;
}

export interface WsMetaMessage extends BaseWsMessage {
  type: 'meta';
  info?: any;
}

export interface CmdExecRpcRequest extends BaseWsMessage {
  type: 'cmd_exec';
  requestId: string;
  action: string;
  [key: string]: any;
}

export interface CmdExecRpcResponse extends BaseWsMessage {
  type: 'cmd_exec_res';
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface FileRpcRequest extends BaseWsMessage {
  type: 'file_rpc';
  requestId: string;
  action: string;
  path?: string;
  [key: string]: any;
}

export interface FileRpcResponse extends BaseWsMessage {
  type: 'file_rpc_res';
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface TaskActionMessage extends BaseWsMessage {
  type: 'task_action';
  action: 'kill' | 'restart' | 'stop' | string;
  taskId?: string;
  hostId?: string;
}
