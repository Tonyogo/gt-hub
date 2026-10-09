export type HostStatus = 'online' | 'offline';

export interface ManagedHost {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: HostStatus;
  lastSeen: number;
  type: 'agent';
  machineId?: string;
}

export interface HostInfo {
  id: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  status?: HostStatus;
  lastSeen?: number;
  machineId?: string;
}
