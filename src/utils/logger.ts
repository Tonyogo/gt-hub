import config from '../../config/default';
import terminalLogService from '../terminal/services/terminalLogService';

const levels: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const getCurrentLevel = (): number => {
  const current = config.logLevel;
  return levels[current] !== undefined ? levels[current] : 2;
};

const getFormattedTimestamp = (): string => {
  try {
    const timeZone = config.timeZone || 'Asia/Shanghai';
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    return formatter.format(new Date());
  } catch {
    return new Date().toISOString();
  }
};

const log = (level: string, message: string, ...meta: any[]) => {
  const currentLevelNum = getCurrentLevel();
  if (levels[level] > currentLevelNum) {
    return;
  }

  const timestamp = getFormattedTimestamp();
  const formattedMeta = meta.length
    ? ' ' + meta.map(m => typeof m === 'object' ? JSON.stringify(m) : m).join(' ')
    : '';
  const fullMsg = `${message}${formattedMeta}`;

  terminalLogService.addLog(level, `[${timestamp}] [${level.toUpperCase()}] ${fullMsg}`);

  // Suppress all console logs during testing
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  console.log(`[${timestamp}] [${level.toUpperCase()}] ${fullMsg}`);
};

const logger = {
  error: (msg: string, ...meta: any[]) => log('error', msg, ...meta),
  warn: (msg: string, ...meta: any[]) => log('warn', msg, ...meta),
  info: (msg: string, ...meta: any[]) => log('info', msg, ...meta),
  debug: (msg: string, ...meta: any[]) => log('debug', msg, ...meta)
};

export default logger;
