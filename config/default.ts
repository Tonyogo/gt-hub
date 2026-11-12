import * as dotenv from 'dotenv';
import { isValidTimezone } from '../src/shared/utils/cronParser';
dotenv.config();

export interface HubConfig {
  host: string;
  port: number | string;
  adminSecretKey: string;
  logLevel: string;
  timeZone: string;
  enableUi: boolean;
  [key: string]: any;
}

export function resolveServerTimezone(): string {
  const fallback = 'Asia/Shanghai';
  let systemTz: string | undefined;
  try {
    systemTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  } catch {
    systemTz = undefined;
  }
  const candidates = [process.env.TIME_ZONE, process.env.TZ, systemTz];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed && trimmed !== 'local' && isValidTimezone(trimmed)) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: trimmed });
          return trimmed;
        } catch {}
      }
    }
  }
  return fallback;
}

export const DEFAULT_ADMIN_SECRET_KEY = 'gt-hub';

export function resolveAdminSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ADMIN_SECRET_KEY ?? env.GT_KEY;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return DEFAULT_ADMIN_SECRET_KEY;
}

export const config: HubConfig = {
  host: process.env.GT_HOST || '0.0.0.0',
  port: process.env.PORT ? (Number(process.env.PORT) || 8000) : 8000,
  adminSecretKey: resolveAdminSecretKey(process.env),
  logLevel: process.env.LOG_LEVEL || 'info',
  timeZone: resolveServerTimezone(),
  enableUi: process.env.ENABLE_UI !== 'false',
};

export default config;
