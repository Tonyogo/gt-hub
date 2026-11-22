import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';
import { StreamSessionManager } from '../src/agent/pty/sessionManager';

describe('Zero-Base64 StreamSessionManager Binary Integration', () => {
  it('supports direct raw buffer input via writeRawInput without Base64 decoding', (done) => {
    let capturedOutput = '';
    let leakedLegacyProps = false;
    const mockSend = (msg: any) => {
      if (Buffer.isBuffer(msg)) {
        if ((msg as any).data !== undefined || (msg as any).type !== undefined) {
          leakedLegacyProps = true;
        }
        const decoded = decodeBinaryPacket(msg);
        if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
          capturedOutput += decoded.payload.toString('utf-8');
        }
      }
    };

    const manager = new StreamSessionManager(mockSend);
    const taskId = 'test-binary-task-1';

    manager.startStream({
      taskId,
      command: 'cat',
      tty: false,
    });

    setTimeout(() => {
      manager.writeRawInput(taskId, Buffer.from('direct-binary-stream-data\n', 'utf-8'));
    }, 100);

    setTimeout(() => {
      manager.kill(taskId);
      expect(leakedLegacyProps).toBe(false);
      expect(capturedOutput).toContain('direct-binary-stream-data');
      done();
    }, 600);
  });
});
