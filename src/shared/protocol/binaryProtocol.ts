export const BIN_MSG_TYPE = {
  STREAM_INPUT: 0x01,
  STREAM_OUTPUT: 0x02,
  TERMINAL_RAW: 0x03,
  HISTORY_SYNC: 0x04,
  PROXY_HTTP_REQ_BODY: 0x05,
  PROXY_HTTP_RES_BODY: 0x06,
  PROXY_TCP_DATA: 0x07,
  CONTROL_JSON: 0x08,
} as const;

export interface DecodedBinaryPacket {
  msgType: number;
  id: string;
  payload: Buffer;
}

export function encodeBinaryPacket(
  msgType: number,
  id: string,
  payload: Buffer | Uint8Array | string
): Buffer {
  const idBuf = Buffer.from(id, 'ascii');
  if (idBuf.length > 255) {
    throw new Error(`Binary packet id length exceeds 255 bytes: "${id}"`);
  }
  const dataBuf = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === 'string'
      ? Buffer.from(payload, 'utf-8')
      : Buffer.from(payload);

  const packet = Buffer.allocUnsafe(2 + idBuf.length + dataBuf.length);
  packet[0] = msgType;
  packet[1] = idBuf.length;
  idBuf.copy(packet, 2);
  dataBuf.copy(packet, 2 + idBuf.length);
  return packet;
}

export function decodeBinaryPacket(buf: Buffer | Uint8Array): DecodedBinaryPacket | null {
  if (!buf) return null;
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (nodeBuf.length < 2) return null;

  const msgType = nodeBuf[0];
  const idLen = nodeBuf[1];
  if (nodeBuf.length < 2 + idLen) return null;

  const id = nodeBuf.toString('ascii', 2, 2 + idLen);
  const payload = nodeBuf.subarray(2 + idLen);
  return { msgType, id, payload };
}

const VALID_CONTROL_TYPES = new Set([
  'ping',
  'pong',
  'registered',
  'rejected',
  'meta',
  'resize',
  'reset',
  'pane_close',
  'pane_exit',
  'agent_offline',
  'history_req',
  'history_sync',
  'file_rpc',
  'file_rpc_res',
  'cmd_exec',
  'cmd_exec_res',
  'cmd_task_finished',
  'cmd_stream_input',
  'cmd_stream_data',
  'cmd_stream_resize',
  'cmd_stream_kill',
  'cmd_stream_exit',
  'exec_start',
  'exec_started',
  'exec_exit',
  'cron_sync',
  'cron_trigger',
  'cron_report',
  'cron_list',
  'cron_history',
]);

export function isValidControlPayload(obj: unknown): obj is Record<string, any> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  const type = (obj as any).type;
  if (typeof type !== 'string') {
    return false;
  }
  return VALID_CONTROL_TYPES.has(type) || type.startsWith('proxy_');
}

export function encodeControlJsonPacket(control: Record<string, any>, id: string = ''): Buffer {
  const jsonStr = JSON.stringify(control);
  return encodeBinaryPacket(BIN_MSG_TYPE.CONTROL_JSON, id, jsonStr);
}

export function decodeControlJsonPacket(buf: Buffer | Uint8Array): Record<string, any> | null {
  const decoded = decodeBinaryPacket(buf);
  if (!decoded || decoded.msgType !== BIN_MSG_TYPE.CONTROL_JSON) {
    return null;
  }
  try {
    const parsed = JSON.parse(decoded.payload.toString('utf-8'));
    if (isValidControlPayload(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function sendControlFrame(ws: any, payload: Record<string, any>, id: string = ''): boolean {
  if (!ws || (ws.readyState !== 1 && ws.readyState !== (ws.constructor?.OPEN ?? 1))) {
    return false;
  }
  try {
    if (ws._binaryControl === true) {
      ws.send(encodeControlJsonPacket(payload, id));
    } else {
      ws.send(`JSON:${JSON.stringify(payload)}`);
    }
    return true;
  } catch {
    return false;
  }
}
