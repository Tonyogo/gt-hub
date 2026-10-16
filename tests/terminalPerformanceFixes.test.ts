import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import express from 'express';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import config from '../src/server/config/default';
import { TerminalHostManager, RemoteAgentTerminalSession, toHostDTO } from '../src/terminal/services/terminalHostManager';

describe('Terminal Performance & Inactive Tab Isolation Fixes', () => {
  describe('1. terminalHostManager DTO Purity & agentWs Elimination', () => {
    let manager: TerminalHostManager;

    beforeEach(() => {
      manager = new TerminalHostManager();
    });

    test('registerAgent does not attach agentWs or raw socket buffer to ManagedHost DTO', () => {
      // Mock a realistic WebSocket object with circular reference and heavy buffers
      const mockWs: any = {
        readyState: 1,
        send: jest.fn(),
        _receiver: {},
        _sender: {},
        rawBuffer: Buffer.alloc(1024),
      };
      mockWs._receiver.socket = mockWs; // circular reference

      const reg = manager.registerAgent({
        hostId: 'perf-test-node',
        name: 'perf-node',
        hostname: 'perf-host',
        ip: '192.168.1.100',
        platform: 'linux',
        version: '1.2.0',
        agentWs: mockWs,
      });

      expect(reg.success).toBe(true);
      expect(reg.host).toBeDefined();

      // Ensure ManagedHost DTO has NO agentWs property
      expect((reg.host as any).agentWs).toBeUndefined();

      const retrievedHost = manager.getHost('perf-test-node');
      expect((retrievedHost as any)?.agentWs).toBeUndefined();

      const hostsList = manager.getHosts();
      expect(hostsList.length).toBe(1);
      expect((hostsList[0] as any).agentWs).toBeUndefined();

      // Verify JSON serialization of getHosts() is clean, fast, and does not throw circular error
      expect(() => {
        const jsonStr = JSON.stringify(hostsList);
        expect(jsonStr).not.toContain('rawBuffer');
        expect(jsonStr).not.toContain('agentWs');
      }).not.toThrow();

      // Verify the terminal session still keeps and uses the agentWs internally
      const session = manager.getSession('perf-test-node');
      expect(session).toBeInstanceOf(RemoteAgentTerminalSession);
      expect(session?.getAgentWs()).toBe(mockWs);
    });

    test('getHosts() projects through toHostDTO and strips internal socket/buffer properties even if injected', () => {
      const mockWs: any = {
        readyState: 1,
        send: jest.fn(),
        _socket: {},
        rawBuffer: Buffer.alloc(2048),
      };
      mockWs._socket.circular = mockWs;

      manager.registerAgent({
        hostId: 'dirty-host',
        name: 'Dirty Host',
        agentWs: mockWs,
      });

      // Deliberately attach dirty fields to the internal host map entry
      const internalHost = (manager as any).hosts.get('dirty-host');
      expect(internalHost).toBeDefined();
      internalHost.agentWs = mockWs;
      internalHost.dirtyBuffer = Buffer.alloc(512);

      // getHosts() must strip these fields before returning
      const hosts = manager.getHosts();
      expect(hosts.length).toBe(1);
      const hostDto = hosts[0] as any;
      expect(hostDto.agentWs).toBeUndefined();
      expect(hostDto.dirtyBuffer).toBeUndefined();
      expect(hostDto._socket).toBeUndefined();

      // Serialization must be safe and clean
      expect(() => {
        const json = JSON.stringify(hosts);
        expect(json).not.toContain('dirtyBuffer');
        expect(json).not.toContain('agentWs');
      }).not.toThrow();
    });

    test('toHostDTO preserves defined optional fields and produces clean serializable DTO', () => {
      const fullHost: any = {
        id: 'full-node',
        name: 'Full Node',
        hostname: 'full.internal',
        ip: '10.0.0.5',
        platform: 'darwin',
        status: 'online',
        lastSeen: 1700000000000,
        startTime: 1699990000000,
        type: 'agent',
        machineId: 'mach-12345',
        version: '1.2.0',
        agentWs: { circular: true },
        rawBuffer: Buffer.from('leaked'),
      };

      const dto = toHostDTO(fullHost);
      expect(dto.id).toBe('full-node');
      expect(dto.name).toBe('Full Node');
      expect(dto.hostname).toBe('full.internal');
      expect(dto.ip).toBe('10.0.0.5');
      expect(dto.platform).toBe('darwin');
      expect(dto.status).toBe('online');
      expect(dto.lastSeen).toBe(1700000000000);
      expect(dto.startTime).toBe(1699990000000);
      expect(dto.machineId).toBe('mach-12345');
      expect(dto.version).toBe('1.2.0');
      expect(dto.type).toBe('agent');

      // Leaked fields must NOT be present on DTO
      expect((dto as any).agentWs).toBeUndefined();
      expect((dto as any).rawBuffer).toBeUndefined();
      expect(Object.keys(dto)).not.toContain('agentWs');
      expect(Object.keys(dto)).not.toContain('rawBuffer');
    });

    test('unregisterAgent keeps ManagedHost pure without agentWs assignment', () => {
      const mockWs = { readyState: 1, send: jest.fn() };
      manager.registerAgent({
        hostId: 'node-offline-test',
        agentWs: mockWs,
      });

      manager.unregisterAgent('node-offline-test');
      const host = manager.getHost('node-offline-test');
      expect(host).toBeDefined();
      expect(host?.status).toBe('offline');
      expect((host as any)?.agentWs).toBeUndefined();
    });
  });

  describe('2. UnifiedTerminalView Timezone Endpoint Optimization', () => {
    const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(unifiedPath, 'utf-8');
    });

    test('fetches server timezone from lightweight /api/terminal/version instead of /api/terminal/hosts', () => {
      // Must query /api/terminal/version
      expect(content).toContain("apiFetch('/api/terminal/version'");
      // Must NOT query /api/terminal/hosts
      expect(content).not.toContain("apiFetch('/api/terminal/hosts'");
    });

    test('GET /api/terminal/version returns server timezone directly via API without querying hosts list', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/terminal', terminalRoutes);

      const origKey = config.adminSecretKey;
      config.adminSecretKey = 'test-perf-key';
      try {
        const res = await request(app)
          .get('/api/terminal/version')
          .set('x-admin-key', 'test-perf-key');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('timezone', config.timeZone);
        expect(res.body).toHaveProperty('version');
        expect(res.body.hosts).toBeUndefined(); // Does not leak or serialize hosts list
      } finally {
        config.adminSecretKey = origKey;
      }
    });

    test('passes isActive prop to TerminalFileManagerView, TerminalCronView, and TerminalTaskView based on active subTab', () => {
      expect(content).toMatch(/<TerminalFileManagerView[^>]*isActive=\{subTab\s*===\s*['"]files['"]\}/s);
      expect(content).toMatch(/<TerminalCronView[^>]*isActive=\{subTab\s*===\s*['"]cron['"]\}/s);
      expect(content).toMatch(/<TerminalTaskView[^>]*isActive=\{subTab\s*===\s*['"]tasks['"]\}/s);
    });
  });

  describe('3. TerminalTaskView Inactive Tab Protection & Host Isolation', () => {
    const taskViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalTaskView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(taskViewPath, 'utf-8');
    });

    test('declares isActive in TerminalTaskViewProps with default value', () => {
      expect(content).toMatch(/export\s+interface\s+TerminalTaskViewProps\s*\{[^}]*isActive\?: boolean;/);
      expect(content).toMatch(/isActive\s*=\s*false/);
    });

    test('guards initial fetchTasks with isActive check', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*if\s*\(!isActive\)\s*return;[^}]*fetchTasks\(false\);[^}]*\}\s*,\s*\[isActive,\s*fetchTasks\]\)/s);
    });

    test('guards 3s polling timer with isActive check and cleans up timer when tab is switched', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*if\s*\(!isActive\s*\|\|\s*!activeHostId\)\s*return;/s);
      expect(content).toMatch(/return\s*\(\)\s*=>\s*clearInterval\(timer\);/s);
      expect(content).toMatch(/\}\s*,\s*\[isActive,\s*activeHostId,\s*tasks,\s*fetchTasks\]\)/s);
    });

    test('resets tasks array, loading, and modal state when activeHostId changes to prevent cross-node pollution', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*setTasks\(\[\]\);[^}]*setIsLoading\(false\);[^}]*setSelectedTaskForLogs\(null\);[^}]*setIsLogModalOpen\(false\);[^}]*\}\s*,\s*\[activeHostId\]\)/s);
      expect(content).toMatch(/const\s+activeHostIdRef\s*=\s*useRef/);
      expect(content).toMatch(/const\s+isActiveRef\s*=\s*useRef/);
    });

    test('guards activeHostIdRef and isActiveRef in fetchTasks against in-flight race conditions when switching hosts or tabs', () => {
      expect(content).toMatch(/if\s*\(activeHostIdRef\.current\s*!==\s*requestHostId\)\s*return;/);
      expect(content).toMatch(/if\s*\(silent\s*&&\s*!isActiveRef\.current\)\s*return;/);
    });
  });

  describe('4. TerminalFileManagerView Inactive Tab Protection & Host Safety', () => {
    const fileViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(fileViewPath, 'utf-8');
    });

    test('declares isActive in TerminalFileManagerViewProps with default value', () => {
      expect(content).toMatch(/export\s+interface\s+TerminalFileManagerViewProps\s*\{[^}]*isActive\?: boolean;/);
      expect(content).toMatch(/isActive\s*=\s*false/);
    });

    test('guards loadFiles with isActive check so files are only loaded when tab is active', () => {
      expect(content).toMatch(/const\s+loadedHostRef\s*=\s*useRef<string\s*\|\s*null>\(null\);/);
      expect(content).toMatch(/if\s*\(!isActive\)\s*\{/);
      expect(content).toMatch(/if\s*\(loadedHostRef\.current\s*!==\s*activeHostId\)\s*\{[^}]*loadedHostRef\.current\s*=\s*activeHostId;[^}]*loadFiles\(\);/s);
    });

    test('guards activeHostIdRef in loadFiles against in-flight race conditions when switching hosts', () => {
      expect(content).toMatch(/const\s+activeHostIdRef\s*=\s*useRef<string>\(activeHostId\);/);
      expect(content).toMatch(/if\s*\(activeHostIdRef\.current\s*!==\s*requestHostId\)\s*return;/);
    });
  });

  describe('5. TerminalCronView Inactive Tab Protection & Host Isolation', () => {
    const cronViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(cronViewPath, 'utf-8');
    });

    test('declares isActive in TerminalCronViewProps with default value', () => {
      expect(content).toMatch(/export\s+interface\s+TerminalCronViewProps\s*\{[^}]*isActive\?: boolean;/);
      expect(content).toMatch(/isActive\s*=\s*false/);
    });

    test('guards initial fetchJobs with isActive check', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*if\s*\(!isActive\)\s*return;[^}]*fetchJobs\(false\);[^}]*\}\s*,\s*\[isActive,\s*fetchJobs\]\)/s);
    });

    test('guards 10s background polling with isActive check and activeHostId, cleaning up timer when inactive', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*if\s*\(!isActive\s*\|\|\s*!activeHostId\)\s*return;/s);
      expect(content).toMatch(/return\s*\(\)\s*=>\s*clearInterval\(timer\);/s);
      expect(content).toMatch(/\}\s*,\s*\[isActive,\s*activeHostId,\s*fetchJobs\]\)/s);
    });

    test('resets jobs, loading, and modal state when activeHostId changes to prevent cross-node pollution', () => {
      expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[^}]*setJobs\(\[\]\);[^}]*setIsLoading\(false\);[^}]*setIsJobModalOpen\(false\);[^}]*setSelectedJobForLogs\(null\);[^}]*\}\s*,\s*\[activeHostId\]\)/s);
      expect(content).toMatch(/const\s+activeHostIdRef\s*=\s*useRef/);
      expect(content).toMatch(/const\s+isActiveRef\s*=\s*useRef/);
    });

    test('guards activeHostIdRef and isActiveRef in fetchJobs against in-flight race conditions when switching hosts or tabs', () => {
      expect(content).toMatch(/if\s*\(activeHostIdRef\.current\s*!==\s*requestHostId\)\s*return;/);
      expect(content).toMatch(/if\s*\(silent\s*&&\s*!isActiveRef\.current\)\s*return;/);
    });
  });
});
