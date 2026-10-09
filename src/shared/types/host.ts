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
}

export interface HostInfo {
  id: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  status?: HostStatus;
  lastSeen?: number;
}
