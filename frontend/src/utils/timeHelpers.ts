/**
 * 相对时间格式化工具函数
 * 将时间戳转换为相对于指定时间点的人类可读离线时长描述
 *
 * @param timestamp 目标时间戳（毫秒）
 * @param lang 语言代码 ('zh' | 'en')，默认为 'zh'
 * @param currentNow 当前时间戳（毫秒），默认为 Date.now()
 * @returns 相对时间文本
 */
export function formatRelativeTime(
  timestamp: number,
  lang: 'zh' | 'en' = 'zh',
  currentNow: number = Date.now()
): string {
  if (!timestamp || isNaN(timestamp)) return '';
  const diffMs = Math.max(0, currentNow - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) {
    return lang === 'zh' ? '刚刚离线' : 'Just now';
  }
  if (diffHour < 1) {
    return lang === 'zh' ? `离线于 ${diffMin}分钟前` : `Offline ${diffMin}m ago`;
  }
  if (diffDay < 1) {
    return lang === 'zh' ? `离线于 ${diffHour}小时前` : `Offline ${diffHour}h ago`;
  }
  return lang === 'zh' ? `离线于 ${diffDay}天前` : `Offline ${diffDay}d ago`;
}

/**
 * 将 IANA 时区标识符（如 "Asia/Shanghai"、"America/New_York"）转换为简洁的 UTC 偏移形式（如 "UTC+8"、"UTC-5"）
 *
 * @param timezone IANA 时区字符串
 * @returns 简洁时区字符串，解析失败时安全回退至原始时区名称
 */
export function formatTimezoneOffset(timezone: string): string {
  if (!timezone || typeof timezone !== 'string') return '';
  const trimmed = timezone.trim();
  if (!trimmed) return '';

  // 常见特殊与缩写快速匹配
  if (trimmed.toUpperCase() === 'UTC' || trimmed.toUpperCase() === 'GMT') {
    return 'UTC+0';
  }

  try {
    const now = new Date();
    // 尝试使用 Intl.DateTimeFormat 获取 shortOffset (如 "GMT+8" 或 "GMT-4")
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      timeZoneName: 'shortOffset',
    });
    const formatted = dtf.format(now);
    const offsetMatch = formatted.match(/GMT([+-]?\d+(?::\d+)?)/);
    if (offsetMatch) {
      const offset = offsetMatch[1];
      return offset.startsWith('+') || offset.startsWith('-') ? `UTC${offset}` : `UTC+${offset}`;
    }
    if (formatted.includes('GMT')) {
      return 'UTC+0';
    }
  } catch {}

  return trimmed;
}
