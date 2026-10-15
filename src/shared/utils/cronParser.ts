export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  isDomWildcard: boolean;
  isDowWildcard: boolean;
}

interface FieldRange {
  min: number;
  max: number;
  name: string;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'dayOfMonth' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 7, name: 'dayOfWeek' },
];

function parseInteger(val: string, name: string): number {
  if (!/^\d+$/.test(val)) {
    throw new Error(`Invalid numeric value "${val}" for ${name}`);
  }
  return parseInt(val, 10);
}

function parseField(rawField: string, range: FieldRange): Set<number> {
  const values = new Set<number>();
  const items = rawField.split(',');

  if (items.length === 0 || rawField.trim() === '') {
    throw new Error(`Empty field definition for ${range.name}`);
  }

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`Invalid empty element in ${range.name}`);
    }

    if (trimmed === '*') {
      for (let i = range.min; i <= range.max; i++) {
        values.add(range.name === 'dayOfWeek' && i === 7 ? 0 : i);
      }
      continue;
    }

    if (trimmed.startsWith('*/')) {
      const stepStr = trimmed.slice(2);
      const step = parseInteger(stepStr, `step in ${range.name}`);
      if (step <= 0 || step > range.max) {
        throw new Error(`Invalid step value ${step} for ${range.name}`);
      }
      for (let i = range.min; i <= range.max; i += step) {
        values.add(range.name === 'dayOfWeek' && i === 7 ? 0 : i);
      }
      continue;
    }

    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length !== 2) {
        throw new Error(`Invalid step expression "${trimmed}" for ${range.name}`);
      }
      const step = parseInteger(parts[1], `step in ${range.name}`);
      if (step <= 0 || step > range.max) {
        throw new Error(`Invalid step value ${step} for ${range.name}`);
      }
      const rangeParts = parts[0].split('-');
      if (rangeParts.length !== 2) {
        throw new Error(`Invalid range with step "${trimmed}" for ${range.name}`);
      }
      const start = parseInteger(rangeParts[0], `start in ${range.name}`);
      const end = parseInteger(rangeParts[1], `end in ${range.name}`);
      if (start < range.min || end > range.max || start > end) {
        throw new Error(`Invalid range "${parts[0]}" for ${range.name} (valid: ${range.min}-${range.max})`);
      }
      for (let i = start; i <= end; i += step) {
        values.add(range.name === 'dayOfWeek' && i === 7 ? 0 : i);
      }
      continue;
    }

    if (trimmed.includes('-')) {
      const parts = trimmed.split('-');
      if (parts.length !== 2) {
        throw new Error(`Invalid range expression "${trimmed}" for ${range.name}`);
      }
      const start = parseInteger(parts[0], `start in ${range.name}`);
      const end = parseInteger(parts[1], `end in ${range.name}`);
      if (start < range.min || end > range.max || start > end) {
        throw new Error(`Invalid range "${trimmed}" for ${range.name} (valid: ${range.min}-${range.max})`);
      }
      for (let i = start; i <= end; i++) {
        values.add(range.name === 'dayOfWeek' && i === 7 ? 0 : i);
      }
      continue;
    }

    const num = parseInteger(trimmed, range.name);
    if (num < range.min || num > range.max) {
      throw new Error(`Value ${num} out of bounds for ${range.name} (${range.min}-${range.max})`);
    }
    values.add(range.name === 'dayOfWeek' && num === 7 ? 0 : num);
  }

  return values;
}

export function parseCronExpression(expr: string): ParsedCron {
  if (typeof expr !== 'string') {
    throw new Error('Cron expression must be a string');
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${parts.length} ("${expr}")`);
  }

  const minutes = parseField(parts[0], FIELD_RANGES[0]);
  const hours = parseField(parts[1], FIELD_RANGES[1]);
  const daysOfMonth = parseField(parts[2], FIELD_RANGES[2]);
  const months = parseField(parts[3], FIELD_RANGES[3]);
  const daysOfWeek = parseField(parts[4], FIELD_RANGES[4]);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    isDomWildcard: parts[2] === '*',
    isDowWildcard: parts[4] === '*',
  };
}

export function isValidCronExpression(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(tz?: string): boolean {
  if (!tz || tz === 'local') return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ParsedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function getTimezoneParts(date: Date, dtf: Intl.DateTimeFormat): ParsedDateParts {
  const parts = dtf.formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    switch (p.type) {
      case 'year':
        year = parseInt(p.value, 10);
        break;
      case 'month':
        month = parseInt(p.value, 10);
        break;
      case 'day':
        day = parseInt(p.value, 10);
        break;
      case 'hour': {
        const val = parseInt(p.value, 10);
        hour = val === 24 ? 0 : val;
        break;
      }
      case 'minute':
        minute = parseInt(p.value, 10);
        break;
      case 'second':
        second = parseInt(p.value, 10);
        break;
      case 'weekday': {
        const w = p.value;
        if (w === 'Sun') weekday = 0;
        else if (w === 'Mon') weekday = 1;
        else if (w === 'Tue') weekday = 2;
        else if (w === 'Wed') weekday = 3;
        else if (w === 'Thu') weekday = 4;
        else if (w === 'Fri') weekday = 5;
        else if (w === 'Sat') weekday = 6;
        break;
      }
    }
  }

  return { year, month, day, hour, minute, second, weekday };
}

function dateFromTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  dtf: Intl.DateTimeFormat,
  minTime?: number
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = getTimezoneParts(new Date(utcGuess), dtf);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const offset = asUtc - utcGuess;
  let result = new Date(utcGuess - offset);

  // Check if offset changed across DST boundary
  const resParts = getTimezoneParts(result, dtf);
  const resAsUtc = Date.UTC(resParts.year, resParts.month - 1, resParts.day, resParts.hour, resParts.minute, 0);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const diff = desiredUtc - resAsUtc;
  if (diff !== 0) {
    result = new Date(result.getTime() + diff);
  }

  if (minTime !== undefined && result.getTime() <= minTime) {
    result = new Date(minTime + 60000);
  }

  return result;
}

export function getNextCronTime(expr: string, fromDate?: Date, timezone?: string): Date {
  if (timezone && timezone !== 'local' && !isValidTimezone(timezone)) {
    throw new Error(`Invalid timezone "${timezone}"`);
  }

  const parsed = parseCronExpression(expr);
  const tz = (!timezone || timezone === 'local') ? 'local' : timezone;

  if (tz === 'local') {
    const current = new Date(fromDate ? fromDate.getTime() : Date.now());

    // Truncate seconds and milliseconds, then advance by 1 minute
    current.setSeconds(0, 0);
    current.setMinutes(current.getMinutes() + 1);

    const maxYear = current.getFullYear() + 5;

    while (current.getFullYear() <= maxYear) {
      // 1. Check Month
      const month = current.getMonth() + 1; // 1-12
      if (!parsed.months.has(month)) {
        current.setMonth(current.getMonth() + 1, 1);
        current.setHours(0, 0, 0, 0);
        continue;
      }

      // 2. Check Day (dayOfMonth and dayOfWeek)
      const dom = current.getDate();
      const dow = current.getDay(); // 0-6

      let dayMatches = false;
      if (parsed.isDomWildcard && parsed.isDowWildcard) {
        dayMatches = true;
      } else if (parsed.isDomWildcard && !parsed.isDowWildcard) {
        dayMatches = parsed.daysOfWeek.has(dow);
      } else if (!parsed.isDomWildcard && parsed.isDowWildcard) {
        dayMatches = parsed.daysOfMonth.has(dom);
      } else {
        dayMatches = parsed.daysOfMonth.has(dom) || parsed.daysOfWeek.has(dow);
      }

      if (!dayMatches) {
        current.setDate(current.getDate() + 1);
        current.setHours(0, 0, 0, 0);
        continue;
      }

      // 3. Check Hour
      const hour = current.getHours();
      if (!parsed.hours.has(hour)) {
        current.setHours(current.getHours() + 1, 0, 0, 0);
        continue;
      }

      // 4. Check Minute
      const minute = current.getMinutes();
      if (!parsed.minutes.has(minute)) {
        current.setMinutes(current.getMinutes() + 1, 0, 0);
        continue;
      }

      // All match found!
      return current;
    }

    throw new Error(`Unable to find next run time within 5 years for cron expression "${expr}"`);
  }

  if (tz === 'UTC') {
    const current = new Date(fromDate ? fromDate.getTime() : Date.now());

    // Truncate seconds and milliseconds, then advance by 1 minute
    current.setUTCSeconds(0, 0);
    current.setUTCMinutes(current.getUTCMinutes() + 1);

    const maxYear = current.getUTCFullYear() + 5;

    while (current.getUTCFullYear() <= maxYear) {
      // 1. Check Month
      const month = current.getUTCMonth() + 1; // 1-12
      if (!parsed.months.has(month)) {
        current.setUTCMonth(current.getUTCMonth() + 1, 1);
        current.setUTCHours(0, 0, 0, 0);
        continue;
      }

      // 2. Check Day (dayOfMonth and dayOfWeek)
      const dom = current.getUTCDate();
      const dow = current.getUTCDay(); // 0-6

      let dayMatches = false;
      if (parsed.isDomWildcard && parsed.isDowWildcard) {
        dayMatches = true;
      } else if (parsed.isDomWildcard && !parsed.isDowWildcard) {
        dayMatches = parsed.daysOfWeek.has(dow);
      } else if (!parsed.isDomWildcard && parsed.isDowWildcard) {
        dayMatches = parsed.daysOfMonth.has(dom);
      } else {
        dayMatches = parsed.daysOfMonth.has(dom) || parsed.daysOfWeek.has(dow);
      }

      if (!dayMatches) {
        current.setUTCDate(current.getUTCDate() + 1);
        current.setUTCHours(0, 0, 0, 0);
        continue;
      }

      // 3. Check Hour
      const hour = current.getUTCHours();
      if (!parsed.hours.has(hour)) {
        current.setUTCHours(current.getUTCHours() + 1, 0, 0, 0);
        continue;
      }

      // 4. Check Minute
      const minute = current.getUTCMinutes();
      if (!parsed.minutes.has(minute)) {
        current.setUTCMinutes(current.getUTCMinutes() + 1, 0, 0);
        continue;
      }

      // All match found!
      return current;
    }

    throw new Error(`Unable to find next run time within 5 years for cron expression "${expr}"`);
  }

  // Arbitrary IANA timezone
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  });

  const baseDate = new Date(fromDate ? fromDate.getTime() : Date.now());
  const initialParts = getTimezoneParts(baseDate, dtf);

  let current = dateFromTimezone(
    initialParts.year,
    initialParts.month,
    initialParts.day,
    initialParts.hour,
    initialParts.minute + 1,
    dtf,
    baseDate.getTime()
  );

  const maxYear = initialParts.year + 5;

  while (true) {
    const parts = getTimezoneParts(current, dtf);
    if (parts.year > maxYear) {
      break;
    }

    // 1. Check Month
    if (!parsed.months.has(parts.month)) {
      current = dateFromTimezone(parts.year, parts.month + 1, 1, 0, 0, dtf, current.getTime());
      continue;
    }

    // 2. Check Day
    let dayMatches = false;
    if (parsed.isDomWildcard && parsed.isDowWildcard) {
      dayMatches = true;
    } else if (parsed.isDomWildcard && !parsed.isDowWildcard) {
      dayMatches = parsed.daysOfWeek.has(parts.weekday);
    } else if (!parsed.isDomWildcard && parsed.isDowWildcard) {
      dayMatches = parsed.daysOfMonth.has(parts.day);
    } else {
      dayMatches = parsed.daysOfMonth.has(parts.day) || parsed.daysOfWeek.has(parts.weekday);
    }

    if (!dayMatches) {
      current = dateFromTimezone(parts.year, parts.month, parts.day + 1, 0, 0, dtf, current.getTime());
      continue;
    }

    // 3. Check Hour
    if (!parsed.hours.has(parts.hour)) {
      current = dateFromTimezone(parts.year, parts.month, parts.day, parts.hour + 1, 0, dtf, current.getTime());
      continue;
    }

    // 4. Check Minute
    if (!parsed.minutes.has(parts.minute)) {
      current = dateFromTimezone(parts.year, parts.month, parts.day, parts.hour, parts.minute + 1, dtf, current.getTime());
      continue;
    }

    // All match found!
    return current;
  }

  throw new Error(`Unable to find next run time within 5 years for cron expression "${expr}"`);
}
