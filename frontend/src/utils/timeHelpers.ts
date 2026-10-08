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
