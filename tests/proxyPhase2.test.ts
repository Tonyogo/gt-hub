import net from 'net';
import { AddressInfo } from 'net';
import {
  parseProcNetTcp,
  scanListeningTcpPorts,
  ProxyHandler,
  ListeningPortInfo,
} from '../src/agent/handlers/proxyHandler';

describe('Agent Listening Port Scanner & proxy_list_ports RPC (Phase 2)', () => {
  describe('parseProcNetTcp', () => {
    it('accurately parses IPv4 /proc/net/tcp hex lines with state 0A', () => {
      const mockTcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 191081 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22085 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0016 0100007F:1234 01 00000000:00000000 00:00000000 00000000     0        0 22059 1 0000000000000000 100 0 0 10 0
`;
      const result = parseProcNetTcp(mockTcp, false);
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        { port: 3000, address: '127.0.0.1' },
        { port: 80, address: '0.0.0.0' },
      ]);
    });

    it('accurately parses IPv6 /proc/net/tcp6 hex lines with state 0A', () => {
      const mockTcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22087 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21854 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 21853 1 0000000000000000 100 0 0 10 0
`;
      const result = parseProcNetTcp(mockTcp6, true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ port: 8080, address: '::' });
      expect(result[1]).toEqual({ port: 9000, address: '::1' });
    });
  });

  describe('scanListeningTcpPorts', () => {
    let testServer: net.Server;
    let testPort: number;

    beforeAll(async () => {
      testServer = net.createServer(() => {});
      await new Promise<void>((resolve) => {
        testServer.listen(0, '127.0.0.1', () => {
          testPort = (testServer.address() as AddressInfo).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        testServer.close(() => resolve());
      });
    });

    it('detects active listening port on current host, deduplicated and sorted', async () => {
      const ports = await scanListeningTcpPorts();
      expect(Array.isArray(ports)).toBe(true);
      expect(ports.length).toBeGreaterThan(0);

      // Verify sorted ascending
      for (let i = 1; i < ports.length; i++) {
        expect(ports[i].port).toBeGreaterThan(ports[i - 1].port);
      }

      // Verify testServer port is discovered
      const match = ports.find((p: ListeningPortInfo) => p.port === testPort);
      expect(match).toBeDefined();
      expect(match?.port).toBe(testPort);
      expect(['127.0.0.1', '0.0.0.0', '::', '::1']).toContain(match?.address);
    });
  });

  describe('ProxyHandler proxy_list_ports control RPC', () => {
    it('responds with proxy_list_ports_res and ports list when allowProxy is true', async () => {
      const sent: string[] = [];
      const handler = new ProxyHandler({
        send: (data) => {
          if (typeof data === 'string') sent.push(data);
        },
        allowProxy: true,
      });

      const handled = handler.handleControlMessage({
        type: 'proxy_list_ports',
        reqId: 'req-port-test-1',
      });
      expect(handled).toBe(true);

      // Wait for scanListeningTcpPorts async resolution
      await new Promise((r) => setTimeout(r, 100));

      expect(sent.length).toBe(1);
      const msgStr = sent[0];
      expect(msgStr.startsWith('JSON:')).toBe(true);
      const control = JSON.parse(msgStr.slice(5));
      expect(control.type).toBe('proxy_list_ports_res');
      expect(control.reqId).toBe('req-port-test-1');
      expect(control.success).toBe(true);
      expect(Array.isArray(control.ports)).toBe(true);
    });

    it('responds with error when allowProxy is false', async () => {
      const sent: string[] = [];
      const handler = new ProxyHandler({
        send: (data) => {
          if (typeof data === 'string') sent.push(data);
        },
        allowProxy: false,
      });

      const handled = handler.handleControlMessage({
        type: 'proxy_list_ports',
        reqId: 'req-port-test-2',
      });
      expect(handled).toBe(true);

      expect(sent.length).toBe(1);
      const msgStr = sent[0];
      const control = JSON.parse(msgStr.slice(5));
      expect(control.type).toBe('proxy_list_ports_res');
      expect(control.reqId).toBe('req-port-test-2');
      expect(control.success).toBe(false);
      expect(control.error).toMatch(/disabled/i);
    });
  });
});
