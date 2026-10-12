export interface RpcCallbackEntry {
  hostId: string;
  resolver: (response: any) => void;
}

export class RpcDispatcher {
  private rpcResolvers: Map<string, RpcCallbackEntry> = new Map();
  private cmdRpcResolvers: Map<string, RpcCallbackEntry> = new Map();

  public handleAgentRpcResponse(response: any): void {
    const { reqId } = response;
    if (reqId && this.rpcResolvers.has(reqId)) {
      const entry = this.rpcResolvers.get(reqId);
      this.rpcResolvers.delete(reqId);
      if (entry) {
        entry.resolver(response);
      }
    }
  }

  public handleAgentCmdRpcResponse(response: any): void {
    const { reqId } = response;
    if (reqId && this.cmdRpcResolvers.has(reqId)) {
      const entry = this.cmdRpcResolvers.get(reqId);
      this.cmdRpcResolvers.delete(reqId);
      if (entry) {
        entry.resolver(response);
      }
    }
  }

  public clearPendingRpcForHost(canonicalId: string, reason?: string): void {
    const rpcError = reason || `Agent ${canonicalId} reconnected; previous RPC cancelled`;
    const cmdRpcError = reason || `Agent ${canonicalId} reconnected; previous command RPC cancelled`;
    for (const [reqId, entry] of this.rpcResolvers.entries()) {
      if (entry.hostId === canonicalId) {
        entry.resolver({ success: false, error: rpcError });
        this.rpcResolvers.delete(reqId);
      }
    }
    for (const [reqId, entry] of this.cmdRpcResolvers.entries()) {
      if (entry.hostId === canonicalId) {
        entry.resolver({ success: false, error: cmdRpcError });
        this.cmdRpcResolvers.delete(reqId);
      }
    }
  }

  public async executeCmdRpc(
    session: any,
    canonicalId: string,
    payload: { action: string; [key: string]: any }
  ): Promise<any> {
    const reqId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rpcMsg = `JSON:${JSON.stringify({
      type: 'cmd_exec',
      reqId,
      ...payload,
    })}`;

    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        if (this.cmdRpcResolvers.has(reqId)) {
          this.cmdRpcResolvers.delete(reqId);
          resolve({ success: false, error: 'Agent command RPC request timed out (30s)' });
        }
      }, 30000);

      this.cmdRpcResolvers.set(reqId, {
        hostId: canonicalId,
        resolver: (response) => {
          clearTimeout(timeoutTimer);
          resolve(response);
        },
      });

      session.write(rpcMsg);
    });
  }

  public async executeFileRpc(
    session: any,
    canonicalId: string,
    payload: { action: string; path: string; params?: any },
    timeoutMs: number = 30000
  ): Promise<any> {
    const reqId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rpcMsg = `JSON:${JSON.stringify({
      type: 'file_rpc',
      reqId,
      ...payload,
    })}`;

    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        if (this.rpcResolvers.has(reqId)) {
          this.rpcResolvers.delete(reqId);
          resolve({ success: false, error: `Agent file request timed out (${Math.round(timeoutMs / 1000)}s)` });
        }
      }, timeoutMs);

      this.rpcResolvers.set(reqId, {
        hostId: canonicalId,
        resolver: (res) => {
          clearTimeout(timeoutTimer);
          resolve(res);
        },
      });

      session.write(rpcMsg);
    });
  }
}

export const rpcDispatcher = new RpcDispatcher();
export default rpcDispatcher;
