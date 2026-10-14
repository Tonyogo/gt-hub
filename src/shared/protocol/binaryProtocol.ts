export const BIN_MSG_TYPE = {
  STREAM_INPUT: 0x01,
  STREAM_OUTPUT: 0x02,
  TERMINAL_RAW: 0x03,
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
