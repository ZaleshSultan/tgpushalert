export function eventTimeIso(
  event: {
    alert_at?: string | null;
    remind_at?: string | null;
    due_at: string | null;
    starts_at: string | null;
  },
): string | null {
  return event.alert_at || event.remind_at || event.due_at || event.starts_at;
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

export function humanRelativeTime(target: Date, now = new Date()): string {
  const minutes = minutesBetween(now, target);
  const abs = Math.abs(minutes);
  const suffix = minutes >= 0 ? "left" : "overdue";

  if (abs < 1) {
    return minutes >= 0 ? "now" : "just now";
  }
  if (abs < 60) {
    return `${abs}m ${suffix}`;
  }

  const hours = Math.floor(abs / 60);
  const restMinutes = abs % 60;
  if (hours < 24) {
    return restMinutes
      ? `${hours}h ${restMinutes}m ${suffix}`
      : `${hours}h ${suffix}`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h ${suffix}` : `${days}d ${suffix}`;
}

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function formatDateOnly(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function localDateString(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return [
    parts.year.toString().padStart(4, "0"),
    parts.month.toString().padStart(2, "0"),
    parts.day.toString().padStart(2, "0"),
  ].join("-");
}

export function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function weekdayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isSameLocalDate(
  iso: string,
  reference: Date,
  timeZone: string,
): boolean {
  const targetParts = zonedParts(new Date(iso), timeZone);
  const referenceParts = zonedParts(reference, timeZone);
  return targetParts.year === referenceParts.year &&
    targetParts.month === referenceParts.month &&
    targetParts.day === referenceParts.day;
}

export function tomorrowAtLocalHour(timeZone: string, hour = 9): Date {
  const nowParts = zonedParts(new Date(), timeZone);
  const base = new Date(
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day),
  );
  base.setUTCDate(base.getUTCDate() + 1);
  return zonedTimeToUtc({
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour,
    minute: 0,
    second: 0,
  }, timeZone);
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zonedTimeToUtc(parts: LocalParts, timeZone: string): Date {
  let utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const targetMs = utcMs;

  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(utcMs), timeZone);
    const actualMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    utcMs -= actualMs - targetMs;
  }

  return new Date(utcMs);
}
