import { PROTOCOL_VERSION } from './events';
import { ProtocolCapabilities } from './messages';

export { PROTOCOL_VERSION };
export type { ProtocolCapabilities };

export const BIN_MSG_TYPE = {
  STREAM_INPUT: 0x01,
  STREAM_OUTPUT: 0x02,
  TERMINAL_RAW: 0x03,
  HISTORY_SYNC: 0x04,
  PROXY_HTTP_REQ_BODY: 0x05,
  PROXY_HTTP_RES_BODY: 0x06,
  PROXY_TCP_DATA: 0x07,
  CONTROL_JSON: 0x08,
  FILE_CHUNK_REQ: 0x09,
  FILE_CHUNK_RES: 0x0a,
} as const;

export interface DecodedBinaryPacket {
  msgType: number;
  id: string;
  payload: Buffer;
}

export interface DecodedBinaryJsonBufferPacket {
  msgType: number;
  id: string;
  meta: Record<string, any>;
  rawData: Buffer;
}

export interface DecodedControlJsonEnvelope {
  id: string;
  control: Record<string, any>;
}

export function isBinaryMessageFrame(data: unknown, isBinary?: boolean): boolean {
  if (isBinary === true) return true;
  if (isBinary === false) return false;
  return Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

export function clampPacketId(id: string = ''): string {
  if (!id || typeof id !== 'string') return '';
  const idBuf = Buffer.from(id, 'ascii');
  if (idBuf.length <= 255) return id;
  return idBuf.subarray(0, 255).toString('ascii');
}

export function encodeBinaryJsonBufferPacket(
  msgType: number,
  id: string,
  meta: Record<string, any>,
  rawData?: Buffer | Uint8Array
): Buffer {
  const idBuf = Buffer.from(id, 'ascii');
  if (idBuf.length > 255) {
    throw new Error(`Binary packet id length exceeds 255 bytes: "${id}"`);
  }
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf-8');
  const dataBuf = !rawData
    ? Buffer.alloc(0)
    : Buffer.isBuffer(rawData)
      ? rawData
      : Buffer.from(rawData);

  const packet = Buffer.allocUnsafe(2 + idBuf.length + 4 + metaBuf.length + dataBuf.length);
  packet[0] = msgType;
  packet[1] = idBuf.length;
  idBuf.copy(packet, 2);
  packet.writeUInt32BE(metaBuf.length, 2 + idBuf.length);
  metaBuf.copy(packet, 2 + idBuf.length + 4);
  if (dataBuf.length > 0) {
    dataBuf.copy(packet, 2 + idBuf.length + 4 + metaBuf.length);
  }
  return packet;
}

export function decodeBinaryJsonBufferPacket(buf: Buffer | Uint8Array): DecodedBinaryJsonBufferPacket | null {
  const decoded = decodeBinaryPacket(buf);
  if (!decoded || decoded.payload.length < 4) return null;
  const metaLen = decoded.payload.readUInt32BE(0);
  if (decoded.payload.length < 4 + metaLen) return null;
  try {
    const meta = JSON.parse(decoded.payload.toString('utf-8', 4, 4 + metaLen));
    const rawData = decoded.payload.subarray(4 + metaLen);
    return {
      msgType: decoded.msgType,
      id: decoded.id,
      meta: meta && typeof meta === 'object' ? meta : {},
      rawData,
    };
  } catch {
    return null;
  }
}

export function sendWsSafe(
  ws: any,
  payload: Buffer | string,
  options?: { binary?: boolean; compress?: boolean }
): void {
  if (!ws || typeof ws.send !== 'function') return;
  if (ws._sender && typeof ws._sender === 'object') {
    const sendOpts: Record<string, any> = {
      compress: options?.compress ?? false,
    };
    if (options?.binary !== undefined) {
      sendOpts.binary = options.binary;
    }
    ws.send(payload, sendOpts);
  } else {
    ws.send(payload);
  }
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
  'status',
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
  'cmd_stream_eof',
  'exec_start',
  'exec_started',
  'exec_exit',
  'exec_stdin_eof',
  'exec_kill',
  'exec_error',
  'cron_sync',
  'cron_sync_res',
  'cron_trigger',
  'cron_trigger_res',
  'cron_report',
  'cron_list',
  'cron_list_res',
  'cron_history',
  'cron_history_res',
  'cron_error',
  'task_action',
  // Proxy control types
  'proxy_http_start',
  'proxy_http_req_end',
  'proxy_http_abort',
  'proxy_http_pause',
  'proxy_http_resume',
  'proxy_http_headers',
  'proxy_http_res_headers',
  'proxy_http_end',
  'proxy_tcp_connect',
  'proxy_tcp_connected',
  'proxy_tcp_close',
  'proxy_list_ports',
  'proxy_list_ports_res',
  'proxy_net_ping',
  'proxy_net_ping_res',
  'proxy_net_probe',
  'proxy_net_probe_res',
]);

export function isValidControlPayload(obj: unknown): obj is Record<string, any> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  const type = (obj as any).type;
  if (typeof type !== 'string') {
    return false;
  }
  return VALID_CONTROL_TYPES.has(type);
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

export function decodeControlJsonPacketEnvelope(buf: Buffer | Uint8Array): DecodedControlJsonEnvelope | null {
  const decoded = decodeBinaryPacket(buf);
  if (!decoded || decoded.msgType !== BIN_MSG_TYPE.CONTROL_JSON) {
    return null;
  }
  try {
    const parsed = JSON.parse(decoded.payload.toString('utf-8'));
    if (isValidControlPayload(parsed)) {
      return {
        id: decoded.id,
        control: parsed,
      };
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
      const safeId = clampPacketId(id);
      const pkt = encodeControlJsonPacket(payload, safeId);
      sendWsSafe(ws, pkt, { binary: true, compress: false });
    } else {
      sendWsSafe(ws, `JSON:${JSON.stringify(payload)}`, { binary: false, compress: false });
    }
    return true;
  } catch {
    return false;
  }
}

export function negotiateProtocolCapabilities(searchParams: URLSearchParams): ProtocolCapabilities & { protocolVersion: number } {
  const parseBool = (key: string): boolean => {
    const val = searchParams.get(key);
    return val === '1' || val === 'true';
  };
  const rawVer = parseInt(searchParams.get('protocolVersion') || '1', 10);
  const protocolVersion = !isNaN(rawVer) && rawVer >= 1 ? Math.min(rawVer, PROTOCOL_VERSION) : 1;
  return {
    protocolVersion,
    binaryControl: parseBool('binaryControl'),
    binaryFile: parseBool('binaryFile'),
    framedTerminal: parseBool('framedTerminal'),
    stdinEof: protocolVersion >= 2 || parseBool('stdinEof'),
    binaryExec: protocolVersion >= 2 || parseBool('binaryExec'),
  };
}
