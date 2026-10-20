import logger from '../../utils/logger';
import { rpcDispatcher, RpcDispatcher } from './rpcDispatcher';
import { StreamBatcher } from '../../shared/utils/streamBatcher';

export interface ManagedHost {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: 'online' | 'offline';
  lastSeen: number;
  startTime?: number;
  type: 'agent';
  machineId?: string;
  version?: string;
}

export function toHostDTO(host: ManagedHost): ManagedHost {
  const dto: ManagedHost = {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    ip: host.ip,
    platform: host.platform,
    status: host.status,
    lastSeen: host.lastSeen,
    type: host.type,
  };
  if (host.startTime !== undefined) dto.startTime = host.startTime;
  if (host.machineId !== undefined) dto.machineId = host.machineId;
  if (host.version !== undefined) dto.version = host.version;
  return dto;
}

export interface ITerminalSession {
  attach(ws: any): void;
  detach(ws: any): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  reset(notifyClients?: boolean, resetAgentPty?: boolean): void;
  destroy(): void;
}

export { stripTerminalQuerySequences } from '../../shared/utils/terminalSanitizer';
import { stripTerminalQuerySequences } from '../../shared/utils/terminalSanitizer';
import { TerminalHistoryBuffer } from '../../agent/pty/terminalHistoryBuffer';
import { StringDecoder } from 'string_decoder';

export class RemoteAgentTerminalSession implements ITerminalSession {
  public hostId: string;
  private agentWs: any = null;
  private activeSockets: Set<any> = new Set();
  private replayedSockets: WeakSet<any> = new WeakSet();
  private history: TerminalHistoryBuffer;
  private readonly maxBufferSize: number = 1 * 1024 * 1024; // 1MB scrollback
  private currentCols: number = 0;
  private currentRows: number = 0;
  private broadcastBatcher: StreamBatcher;
  private utf8Decoder: StringDecoder = new StringDecoder('utf8');
  private idleEvictionTimer: NodeJS.Timeout | null = null;
  private static readonly IDLE_EVICTION_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly HISTORY_CHUNK_SIZE = 64 * 1024;
  private pendingInputBuffer: string[] = [];
  private pendingInputBytes: number = 0;
  private readonly maxPendingInputBytes: number = 4 * 1024;

  constructor(hostId: string, agentWs?: any) {
    this.hostId = hostId;
    this.agentWs = agentWs;
    this.history = new TerminalHistoryBuffer(this.maxBufferSize, false);
    this.broadcastBatcher = new StreamBatcher((batchedText) => {
      const deadSockets: any[] = [];
      for (const ws of this.activeSockets) {
        try {
          if (ws.readyState === 1) {
            if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > 2 * 1024 * 1024) {
              logger.warn(`[RemoteAgentTerminal:${this.hostId}] Dropping frame for slow client socket (bufferedAmount=${ws.bufferedAmount})`);
              continue;
            }
            ws.send(batchedText);
          } else {
            deadSockets.push(ws);
          }
        } catch {
          deadSockets.push(ws);
        }
      }
      for (const dead of deadSockets) {
        this.activeSockets.delete(dead);
      }
    }, 16);
  }

  public updateAgentWs(agentWs: any): void {
    this.agentWs = agentWs;
    this.currentCols = 0;
    this.currentRows = 0;
    if (this.agentWs && this.agentWs.readyState === 1 && this.pendingInputBuffer.length > 0) {
      for (const item of this.pendingInputBuffer) {
        try {
          this.agentWs.send(item);
        } catch (err: any) {
          logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to flush buffered input: ${err.message}`);
        }
      }
      this.pendingInputBuffer = [];
      this.pendingInputBytes = 0;
    }
  }

  public getAgentWs(): any {
    return this.agentWs;
  }

  public getCurrentDimensions(): { cols: number; rows: number } {
    return { cols: this.currentCols, rows: this.currentRows };
  }

  private sendHistoryChunks(ws: any, sanitized: string): void {
    if (sanitized.length <= RemoteAgentTerminalSession.HISTORY_CHUNK_SIZE) {
      ws.send(sanitized);
      return;
    }
    for (let i = 0; i < sanitized.length; i += RemoteAgentTerminalSession.HISTORY_CHUNK_SIZE) {
      const chunk = sanitized.slice(i, i + RemoteAgentTerminalSession.HISTORY_CHUNK_SIZE);
      ws.send(chunk);
    }
  }

  public attach(ws: any): void {
    // Prune stale or closed sockets before attaching new socket
    for (const client of this.activeSockets) {
      if (!client || client.readyState > 1) {
        this.activeSockets.delete(client);
      }
    }
    this.activeSockets.add(ws);
    this.cancelIdleEviction();

    // Replay history buffer atomically as a single combined stream with query sequences stripped to prevent echo storms
    if (this.history.getSize() > 0 && ws.readyState === 1) {
      try {
        const sanitized = this.history.getSanitizedString();
        if (sanitized.length > 0) {
          this.sendHistoryChunks(ws, sanitized);
          this.replayedSockets.add(ws);
        }
      } catch {
        // Ignore socket write errors during replay
      }
    } else if (this.history.getSize() === 0 && this.agentWs && this.agentWs.readyState === 1) {
      // Hub has no cached history (e.g. Hub restarted or cache was pruned) -> request from Agent on demand
      try {
        this.agentWs.send(`JSON:${JSON.stringify({ type: 'history_req' })}`);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to request history from agent: ${err.message}`);
      }
    }
  }

  public detach(ws: any): void {
    this.activeSockets.delete(ws);
    if (this.activeSockets.size === 0) {
      this.scheduleIdleEviction();
    }
  }

  public write(data: string): void {
    if (this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(data);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send data to agent: ${err.message}`);
      }
    } else {
      this.pendingInputBuffer.push(data);
      this.pendingInputBytes += data.length;
      while (this.pendingInputBytes > this.maxPendingInputBytes && this.pendingInputBuffer.length > 0) {
        const shifted = this.pendingInputBuffer.shift()!;
        this.pendingInputBytes -= shifted.length;
      }
    }
  }

  public resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    // Suppress redundant PTY resizes to prevent unnecessary SIGWINCH and prompt duplicates
    if (this.currentCols === cols && this.currentRows === rows) {
      return;
    }
    this.currentCols = cols;
    this.currentRows = rows;
    if (this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(`JSON:${JSON.stringify({ type: 'resize', cols, rows })}`);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send resize to agent: ${err.message}`);
      }
    }
  }

  public handleHistorySync(history: Buffer | string): void {
    const raw = Buffer.isBuffer(history)
      ? history.toString('utf-8')
      : (typeof history === 'string' ? history : String(history));
    if (!raw) return;
    const sanitized = stripTerminalQuerySequences(raw);
    this.history.clear();
    this.history.push(sanitized);

    // Immediately push to any active clients that haven't received history replay
    for (const ws of this.activeSockets) {
      if (ws.readyState === 1 && !this.replayedSockets.has(ws)) {
        try {
          this.sendHistoryChunks(ws, sanitized);
          this.replayedSockets.add(ws);
        } catch {
          // Ignore socket write errors during replay
        }
      }
    }
  }

  public notifyAgentDisconnected(): void {
    const offlineMsg = `JSON:${JSON.stringify({ type: 'agent_offline', hostId: this.hostId })}`;
    for (const ws of this.activeSockets) {
      try {
        if (ws && ws.readyState === 1) {
          ws.send(offlineMsg);
        }
        if (ws && typeof ws.close === 'function') {
          ws.close(1012, 'Agent disconnected');
        }
      } catch {
        // Ignore write/close errors
      }
    }
    this.activeSockets.clear();
  }

  private scheduleIdleEviction(): void {
    if (this.idleEvictionTimer) return;
    this.idleEvictionTimer = setTimeout(() => {
      this.idleEvictionTimer = null;
      if (this.activeSockets.size === 0 && this.history.getSize() > 0) {
        logger.debug(`[RemoteAgentTerminal:${this.hostId}] Evicted idle history buffer from Hub memory`);
        this.history.clear();
      }
    }, RemoteAgentTerminalSession.IDLE_EVICTION_MS);
    if (this.idleEvictionTimer && typeof this.idleEvictionTimer.unref === 'function') {
      this.idleEvictionTimer.unref();
    }
  }

  private cancelIdleEviction(): void {
    if (this.idleEvictionTimer) {
      clearTimeout(this.idleEvictionTimer);
      this.idleEvictionTimer = null;
    }
  }

  public reset(notifyClients: boolean = true, resetAgentPty: boolean = false): void {
    this.cancelIdleEviction();
    if (this.broadcastBatcher) {
      this.broadcastBatcher.flush();
    }
    this.history.clear();
    this.utf8Decoder = new StringDecoder('utf8');
    this.pendingInputBuffer = [];
    this.pendingInputBytes = 0;
    this.currentCols = 0;
    this.currentRows = 0;
    if (resetAgentPty && this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send reset to agent: ${err.message}`);
      }
    }
    if (notifyClients) {
      for (const ws of this.activeSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
            ws.send('\x1b[2J\x1b[H\x1b[3J');
          }
        } catch {
          // Ignore write errors
        }
      }
    }
  }

  public destroy(): void {
    this.cancelIdleEviction();
    if (this.broadcastBatcher) {
      this.broadcastBatcher.flush();
    }
    this.activeSockets.clear();
    this.history.clear();
    this.utf8Decoder = new StringDecoder('utf8');
    this.pendingInputBuffer = [];
    this.pendingInputBytes = 0;
    this.agentWs = null;
    this.currentCols = 0;
    this.currentRows = 0;
  }

  public flush(): void {
    if (this.broadcastBatcher) {
      this.broadcastBatcher.flush();
    }
  }

  public handleData(data: string | Buffer): void {
    if (typeof data === 'string' && data.startsWith('JSON:')) {
      return;
    }
    const text = typeof data === 'string'
      ? data
      : this.utf8Decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
    if (!text) return;
    this.history.push(text);
    this.broadcastBatcher.push(text);
  }

  public getHistory(): string {
    return this.history.getString();
  }
}

export class TerminalHostManager {
  public static readonly OFFLINE_HOST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private hosts: Map<string, ManagedHost> = new Map();
  private sessions: Map<string, RemoteAgentTerminalSession> = new Map();
  private pruneTimer: NodeJS.Timeout | null = null;
  private rpcDispatcher: RpcDispatcher;

  constructor(rpcDispatcherInstance?: RpcDispatcher) {
    this.rpcDispatcher = rpcDispatcherInstance || new RpcDispatcher();
    // Schedule periodic sweep every hour (unref so it doesn't block process exit)
    this.pruneTimer = setInterval(() => {
      this.pruneOfflineHosts(TerminalHostManager.OFFLINE_HOST_TTL_MS);
    }, 60 * 60 * 1000);
    if (this.pruneTimer && typeof this.pruneTimer.unref === 'function') {
      this.pruneTimer.unref();
    }
  }

  public resolveCanonicalHostId(input?: string): string | null {
    if (!input || !input.trim()) return null;
    const target = input.trim();

    // 1. Exact ID match
    if (this.hosts.has(target)) return target;

    // 2. Exact Name match (prefer online node)
    const matchingByName: ManagedHost[] = [];
    for (const host of this.hosts.values()) {
      if (host.name === target) {
        matchingByName.push(host);
      }
    }
    if (matchingByName.length > 0) {
      const online = matchingByName.find(h => h.status === 'online');
      return (online || matchingByName[0]).id;
    }

    // 3. Short ID prefix match (minimum 4 chars, like Docker)
    if (target.length >= 4) {
      const matchingPrefix: ManagedHost[] = [];
      for (const host of this.hosts.values()) {
        if (host.id.toLowerCase().startsWith(target.toLowerCase())) {
          matchingPrefix.push(host);
        }
      }
      if (matchingPrefix.length === 1) {
        return matchingPrefix[0].id;
      }
      if (matchingPrefix.length > 1) {
        const online = matchingPrefix.find(h => h.status === 'online');
        if (online) return online.id;
      }
    }

    return null;
  }

  public pruneOfflineHosts(maxAgeMs: number = TerminalHostManager.OFFLINE_HOST_TTL_MS): string[] {
    const now = Date.now();
    const prunedIds: string[] = [];

    for (const [id, host] of this.hosts.entries()) {
      if (host.status === 'offline') {
        const session = this.sessions.get(id);
        // SAFETY GUARD: If session has an active open WebSocket, this host is NOT actually offline!
        // Auto-heal it back to online rather than pruning it.
        if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
          host.status = 'online';
          host.lastSeen = now;
          logger.info(`[TerminalHostManager] Auto-healed active host ${id} during prune check`);
          continue;
        }

        const age = now - (host.lastSeen || 0);
        if (maxAgeMs <= 0 || age >= maxAgeMs) {
          prunedIds.push(id);
          if (session) {
            session.destroy();
            this.sessions.delete(id);
          }
          this.clearPendingRpcForHost(id);
          this.hosts.delete(id);
          logger.info(`[TerminalHostManager] Pruned offline host: ${id} (lastSeen: ${new Date(host.lastSeen).toISOString()})`);
        }
      }
    }

    return prunedIds;
  }

  public getHosts(): ManagedHost[] {
    this.pruneOfflineHosts(TerminalHostManager.OFFLINE_HOST_TTL_MS);

    // Auto-heal any host with an active open WebSocket
    for (const [id, host] of this.hosts.entries()) {
      if (host.status === 'offline') {
        const session = this.sessions.get(id);
        if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
          host.status = 'online';
          host.lastSeen = Date.now();
          logger.info(`[TerminalHostManager] Auto-healed active host to online: ${id}`);
        }
      }
    }

    const list = Array.from(this.hosts.values()).map(toHostDTO);
    return list.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'online' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  public getHost(hostIdOrName: string): ManagedHost | null {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) return null;
    const host = this.hosts.get(canonicalId);
    if (host && host.status === 'offline') {
      const session = this.sessions.get(canonicalId);
      if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
        host.status = 'online';
        host.lastSeen = Date.now();
        logger.info(`[TerminalHostManager] Auto-healed active host to online: ${canonicalId} in getHost`);
      }
    }
    return host || null;
  }

  public getSession(hostIdOrName?: string): RemoteAgentTerminalSession | null {
    if (!hostIdOrName || !hostIdOrName.trim()) return null;
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) return null;
    const host = this.hosts.get(canonicalId);
    const session = this.sessions.get(canonicalId);

    // Auto-heal if socket is active
    if (host && session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
      if (host.status !== 'online') {
        host.status = 'online';
        host.lastSeen = Date.now();
        logger.info(`[TerminalHostManager] Auto-healed host status to online for ${canonicalId} in getSession`);
      }
      return session;
    }

    if (!host || host.status !== 'online') {
      return null;
    }
    return session || null;
  }

  public isAgentOnline(agentIdentifier?: string): boolean {
    if (!agentIdentifier) return false;
    const hostId = this.resolveCanonicalHostId(agentIdentifier);
    if (!hostId) return false;
    const host = this.hosts.get(hostId);
    if (!host || host.status !== 'online') return false;
    const session = this.sessions.get(hostId);
    if (!session) return false;
    const ws = session.getAgentWs();
    return Boolean(ws && ws.readyState === 1);
  }

  public getAgentWs(agentIdentifier?: string): any | null {
    if (!agentIdentifier) return null;
    const hostId = this.resolveCanonicalHostId(agentIdentifier);
    if (!hostId) return null;
    const host = this.hosts.get(hostId);
    if (!host || host.status !== 'online') return null;
    const session = this.sessions.get(hostId);
    if (!session) return null;
    const ws = session.getAgentWs();
    if (ws && ws.readyState === 1) {
      return ws;
    }
    return null;
  }

  public registerHost(metadata: { id: string; name?: string; hostname?: string; ip?: string; platform?: string; version?: string; startTime?: number; type?: string }, agentWs?: any) {
    return this.registerAgent({
      hostId: metadata.id,
      name: metadata.name,
      hostname: metadata.hostname,
      ip: metadata.ip,
      platform: metadata.platform,
      version: metadata.version,
      startTime: metadata.startTime,
      agentWs,
    });
  }

  public unregisterHost(hostId: string, closingWs?: any): void {
    return this.unregisterAgent(hostId, closingWs);
  }

  public registerAgent(metadata: {
    hostId: string;
    name?: string;
    hostname?: string;
    ip?: string;
    platform?: string;
    machineId?: string;
    version?: string;
    startTime?: number;
    agentWs?: any;
  }): { success: boolean; host?: ManagedHost; error?: string } {
    const id = metadata.hostId.trim();
    const targetName = (metadata.name || metadata.hostname || id).trim();
    const machineId = (metadata.machineId || id).trim();

    // 1. Check for Machine ID conflict against active (online) nodes
    for (const [existingId, existingHost] of this.hosts.entries()) {
      if (existingHost.machineId === machineId) {
        const existingWs = this.sessions.get(existingId)?.getAgentWs();
        if (existingHost.status === 'online' && existingWs !== metadata.agentWs) {
          if (existingId !== id) {
            logger.warn(`[TerminalHostManager] Rejecting duplicate machine agent: machineId "${machineId}" is already held by active node "${existingHost.name}" (${existingId})`);
            return {
              success: false,
              error: `Conflict: Machine (${machineId}) already has an active agent '${existingHost.name}' (ID: ${existingId}) connected to this Hub. Each machine can only have ONE agent per Hub.`
            };
          }
        } else if (existingHost.status === 'offline') {
          if (existingId !== id) {
            // Auto-prune offline host to allow clean takeover
            const session = this.sessions.get(existingId);
            if (session) {
              session.destroy();
              this.sessions.delete(existingId);
            }
            this.clearPendingRpcForHost(existingId);
            this.hosts.delete(existingId);
            logger.info(`[TerminalHostManager] Pruned offline host with matching machineId "${machineId}": ${existingId}`);
          }
        }
      }
    }

    // 2. Check for name conflict against ACTIVE (online) nodes
    for (const [existingId, existingHost] of this.hosts.entries()) {
      if (existingId !== id && existingHost.name === targetName) {
        if (existingHost.status === 'online') {
          logger.warn(`[TerminalHostManager] Rejecting duplicate online host name "${targetName}" from ${id} (held by ${existingId})`);
          return {
            success: false,
            error: `Conflict: Host name '${targetName}' is already in use by active node '${existingId}'`
          };
        } else {
          // Auto-prune offline host to allow takeover
          const session = this.sessions.get(existingId);
          if (session) {
            session.destroy();
            this.sessions.delete(existingId);
          }
          this.clearPendingRpcForHost(existingId);
          this.hosts.delete(existingId);
          logger.info(`[TerminalHostManager] Pruned offline host with matching name "${targetName}": ${existingId}`);
        }
      }
    }

    // 3. Register or update host strictly under `id`
    let host = this.hosts.get(id);
    if (!host) {
      host = {
        id,
        name: targetName,
        hostname: metadata.hostname || id,
        ip: metadata.ip || '127.0.0.1',
        platform: metadata.platform || 'linux',
        status: 'online',
        lastSeen: Date.now(),
        startTime: metadata.startTime,
        type: 'agent',
        machineId,
        version: metadata.version,
      };
      this.hosts.set(id, host);
    } else {
      host.status = 'online';
      host.lastSeen = Date.now();
      host.name = targetName;
      host.machineId = machineId;
      delete (host as any).agentWs;
      if (metadata.startTime !== undefined) host.startTime = metadata.startTime;
      if (metadata.hostname) host.hostname = metadata.hostname;
      if (metadata.ip) host.ip = metadata.ip;
      if (metadata.platform) host.platform = metadata.platform;
      if (metadata.version) host.version = metadata.version;
    }

    let session = this.sessions.get(id);
    if (!session) {
      session = new RemoteAgentTerminalSession(id, metadata.agentWs);
      this.sessions.set(id, session);
    } else {
      // Agent reconnecting -> Supersede old WebSocket if different
      const oldWs = session.getAgentWs();
      if (oldWs && oldWs !== metadata.agentWs) {
        logger.info(`[TerminalHostManager] Superseding old agent socket for: ${id}`);
        try {
          if (oldWs.readyState === 1) {
            oldWs.close(1000, 'Superseded by new agent connection');
          }
        } catch {}
        session.updateAgentWs(metadata.agentWs);
        this.clearPendingRpcForHost(id);
      } else {
        session.updateAgentWs(metadata.agentWs);
      }
    }

    logger.info(`[TerminalHostManager] Agent registered: ${id} (${host.name})`);
    return { success: true, host };
  }

  public isCurrentAgentWs(hostId: string, ws: any): boolean {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);
    if (!session) return false;
    const currentWs = session.getAgentWs();
    if (!currentWs) return false;
    return currentWs === ws;
  }

  public unregisterAgent(hostId: string, closingWs?: any): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);

    // Stale socket close protection:
    // If closingWs is specified and doesn't match the current active agent socket in the session,
    // this event is from an old superseded connection. Do NOT mark offline!
    if (closingWs && session && session.getAgentWs() && session.getAgentWs() !== closingWs) {
      logger.info(`[TerminalHostManager] Ignoring unregister from stale agent socket for: ${canonicalId}`);
      return;
    }

    const host = this.hosts.get(canonicalId);
    if (host && host.type === 'agent') {
      host.status = 'offline';
      host.lastSeen = Date.now();
      logger.info(`[TerminalHostManager] Agent unregistered/offline: ${canonicalId}`);
    }
    if (session && (!closingWs || session.getAgentWs() === closingWs)) {
      session.notifyAgentDisconnected();
      session.updateAgentWs(null);
      this.clearPendingRpcForHost(canonicalId, `Agent ${canonicalId} disconnected; RPC cancelled`);
    }
  }

  public touchAgent(
    hostId: string,
    ws?: any,
    metadata?: { name?: string; hostname?: string; ip?: string; platform?: string; version?: string; startTime?: number }
  ): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const host = this.hosts.get(canonicalId);
    if (!host) {
      if (ws) {
        this.registerAgent({
          hostId: canonicalId,
          name: metadata?.name,
          hostname: metadata?.hostname,
          ip: metadata?.ip,
          platform: metadata?.platform,
          version: metadata?.version,
          startTime: metadata?.startTime,
          agentWs: ws,
        });
      }
      return;
    }

    const session = this.sessions.get(canonicalId);
    const currentWs = session ? session.getAgentWs() : null;

    // Guard against stale sockets:
    // If session already has an active open WebSocket that is NOT this `ws`,
    // then `ws` is an OLD STALE / superseded socket!
    // We must ignore this message and not let it hijack the session or status.
    if (session && currentWs && currentWs !== ws && currentWs.readyState === 1) {
      logger.info(`[TerminalHostManager] Ignoring touch from stale agent socket for: ${canonicalId}`);
      try {
        if (ws && typeof ws.close === 'function' && ws.readyState === 1) {
          ws.close(1000, 'Superseded by newer connection');
        }
      } catch {}
      return;
    }

    host.lastSeen = Date.now();
    if (metadata?.startTime !== undefined) {
      host.startTime = metadata.startTime;
    }
    if (metadata?.version) {
      host.version = metadata.version;
    }
    if (host.status !== 'online') {
      host.status = 'online';
      logger.info(`[TerminalHostManager] Agent status restored to online via message: ${canonicalId}`);
    }

    if (session && ws && currentWs !== ws) {
      session.updateAgentWs(ws);
    }
  }

  public handleAgentData(hostId: string, data: any): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);
    if (session) {
      session.handleData(data);
    }

    const host = this.hosts.get(canonicalId);
    if (host) {
      host.lastSeen = Date.now();
      host.status = 'online';
    }
  }

  public handleAgentHistorySync(hostId: string, history: Buffer | string): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);
    if (session) {
      session.handleHistorySync(history);
    }

    const host = this.hosts.get(canonicalId);
    if (host) {
      host.lastSeen = Date.now();
      host.status = 'online';
    }
  }

  public handleAgentRpcResponse(response: any): void {
    this.rpcDispatcher.handleAgentRpcResponse(response);
  }

  public handleAgentCmdRpcResponse(response: any): void {
    this.rpcDispatcher.handleAgentCmdRpcResponse(response);
  }

  public clearPendingRpcForHost(hostId: string, reason?: string): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    this.rpcDispatcher.clearPendingRpcForHost(canonicalId, reason);
  }

  public async executeCmdRpc(hostIdOrName: string, payload: { action: string; [key: string]: any }): Promise<any> {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    const session = this.getSession(canonicalId);
    if (!session) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    return this.rpcDispatcher.executeCmdRpc(session, canonicalId, payload);
  }

  public async executeFileRpc(
    hostIdOrName: string,
    payload: { action: string; path: string; params?: any },
    timeoutMs: number = 30000
  ): Promise<any> {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    const session = this.getSession(canonicalId);
    if (!session) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    return this.rpcDispatcher.executeFileRpc(session, canonicalId, payload, timeoutMs);
  }
}

export const terminalHostManager = new TerminalHostManager(rpcDispatcher);
export default terminalHostManager;
