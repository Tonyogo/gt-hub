import { SecondaryPanePtyManager } from '../src/agent/pty/panePtyManager';
import { BIN_MSG_TYPE, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';

describe('SecondaryPanePtyManager Lifecycle & Multiplexing', () => {
  let manager: SecondaryPanePtyManager;
  let binaryPackets: Buffer[];
  let controlMessages: Record<string, any>[];

  beforeEach(() => {
    binaryPackets = [];
    controlMessages = [];
    manager = new SecondaryPanePtyManager({
      maxScrollbackBytes: 64 * 1024,
      sendBinary: (pkt) => binaryPackets.push(pkt),
      sendControl: (msg) => controlMessages.push(msg),
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('lazily spawns a secondary PTY on resize/write and emits TERMINAL_RAW packets tagged with paneId', (done) => {
    expect(manager.hasPane('split')).toBe(false);

    manager.resize('split', 70, 24);
    expect(manager.hasPane('split')).toBe(true);

    manager.write('split', 'echo SPLIT_HELLO_123\r');

    const checkInterval = setInterval(() => {
      const combined = binaryPackets
        .map((pkt) => decodeBinaryPacket(pkt))
        .filter((d) => d && d.msgType === BIN_MSG_TYPE.TERMINAL_RAW && d.id === 'split')
        .map((d) => d!.payload.toString('utf-8'))
        .join('');

      if (combined.includes('SPLIT_HELLO_123')) {
        clearInterval(checkInterval);
        done();
      }
    }, 50);
  });

  it('destroys pane without respawning when shell exits via exit command and emits pane_exit', (done) => {
    manager.resize('split', 80, 24);
    manager.write('split', 'exit\r');

    const checkInterval = setInterval(() => {
      const exitCtrl = controlMessages.find((m) => m.type === 'pane_exit' && m.paneId === 'split');
      if (exitCtrl) {
        clearInterval(checkInterval);
        expect(manager.hasPane('split')).toBe(false);
        done();
      }
    }, 50);
  });

  it('terminates pane immediately on closePane without emitting unsolicited respawn', () => {
    manager.resize('split', 80, 24);
    expect(manager.hasPane('split')).toBe(true);

    manager.closePane('split');
    expect(manager.hasPane('split')).toBe(false);
  });
});
