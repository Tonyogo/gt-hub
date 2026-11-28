export const BIN_CONTROL_JSON = 0x08;

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

export function isValidBrowserTerminalControl(obj: unknown): obj is Record<string, any> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  const candidate = obj as Record<string, any>;
  if (
    candidate.type === 'agent_offline' ||
    candidate.type === 'pane_exit' ||
    candidate.type === 'pong' ||
    candidate.type === 'reset'
  ) {
    return true;
  }
  return candidate.type === 'status' && candidate.event === 'exit';
}

export function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function isBinaryControlPacket(data: unknown): boolean {
  const bytes = toUint8Array(data);
  return Boolean(bytes && bytes.length >= 2 && bytes[0] === BIN_CONTROL_JSON);
}

export function decodeBinaryControlFrame(data: unknown): Record<string, any> | null {
  const bytes = toUint8Array(data);
  if (!bytes || bytes.length < 2 || bytes[0] !== BIN_CONTROL_JSON) {
    return null;
  }
  const idLen = bytes[1];
  if (bytes.length < 2 + idLen) {
    return null;
  }
  try {
    const jsonText = textDecoder.decode(bytes.subarray(2 + idLen));
    const parsed = JSON.parse(jsonText);
    return isValidBrowserTerminalControl(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTerminalTextControlFrame(data: string): Record<string, any> | null {
  if (typeof data !== 'string' || !data.startsWith('JSON:')) {
    return null;
  }
  try {
    const parsed = JSON.parse(data.slice(5));
    return isValidBrowserTerminalControl(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeBinaryControlFrame(payload: Record<string, any>, id: string = ''): Uint8Array {
  const rawId = textEncoder.encode(id || '');
  const idLen = Math.min(255, rawId.length);
  const jsonBytes = textEncoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(2 + idLen + jsonBytes.length);
  out[0] = BIN_CONTROL_JSON;
  out[1] = idLen;
  if (idLen > 0) {
    out.set(rawId.subarray(0, idLen), 2);
  }
  out.set(jsonBytes, 2 + idLen);
  return out;
}
