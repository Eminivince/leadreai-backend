export interface SendWindow {
  startHour: number;   // 0-23
  endHour: number;     // 0-23, exclusive (endHour=17 means last send at 16:xx)
  timezone: string;    // IANA timezone, e.g. "Africa/Lagos"
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
  // Intl may return "24" for midnight in some locales
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

export function nextSendTime(sw: SendWindow, from: Date = new Date()): Date {
  const dt = new Date(from);

  for (let i = 0; i < 14 * 24; i++) {
    const hour = getHourInTz(dt, sw.timezone);
    const dow = getDayOfWeekInTz(dt, sw.timezone);

    if (sw.allowedDays.includes(dow) && hour >= sw.startHour && hour < sw.endHour) {
      return dt;
    }
    // Advance by 1 hour
    dt.setTime(dt.getTime() + 3_600_000);
  }

  // Fallback: return as-is if no valid window found in 14 days
  return from;
}

export function isWithinSendWindow(sw: SendWindow, now: Date = new Date()): boolean {
  const hour = getHourInTz(now, sw.timezone);
  const dow = getDayOfWeekInTz(now, sw.timezone);
  return sw.allowedDays.includes(dow) && hour >= sw.startHour && hour < sw.endHour;
}
