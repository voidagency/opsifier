const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** What a figure that was never read prints as. It must never look like a measured zero. */
export const NO_VALUE = "–";

/** A byte count for reading. A value that isn't a real number was never measured, so it prints as missing. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return NO_VALUE;
  }
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? amount : amount.toFixed(amount < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? NO_VALUE : `${value.toFixed(1)}%`;
}

/** How long something took, or has been taking when `to` is missing. Dashes before it starts. */
export function formatDuration(from: string | null, to: string | null, now: number = Date.now()): string {
  if (from === null) {
    return "--";
  }
  const end = to === null ? now : Date.parse(to);
  const totalSeconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** An exact moment, always with its date and time zone: the one way a date and time is shown. */
export function formatDateTime(at: string | number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
}

/** A time of day and its zone, for when the day goes without saying. */
export function formatClock(at: string | number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
}

/** The viewer's time zone, short, as in "UTC+1": for a heading over many times of day. */
export function timeZoneLabel(language: string, at: number = Date.now()): string {
  return (
    new Intl.DateTimeFormat(language, { timeZoneName: "short" })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

const RELATIVE_STEPS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 minutes ago", in the interface's language. */
export function formatRelativeTime(iso: string, language: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, step] of RELATIVE_STEPS) {
    if (Math.abs(seconds) >= step || unit === "second") {
      return formatter.format(Math.trunc(seconds / step), unit);
    }
  }
  return formatter.format(0, "second");
}
