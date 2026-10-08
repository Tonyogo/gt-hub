import * as dotenv from 'dotenv';
dotenv.config();

export interface HubConfig {
  port: number | string;
  adminSecretKey: string;
  logLevel: string;
  timeZone: string;
  enableUi: boolean;
  [key: string]: any;
}

export const config: HubConfig = {
  port: process.env.PORT || 8080,
  adminSecretKey: process.env.ADMIN_SECRET_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  timeZone: process.env.TIME_ZONE || process.env.TZ || 'Asia/Shanghai',
  enableUi: process.env.ENABLE_UI !== 'false',
};

export default config;
