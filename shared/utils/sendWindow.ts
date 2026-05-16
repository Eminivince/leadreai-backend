/**
 * Send-window helpers. Shared between the backend (for preflight /
 * first-send computation) and the workers (for per-step send-time
 * enforcement). Pure — only depends on Intl, which is universally
 * available in Node and the browser.
 */

export interface SendWindow {
  startHour: number;    // 0-23, inclusive
  endHour: number;      // 1-24, exclusive (endHour=17 means last send at 16:xx)
  timezone: string;     // IANA, e.g. "Africa/Lagos"
  allowedDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
}

function getHourInTz(date: Date, tz: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(date);
  const val = parseInt(formatted.replace(/\D/g, ''), 10);
  if (isNaN(val)) {
    throw new Error(`Could not parse hour from Intl token: "${formatted}"`);
  }
  return val === 24 ? 0 : val;
}

function getDayOfWeekInTz(date: Date, tz: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(date);
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = days[formatted];
  if (day === undefined) {
    throw new Error(`Unexpected weekday token from Intl: "${formatted}"`);
  }
  return day;
}

export function isWithinSendWindow(sw: SendWindow, now: Date = new Date()): boolean {
  const hour = getHourInTz(now, sw.timezone);
  const dow = getDayOfWeekInTz(now, sw.timezone);
  return sw.allowedDays.includes(dow) && hour >= sw.startHour && hour < sw.endHour;
}

/**
 * Returns the next Date on/after `from` that falls within the send window.
 * Steps forward one hour at a time (bounded at 14 days) to stay simple and
 * correct across DST transitions without pulling in a TZ library.
 */
export function nextSendTime(sw: SendWindow, from: Date = new Date()): Date {
  const dt = new Date(from);
  for (let i = 0; i < 14 * 24; i++) {
    const hour = getHourInTz(dt, sw.timezone);
    const dow = getDayOfWeekInTz(dt, sw.timezone);
    if (sw.allowedDays.includes(dow) && hour >= sw.startHour && hour < sw.endHour) {
      return dt;
    }
    dt.setTime(dt.getTime() + 3_600_000);
  }
  return from;
}
