import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { ConfigStore } from '../client/config/configStore';
import { resolveWebSocketUrl, parseControlMessage } from '../client/utils/terminalUI';
import { createWebSocketAdapter } from '../shared/utils/wsAdapter';
import { taskManager, killProcessTree, killProcessTreeSync, getDefaultShell } from './tasks/taskManager';
import { tryRequirePty, hasSystemPython3, PosixPtyDriver, InteractivePipeDriver } from './pty/drivers';
import { StreamSessionManager } from './pty/sessionManager';
import { handleFileRpc } from './handlers/fileRpcHandler';
import { handleCmdExec } from './handlers/cmdExecHandler';

export const HANDSHAKE_TIMEOUT_MS = 4000;
export const HEARTBEAT_INTERVAL_MS = 15000;
export const HEARTBEAT_TIMEOUT_MS = 20000;

export function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getWebSocketCtor(): any {
  let wsImpl: any = null;
  try {
    wsImpl = require('ws');
  } catch {}
  if (!wsImpl) {
    wsImpl = createWebSocketAdapter();
  }
  return wsImpl;
}

export class AgentDaemonManager {
  static getAgentsDir(): string {
    const dir = path.join(ConfigStore.getConfigDir(), 'agents');
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    }
    return dir;
  }

  static sanitizeName(name?: string | null): string {
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
  }

  static getStatusFile(name?: string | null): string {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const all = this.getAllAgents();
      if (all.length > 0) sName = all[0].name;
      else sName = 'agent';
    }
    return path.join(this.getAgentsDir(), `${sName}.json`);
  }

  static getLogFile(name?: string | null): string {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const all = this.getAllAgents();
      if (all.length > 0) sName = all[0].name;
      else sName = 'agent';
    }
    return path.join(this.getAgentsDir(), `${sName}.log`);
  }

  static isProcessAlive(pid?: number | null): boolean {
    if (!pid || typeof pid !== 'number') return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  static getAgent(name: string): any {
    const sName = this.sanitizeName(name);
    if (!sName) return null;
    const p = path.join(this.getAgentsDir(), `${sName}.json`);
    if (!fs.existsSync(p)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const alive = this.isProcessAlive(state.pid);
      return {
        name: sName,
        running: alive,
        stale: !alive,
        ...state,
      };
    } catch {
      return null;
    }
  }

  static getStatus(name?: string): any {
    const res = this.resolveTarget(name, 'status');
    if (res.agent) {
      return res.agent;
    }
    return { running: false };
  }

  static getAllAgents(): any[] {
    const dir = this.getAgentsDir();
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const list: any[] = [];
      for (const file of files) {
        const name = file.slice(0, -5);
        const agent = this.getAgent(name);
        if (agent) list.push(agent);
      }
      return list.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  static printAgentsTable(showAll: boolean = false): void {
    const all = this.getAllAgents();
    if (all.length === 0) {
      console.log('No agent daemons found.');
      process.exit(0);
    }
    const displayed = showAll ? all : all.filter(a => a.running);
    const stoppedCount = all.filter(a => !a.running).length;

    if (displayed.length === 0) {
      if (stoppedCount > 0) {
        console.log(`No running agent daemons found. (${stoppedCount} stopped, use -a to show or 'gt agent prune' to clean up)`);
      } else {
        console.log('No agent daemons found.');
      }
      process.exit(0);
    }

    console.log(
      'NAME'.padEnd(20) +
      'STATUS'.padEnd(12) +
      'PID'.padEnd(10) +
      'TARGET HUB'.padEnd(30) +
      'STARTED'
    );
    console.log('-'.repeat(95));
    for (const a of displayed) {
      const statusStr = a.running ? 'Running' : 'Stopped';
      console.log(
        (a.name || '').padEnd(20) +
        statusStr.padEnd(12) +
        String(a.pid || '').padEnd(10) +
        (a.server || '').padEnd(30) +
        (a.startTime || '')
      );
    }

    if (!showAll && stoppedCount > 0) {
      console.log(`\n(${stoppedCount} stopped agent(s) hidden. Use 'gt agent ps -a' to view all or 'gt agent prune' to clean up)`);
    }

    process.exit(0);
  }

  static prune(): { removed: string[] } {
    return this.removeAll();
  }

  static saveStatus(nameOrState: any, maybeState?: any): void {
    let name: string, state: any;
    if (typeof nameOrState === 'string') {
      name = nameOrState;
      state = maybeState || {};
    } else {
      state = nameOrState || {};
      name = state.name;
    }
    const sName = this.sanitizeName(name) || 'agent';
    const dir = this.getAgentsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${sName}.json`);
    const data = { name: sName, ...state };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }

  static clearStatus(name: string): void {
    if (!name) return;
    const sName = this.sanitizeName(name);
    if (!sName) return;
    try {
      const p = path.join(this.getAgentsDir(), `${sName}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  static resolveTarget(name?: string, actionName: string = 'operate'): { agent?: any; error?: string } {
    if (name) {
      const sName = this.sanitizeName(name);
      const agent = this.getAgent(sName);
      if (!agent) {
        return { error: `Error: Agent "${sName}" not found.` };
      }
      return { agent };
    }

    const all = this.getAllAgents();
    const running = all.filter(a => a.running);
    if (running.length === 1) {
      return { agent: running[0] };
    }
    if (running.length === 0) {
      if (all.length === 1) return { agent: all[0] };
      return { error: `No active agent found to ${actionName}.` };
    }

    const names = running.map(a => `"${a.name}"`).join(', ');
    return {
      error: `Error: Multiple running agents (${names}). Please specify agent NAME (e.g. gt ${actionName} <NAME>).`,
    };
  }

  static async stop(name?: string): Promise<{ success: boolean; pid?: number; name?: string; message: string }> {
    const sName = this.sanitizeName(name);
    let agent = sName ? this.getAgent(sName) : null;
    if (!agent && !sName) {
      const resolved = this.resolveTarget(undefined, 'stop');
      if (resolved.agent) agent = resolved.agent;
    }
    if (!agent || !agent.running) {
      const display = sName || (agent ? agent.name : 'daemon');
      return { success: true, message: `Agent "${display}" is not running.` };
    }

    const realName = agent.name;
    const pid = agent.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}

    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!this.isProcessAlive(pid)) {
        return { success: true, pid, name: realName, message: `Agent "${realName}" (PID: ${pid}) stopped successfully.` };
      }
      await new Promise(r => setTimeout(r, 100));
    }

    killProcessTreeSync(pid, 'SIGKILL');
    return { success: true, pid, name: realName, message: `Agent "${realName}" (PID: ${pid}) forcibly terminated.` };
  }

  static async stopAll(): Promise<any[]> {
    const all = this.getAllAgents();
    const running = all.filter(a => a.running);
    const results: any[] = [];
    for (const a of running) {
      results.push(await this.stop(a.name));
    }
    return results;
  }

  static remove(name?: string | null, { removeLogs = false }: { removeLogs?: boolean } = {}): { success: boolean; message: string } {
    const sName = this.sanitizeName(name);
    if (!sName) {
      return { success: false, message: 'Error: Agent name is required.' };
    }
    const agent = this.getAgent(sName);
    if (agent && agent.running) {
      return { success: false, message: `Error: Cannot remove running agent "${sName}". Stop it first.` };
    }
    this.clearStatus(sName);
    if (removeLogs) {
      try {
        const lf = path.join(this.getAgentsDir(), `${sName}.log`);
        if (fs.existsSync(lf)) fs.unlinkSync(lf);
      } catch {}
    }
    return { success: true, message: `Agent "${sName}" removed.` };
  }

  static removeAll(): { removed: string[] } {
    const all = this.getAllAgents();
    const removed: string[] = [];
    for (const a of all) {
      if (!a.running) {
        this.remove(a.name, { removeLogs: true });
        removed.push(a.name);
      }
    }
    return { removed };
  }

  static async getLogs(name?: string, lines: number = 50, follow: boolean = false): Promise<void> {
    let sName = this.sanitizeName(name);
    if (!sName) {
      const resolved = this.resolveTarget(undefined, 'logs');
      if (resolved.agent) sName = resolved.agent.name;
    }
    const logFile = path.join(this.getAgentsDir(), `${sName || 'agent'}.log`);
    if (!fs.existsSync(logFile)) {
      console.log(`No logs found for agent "${sName || 'daemon'}".`);
      return;
    }

    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const count = parseInt(String(lines), 10) || 50;
    const slice = allLines.slice(-count);
    if (slice.length > 0) {
      process.stdout.write(slice.join('\n') + '\n');
    }

    if (!follow) return;

    let currentSize = fs.statSync(logFile).size;
    const pollInterval = 200;

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          if (!fs.existsSync(logFile)) return;
          const newSize = fs.statSync(logFile).size;
          if (newSize > currentSize) {
            const stream = fs.createReadStream(logFile, {
              start: currentSize,
              end: newSize - 1,
              encoding: 'utf-8',
            });
            stream.on('data', chunk => process.stdout.write(chunk));
            currentSize = newSize;
          } else if (newSize < currentSize) {
            currentSize = newSize;
          }
        } catch {}
      }, pollInterval);

      const cleanup = () => {
        clearInterval(timer);
        resolve();
      };

      process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
      });
    });
  }
}

export async function runAgent(agentArgs: string[] = [], globalOpts: Record<string, any> = {}): Promise<void> {
  const firstArg = agentArgs[0];
  const subCmd = (firstArg && !firstArg.startsWith('-')) ? firstArg.toLowerCase() : null;

  const options: Record<string, any> = {};
  let positionalName: string | null = null;
  const knownSubCmds = ['start', 'restart', 'run', 'status', 'ps', 'stop', 'logs', 'rm', 'prune'];

  for (let i = 0; i < agentArgs.length; i++) {
    const arg = agentArgs[i];
    if (arg === '-s' || arg === '--server') {
      options.server = agentArgs[++i];
    } else if (arg.startsWith('--server=')) {
      options.server = arg.slice(9);
    } else if (arg.startsWith('-s=')) {
      options.server = arg.slice(3);
    } else if (arg === '-k' || arg === '--key') {
      options.key = agentArgs[++i];
    } else if (arg.startsWith('--key=')) {
      options.key = arg.slice(6);
    } else if (arg.startsWith('-k=')) {
      options.key = arg.slice(3);
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx).trim();
        const v = arg.slice(eqIdx + 1).trim();
        options[k] = v;
      } else {
        const k = arg.slice(2).trim();
        if (i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) {
          options[k] = agentArgs[++i];
        } else {
          options[k] = true;
        }
      }
    } else if (arg.startsWith('-') && arg !== '-d') {
      const k = arg.slice(1);
      if (i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) {
        options[k] = agentArgs[++i];
      }
    } else if (!arg.startsWith('-')) {
      if (!knownSubCmds.includes(arg.toLowerCase()) && !positionalName) {
        positionalName = arg;
      }
    }
  }

  // Lifecycle subcommands that don't start the agent
  if (subCmd === 'ps') {
    const showAll = agentArgs.includes('-a') || agentArgs.includes('--all');
    AgentDaemonManager.printAgentsTable(showAll);
  }

  if (subCmd === 'prune') {
    const { removed } = AgentDaemonManager.prune();
    if (removed.length === 0) {
      console.log('No stopped agents to prune.');
    } else {
      console.log(`Pruned stopped agents: ${removed.join(', ')}`);
    }
    process.exit(0);
  }

  if (subCmd === 'status') {
    const all = AgentDaemonManager.getAllAgents();
    const running = all.filter(a => a.running);
    if (running.length === 0) {
      console.log('No background agent running.');
      process.exit(0);
    }
    console.log(
      'STATUS'.padEnd(12) +
      'PID'.padEnd(10) +
      'HOST NAME'.padEnd(25) +
      'TARGET HUB'.padEnd(30) +
      'STARTED'
    );
    console.log('-'.repeat(95));
    for (const status of running) {
      console.log(
        'Running'.padEnd(12) +
        String(status.pid).padEnd(10) +
        (status.name || '').padEnd(25) +
        (status.server || '').padEnd(30) +
        (status.startTime || '')
      );
    }
    process.exit(0);
  }

  if (subCmd === 'stop') {
    const hasAll = agentArgs.includes('--all') || agentArgs.includes('-a');
    if (hasAll) {
      const results = await AgentDaemonManager.stopAll();
      if (results.length === 0) {
        console.log('No running agents to stop.');
      } else {
        for (const r of results) {
          console.log(r.message);
        }
      }
      process.exit(0);
    }

    const resolved = AgentDaemonManager.resolveTarget(positionalName || undefined, 'stop');
    if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }

    const res = await AgentDaemonManager.stop(resolved.agent.name);
    console.log(res.message);
    process.exit(0);
  }

  if (subCmd === 'logs') {
    let lines = 50;
    let follow = false;
    let targetName = positionalName;
    const logArgs = agentArgs.slice(1);
    for (let i = 0; i < logArgs.length; i++) {
      const a = logArgs[i];
      if (a === '-f' || a === '--follow') {
        follow = true;
      } else if (a === '-n' || a === '--lines') {
        lines = parseInt(logArgs[++i], 10) || 50;
      } else if (a.startsWith('-n=')) {
        lines = parseInt(a.slice(3), 10) || 50;
      } else if (a.startsWith('--lines=')) {
        lines = parseInt(a.slice(8), 10) || 50;
      } else if (!a.startsWith('-') && !targetName) {
        targetName = a;
      }
    }
    const resolved = AgentDaemonManager.resolveTarget(targetName || undefined, 'logs');
    if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }
    await AgentDaemonManager.getLogs(resolved.agent.name, lines, follow);
    process.exit(0);
  }

  if (subCmd === 'rm') {
    const hasAll = agentArgs.includes('--all') || agentArgs.includes('-a');
    if (hasAll) {
      const { removed } = AgentDaemonManager.removeAll();
      if (removed.length === 0) {
        console.log('No stopped agents to remove.');
      } else {
        console.log(`Removed agents: ${removed.join(', ')}`);
      }
      process.exit(0);
    }

    let targetName = positionalName;
    if (!targetName) {
      const resolved = AgentDaemonManager.resolveTarget(undefined, 'remove');
      if (resolved.agent) {
        targetName = resolved.agent.name;
      } else {
        console.error('Error: Please specify agent NAME to remove (e.g. gt agent rm <NAME>).');
        process.exit(1);
      }
    }

    const res = AgentDaemonManager.remove(targetName, { removeLogs: true });
    if (!res.success) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(res.message);
    process.exit(0);
  }

  if (subCmd && !['start', 'restart', 'run'].includes(subCmd)) {
    console.error(`Error: Unknown agent subcommand: '${subCmd}'.`);
    console.error("Usage: gt agent [start|-d|status|ps|stop|restart|logs|rm] [OPTIONS]");
    process.exit(1);
  }

  const hostname = os.hostname();
  const sanitizedHostname = hostname.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';
  const defaultName = sanitizedHostname;

  let sanitizedName = options.name
    ? AgentDaemonManager.sanitizeName(options.name)
    : (positionalName ? AgentDaemonManager.sanitizeName(positionalName) : '');

  // If subcommand is restart and no name was explicitly given, resolve target dynamically
  if (subCmd === 'restart' && !sanitizedName) {
    const resolved = AgentDaemonManager.resolveTarget(undefined, 'restart');
    if (resolved.agent) {
      sanitizedName = resolved.agent.name;
    } else if (resolved.error) {
      console.error(resolved.error);
      process.exit(1);
    }
  }

  const hostName = sanitizedName || defaultName;

  const machineId = ConfigStore.getMachineId();
  let hostId = options.id || options.hostId;
  if (!hostId) {
    if (hostName === sanitizedHostname) {
      hostId = machineId;
    } else {
      hostId = `${machineId}-${hostName}`;
    }
  }

  if (subCmd === 'restart') {
    await AgentDaemonManager.stop(hostName);
  }

  // Resolve effective credentials
  const effectiveConfig = ConfigStore.getEffectiveConfig({
    server: options.server || globalOpts.cliServer || globalOpts.server,
    key: options.key || globalOpts.cliKey || globalOpts.key,
  });
  const serverArg = effectiveConfig.server;
  const adminKey = effectiveConfig.key;

  if (!serverArg || !adminKey) {
    console.error("Error: No authenticated server found. Please run 'gt auth login <server> <key>' first.");
    process.exit(1);
  }

  const isInternalDaemon = agentArgs.includes('--internal-daemon');
  const isDaemon = subCmd === 'start' || subCmd === 'restart' || agentArgs.includes('-d') || agentArgs.includes('--detach');

  if (!isInternalDaemon) {
    const current = AgentDaemonManager.getAgent(hostName);
    if (current && current.running) {
      console.error(`Error: Agent "${hostName}" is already running (PID: ${current.pid}). Use 'gt stop ${hostName}' or 'gt restart ${hostName}'.`);
      process.exit(1);
    }
  }

  if (isDaemon && !isInternalDaemon) {
    const cleanArgs: string[] = [];
    for (let i = 0; i < agentArgs.length; i++) {
      const a = agentArgs[i];
      if (knownSubCmds.includes(a.toLowerCase()) || a === '-d' || a === '--detach' || a === '--internal-daemon') {
        continue;
      }
      if (a === '--name' || a === '--id' || a === '--hostId' || a === '-s' || a === '--server' || a === '-k' || a === '--key') {
        i++;
        continue;
      }
      if (
        a.startsWith('--name=') ||
        a.startsWith('--id=') ||
        a.startsWith('--hostId=') ||
        a.startsWith('--server=') ||
        a.startsWith('-s=') ||
        a.startsWith('--key=') ||
        a.startsWith('-k=')
      ) {
        continue;
      }
      if (a === positionalName) {
        continue;
      }
      cleanArgs.push(a);
    }
    cleanArgs.push(`--name=${hostName}`);
    cleanArgs.push(`--id=${hostId}`);
    cleanArgs.push(`--server=${serverArg}`);
    cleanArgs.push(`--key=${adminKey}`);

    const logFile = AgentDaemonManager.getLogFile(hostName);
    const logFd = fs.openSync(logFile, 'a', 0o600);

    const scriptPath = process.argv[1] || path.resolve(__filename);
    const child = spawn(
      process.execPath,
      [scriptPath, 'agent', '--internal-daemon', ...cleanArgs],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      }
    );

    AgentDaemonManager.saveStatus(hostName, {
      pid: child.pid,
      name: hostName,
      id: hostId,
      server: serverArg,
      startTime: new Date().toISOString(),
      logFile: logFile,
    });

    child.unref();
    fs.closeSync(logFd);

    console.log(`Agent started in background (PID: ${child.pid}, Host: ${hostName})`);
    console.log(`Logs: ${logFile}`);
    console.log(`Run 'gt agent logs -f ${hostName}' to follow logs.`);
    console.log(`Run 'gt agent stop ${hostName}' to stop agent.`);
    process.exit(0);
  }

  if (!isDaemon && !isInternalDaemon) {
    AgentDaemonManager.saveStatus(hostName, {
      pid: process.pid,
      name: hostName,
      id: hostId,
      server: serverArg,
      startTime: new Date().toISOString(),
    });
    const cleanupFg = () => {
      AgentDaemonManager.clearStatus(hostName);
    };
    process.on('exit', cleanupFg);
    process.on('SIGINT', cleanupFg);
    process.on('SIGTERM', cleanupFg);
  }

  const platform = os.platform();
  const localIp = getLocalIp();

  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    console.log('[Agent] Loaded .env configuration');
  }

  console.log('---------------------------------------------------------');
  console.log(' Gemini Proxy Terminal Reverse Agent (gt agent)');
  console.log(` Host ID   : ${hostId}`);
  console.log(` Host Name : ${hostName} (${hostname})`);
  console.log(` IP / OS   : ${localIp} / ${platform}`);
  console.log(` Target Hub: ${serverArg}`);
  console.log('---------------------------------------------------------');

  let ptyProcess: any = null;
  let ws: any = null;
  let streamSessionManager: StreamSessionManager | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let isExiting = false;
  let connectTimeoutTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  const pendingOutputQueue: Buffer[] = [];
  const maxPendingQueueBytes = 256 * 1024; // 256KB early buffer
  let pendingQueueBytes = 0;
  let lastNudgeTimestamp = 0;
  let nudgeRestoreTimer: NodeJS.Timeout | null = null;

  const WebSocket = getWebSocketCtor();
  const pty = tryRequirePty();

  function flushPendingOutput() {
    if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN) && pendingOutputQueue.length > 0) {
      while (pendingOutputQueue.length > 0) {
        const chunk = pendingOutputQueue.shift()!;
        pendingQueueBytes -= chunk.length;
        try {
          ws.send(chunk);
        } catch {
          break;
        }
      }
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
        try {
          ws.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
        } catch {}

        if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = setTimeout(() => {
          console.warn(
            `[Agent] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS / 1000}s) on ${serverArg}. Terminating dead connection...`
          );
          if (ws) {
            try { ws.terminate(); } catch {}
          }
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function onHeartbeatActivity() {
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function spawnPty() {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }

    const shell = getDefaultShell(options);
    const cwd = process.env.HOME || process.cwd();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM_PROGRAM: 'gemini-proxy-agent',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN || '1',
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.STY;
    delete env.WINDOW;
    delete env.TERM_SESSION_ID;

    const cols = 80;
    const rows = 24;

    const sendToWs = (data: any) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN) && pendingOutputQueue.length === 0) {
        try {
          ws.send(buf);
          return;
        } catch {}
      }
      pendingOutputQueue.push(buf);
      pendingQueueBytes += buf.length;
      while (pendingQueueBytes > maxPendingQueueBytes && pendingOutputQueue.length > 0) {
        const dropped = pendingOutputQueue.shift()!;
        pendingQueueBytes -= dropped.length;
      }
      if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
        flushPendingOutput();
      }
    };

    // 1. Layer 1: node-pty (C++ native addon)
    if (pty) {
      try {
        const proc = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env,
        });

        proc.onData((data: any) => {
          sendToWs(data);
        });

        proc.onExit(({ exitCode }: { exitCode: number }) => {
          console.log(`[PTY] Shell exited with code: ${exitCode}`);
          ptyProcess = null;
          if (!isExiting) {
            setTimeout(spawnPty, 500);
          }
        });

        ptyProcess = proc;
        console.log(`[PTY] Shell spawned via node-pty: ${shell} (pid=${ptyProcess.pid})`);
        return;
      } catch (err: any) {
        console.warn(`[PTY] node-pty spawn failed: ${err.message}, attempting fallback...`);
        ptyProcess = null;
      }
    }

    // 2. Layer 2: PosixPtyDriver (Python 3 system PTY fallback)
    if (!ptyProcess && hasSystemPython3()) {
      try {
        const driver = new PosixPtyDriver({
          command: shell,
          shell,
          cwd,
          env,
          cols,
          rows,
          onData: (data: any) => {
            sendToWs(data);
          },
          onExit: (code: any) => {
            console.log(`[PTY] Shell (PosixPty) exited with code: ${code}`);
            ptyProcess = null;
            if (!isExiting) {
              setTimeout(spawnPty, 500);
            }
          },
        });

        ptyProcess = {
          pid: driver.proc ? driver.proc.pid : 0,
          cols,
          rows,
          write: (data: any) => driver.write(data),
          resize: (c: number, r: number) => {
            ptyProcess.cols = c;
            ptyProcess.rows = r;
            driver.resize(c, r);
          },
          kill: (sig: any) => driver.kill(sig),
        };

        console.log(`[PTY] Shell spawned via PosixPty (Python 3): ${shell} (pid=${ptyProcess.pid})`);
        return;
      } catch (err: any) {
        console.warn(`[PTY] PosixPty fallback failed: ${err.message}, attempting pipe fallback...`);
        ptyProcess = null;
      }
    }

    // 3. Layer 3: InteractivePipeDriver (Pure Pipe Fallback)
    if (!ptyProcess) {
      try {
        const driver = new InteractivePipeDriver({
          command: shell,
          shell,
          cwd,
          env,
          cols,
          rows,
          onData: (data: any) => {
            sendToWs(data);
          },
          onExit: (code: any) => {
            console.log(`[PTY] Shell (InteractivePipe) exited with code: ${code}`);
            ptyProcess = null;
            if (!isExiting) {
              setTimeout(spawnPty, 500);
            }
          },
        });

        ptyProcess = {
          pid: driver.proc ? driver.proc.pid : 0,
          cols,
          rows,
          write: (data: any) => driver.write(data),
          resize: (c: number, r: number) => {
            ptyProcess.cols = c;
            ptyProcess.rows = r;
            driver.resize(c, r);
          },
          kill: (sig: any) => driver.kill(sig),
        };

        console.log(`[PTY] Shell spawned via InteractivePipe: ${shell} (pid=${ptyProcess.pid})`);
        sendToWs(Buffer.from('\r\n\x1b[33m[Notice] node-pty not available on agent; running in interactive pipe fallback mode.\x1b[0m\r\n'));
        return;
      } catch (err: any) {
        console.error(`[PTY] All PTY drivers failed to spawn shell: ${err.message}`);
        ptyProcess = null;
        sendToWs(Buffer.from(`\r\n\x1b[31m[Error] Failed to spawn shell on agent: ${err.message}\x1b[0m\r\n`));
      }
    }
  }

  function connect() {
    if (isExiting) return;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();

    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {}
      ws = null;
    }

    const targetWsUrl = resolveWebSocketUrl(serverArg, {
      hostId,
      name: hostName,
      hostname,
      ip: localIp,
      platform,
    });
    console.log(`[Agent] Connecting to ${targetWsUrl.split('?')[0]}...`);

    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = setTimeout(() => {
      console.warn(`[Agent] Connection to ${serverArg} timed out (${HANDSHAKE_TIMEOUT_MS / 1000}s)`);
      if (ws) {
        try { ws.terminate(); } catch {}
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws = new WebSocket(targetWsUrl, {
      headers: { 'x-admin-key': adminKey },
    });

    ws.on('upgrade', (response: any) => {
      if (ws && ws._socket && typeof ws._socket.setKeepAlive === 'function') {
        ws._socket.setKeepAlive(true, 10000);
      }
    });

    ws.on('open', () => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      console.log(`[Agent] Connected and registered successfully! Reverse tunnel is active.`);

      startHeartbeat();

      const isFirstSpawn = !ptyProcess;
      if (!ptyProcess) {
        spawnPty();
      }

      try {
        streamSessionManager = new StreamSessionManager((data: any) => {
          if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
            ws.send('JSON:' + JSON.stringify(data));
          }
        });

        if (isFirstSpawn) {
          ws.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
        }
        if (ptyProcess) {
          ws.send(`JSON:${JSON.stringify({ type: 'resize', cols: ptyProcess.cols, rows: ptyProcess.rows })}`);
        }
        flushPendingOutput();
      } catch {}
    });

    ws.on('message', (data: any) => {
      onHeartbeatActivity();
      try {
        const msgStr = data.toString();
        const control = parseControlMessage(msgStr);
        if (control) {
          if (control.type === 'file_rpc') {
            handleFileRpc(control, ws);
            return;
          }
          if (control.type === 'cmd_exec') {
            if (control.action === 'start_stream') {
              if (streamSessionManager) {
                streamSessionManager.startStream(control);
              }
              return;
            }
            handleCmdExec(control, ws);
            return;
          }
          if (control.type === 'cmd_stream_input') {
            if (streamSessionManager) {
              streamSessionManager.writeInput(control.taskId, control.data);
            }
            return;
          }
          if (control.type === 'cmd_stream_resize') {
            if (streamSessionManager) {
              streamSessionManager.resize(control.taskId, control.cols, control.rows);
            }
            return;
          }
          if (control.type === 'cmd_stream_kill') {
            if (streamSessionManager) {
              streamSessionManager.kill(control.taskId, control.signal);
            }
            return;
          }
          if (control.type === 'resize') {
            const cols = Math.max(10, Math.min(500, Math.floor(control.cols || 80)));
            const rows = Math.max(5, Math.min(200, Math.floor(control.rows || 24)));
            if (ptyProcess) {
              const currentCols = ptyProcess.cols;
              const currentRows = ptyProcess.rows;
              if (typeof currentCols === 'number' && typeof currentRows === 'number' && currentCols === cols && currentRows === rows) {
                // Dimensions match: Linux kernel TIOCSWINSZ will not emit SIGWINCH on identical size.
                // Briefly nudge rows by 1 and restore to force kernel SIGWINCH so shells (bash/zsh) redraw prompt.
                const now = Date.now();
                if (!nudgeRestoreTimer && (now - lastNudgeTimestamp > 1000)) {
                  lastNudgeTimestamp = now;
                  const nudgeRows = rows > 5 ? rows - 1 : rows + 1;
                  ptyProcess.resize(cols, nudgeRows);
                  nudgeRestoreTimer = setTimeout(() => {
                    nudgeRestoreTimer = null;
                    if (ptyProcess) {
                      ptyProcess.resize(cols, rows);
                    }
                  }, 30);
                }
              } else {
                try {
                  ptyProcess.resize(cols, rows);
                } catch {}
              }
            }
            return;
          }
          if (control.type === 'reset') {
            console.log('[Agent] Resetting PTY shell session...');
            spawnPty();
            if (ptyProcess && ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
              ws.send(`JSON:${JSON.stringify({ type: 'resize', cols: ptyProcess.cols, rows: ptyProcess.rows })}`);
            }
            return;
          }
          if (control.type === 'ping') {
            if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
              ws.send(`JSON:${JSON.stringify({ type: 'pong' })}`);
            }
            return;
          }
          if (control.type === 'pong') {
            return;
          }
          if (control.type === 'registered') {
            console.log(`[Agent] Registered confirmed: hostId=${control.hostId}, status=${control.status}`);
            return;
          }
          if (control.type === 'rejected') {
            isExiting = true;
            console.error(`\x1b[31m[Error] Registration rejected by server: ${control.reason || 'Name conflict'}\x1b[0m`);
            console.error('Please choose a different name using --name=<unique-name>.');
            if (ws) {
              try { ws.close(); } catch {}
            }
            process.exit(1);
          }
          return;
        }

        if (ptyProcess) {
          ptyProcess.write(msgStr);
        }
      } catch (err) {
        if (ptyProcess) {
          ptyProcess.write(data.toString());
        }
      }
    });

    ws.on('close', (code: number, reason: any) => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      stopHeartbeat();
      if (streamSessionManager) {
        streamSessionManager.killAll();
      }
      if (code === 4009) {
        isExiting = true;
        console.error(`\x1b[31m[Error] Registration rejected by server: ${reason?.toString() || 'Host name conflict'}\x1b[0m`);
        console.error('Please choose a different name using --name=<unique-name>.');
        process.exit(1);
      }
      console.warn(`[Agent] Connection closed (code: ${code}, reason: ${reason || 'none'})`);
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err: any) => {
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      stopHeartbeat();
      const msg = err && (err.message || err.code || err.name || String(err));
      console.error(`[Agent] Connection error: ${msg || 'Unknown error'}`);
    });
  }

  function scheduleReconnect() {
    if (isExiting) return;
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, Math.min(reconnectAttempts, 8)));
    console.log(`[Agent] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function cleanup() {
    if (isExiting) return;
    isExiting = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    console.log('\n[Agent] Shutting down agent...');
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (streamSessionManager) {
      streamSessionManager.killAll();
    }
    if (ptyProcess) {
      try { ptyProcess.kill('SIGTERM'); } catch {}
    }
    for (const task of taskManager.tasks.values()) {
      if (task.status === 'running' && task.child) {
        killProcessTree(task.child, 'SIGTERM');
        setTimeout(() => {
          if (task.child) killProcessTree(task.child, 'SIGKILL');
        }, 500);
      }
    }
    setTimeout(() => process.exit(0), 600);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('uncaughtException', (err: any) => {
    console.error('\n[Agent] Uncaught exception:', err);
    cleanup();
  });
  process.on('exit', () => {
    for (const task of taskManager.tasks.values()) {
      if (task.status === 'running' && task.child && task.child.pid) {
        try {
          killProcessTreeSync(task.child.pid, 'SIGKILL');
        } catch {}
      }
    }
  });

  if (pty) {
    spawnPty();
  }
  connect();
}
