import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';

describe('binaryProtocol', () => {
  it('encodes and decodes binary packets correctly with Buffer payload', () => {
    const rawPayload = Buffer.from('hello raw binary stdout\n', 'utf-8');
    const encoded = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, 'task-xyz-123', rawPayload);

    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(encoded[0]).toBe(BIN_MSG_TYPE.STREAM_OUTPUT);
    expect(encoded[1]).toBe('task-xyz-123'.length);

    const decoded = decodeBinaryPacket(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.msgType).toBe(BIN_MSG_TYPE.STREAM_OUTPUT);
    expect(decoded!.id).toBe('task-xyz-123');
    expect(decoded!.payload.toString('utf-8')).toBe('hello raw binary stdout\n');
  });

  it('handles arbitrary binary bytes (including zero bytes)', () => {
    const rawBytes = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x00]);
    const encoded = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_INPUT, 'exec-1', rawBytes);

    const decoded = decodeBinaryPacket(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload).toEqual(rawBytes);
  });

  it('returns null for corrupted or undersized buffers', () => {
    expect(decodeBinaryPacket(Buffer.alloc(0))).toBeNull();
    expect(decodeBinaryPacket(Buffer.from([0x01]))).toBeNull();

    // IdLen declared as 10, but buffer only has 5 bytes
    const truncated = Buffer.from([0x01, 10, 0x61, 0x62, 0x63]);
    expect(decodeBinaryPacket(truncated)).toBeNull();
  });
});
