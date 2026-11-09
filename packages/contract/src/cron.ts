/**
 * Five-field cron expressions: minute, hour, day of month, month, day of week. Lists, ranges, steps and
 * the English names of months and days. The same parser checks a form and drives the scheduler, so a
 * schedule that saves is always a schedule that runs.
 */

export interface CronSchedule {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** Whether the day-of-month field was `*`. */
  anyDayOfMonth: boolean;
  /** Whether the day-of-week field was `*`. */
  anyDayOfWeek: boolean;
}

export class CronError extends Error {
  override readonly name = "CronError";
}

interface FieldRange {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const FIELDS: readonly FieldRange[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  // 7 is accepted as another spelling of Sunday and folded back to 0 afterwards.
  { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES },
];

/** How far ahead a schedule is searched before it is declared impossible. Covers leap days. */
const MAX_SEARCH_DAYS = 8 * 366;

function parseValue(text: string, field: FieldRange): number {
  const named = field.names?.[text.toUpperCase()];
  if (named !== undefined) {
    return named;
  }
  if (!/^\d+$/.test(text)) {
    throw new CronError(`Invalid ${field.label}: ${text}`);
  }
  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw new CronError(`The ${field.label} must be between ${field.min} and ${field.max}`);
  }
  return value;
}

function parsePart(part: string, field: FieldRange, out: Set<number>): void {
  const [rangeText, stepText, ...extra] = part.split("/");
  if (rangeText === undefined || rangeText === "" || extra.length > 0) {
    throw new CronError(`Invalid ${field.label}: ${part}`);
  }

  let step = 1;
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
      throw new CronError(`Invalid step in the ${field.label}: ${part}`);
    }
    step = Number(stepText);
  }

  let low: number;
  let high: number;
  if (rangeText === "*") {
    low = field.min;
    high = field.max;
  } else if (rangeText.includes("-")) {
    const [from, to, ...rest] = rangeText.split("-");
    if (from === undefined || to === undefined || rest.length > 0) {
      throw new CronError(`Invalid ${field.label}: ${part}`);
    }
    low = parseValue(from, field);
    high = parseValue(to, field);
    if (low > high) {
      throw new CronError(`The ${field.label} range ${part} runs backwards`);
    }
  } else {
    low = parseValue(rangeText, field);
    if (stepText !== undefined) {
      // `5/15` has no agreed meaning across schedulers, so it is rejected rather than guessed at.
      throw new CronError(`A step needs a range or *: ${part}`);
    }
    high = low;
  }

  for (let value = low; value <= high; value += step) {
    out.add(value);
  }
}

function parseField(text: string, field: FieldRange): Set<number> {
  if (text === "") {
    throw new CronError(`The ${field.label} is missing`);
  }
  const values = new Set<number>();
  for (const part of text.split(",")) {
    parsePart(part, field, values);
  }
  return values;
}

/** Parses an expression, throwing a {@link CronError} that says what is wrong with it. */
export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError("A cron expression has five fields: minute hour day month weekday");
  }

  const [minuteText, hourText, domText, monthText, dowText] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const [minuteField, hourField, domField, monthField, dowField] = FIELDS as [
    FieldRange,
    FieldRange,
    FieldRange,
    FieldRange,
    FieldRange,
  ];

  const minutes = [...parseField(minuteText, minuteField)].sort((a, b) => a - b);
  const hours = [...parseField(hourText, hourField)].sort((a, b) => a - b);
  const daysOfMonth = parseField(domText, domField);
  const months = parseField(monthText, monthField);
  const daysOfWeek = new Set([...parseField(dowText, dowField)].map((day) => (day === 7 ? 0 : day)));

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: domText === "*",
    anyDayOfWeek: dowText === "*",
  };
}

function matchesDay(schedule: CronSchedule, calendarDay: Date): boolean {
  if (!schedule.months.has(calendarDay.getUTCMonth() + 1)) {
    return false;
  }
  const dayOfMonth = schedule.daysOfMonth.has(calendarDay.getUTCDate());
  const dayOfWeek = schedule.daysOfWeek.has(calendarDay.getUTCDay());
  // When both day fields are restricted, classic cron runs on either.
  if (!schedule.anyDayOfMonth && !schedule.anyDayOfWeek) {
    return dayOfMonth || dayOfWeek;
  }
  return schedule.anyDayOfMonth ? dayOfWeek : dayOfMonth;
}

/** A calendar a schedule can be read against: this process's own, or a named time zone's. */
interface Clock {
  /** The year, month and day of the month an instant falls on. */
  dateOf(instant: number): [year: number, month: number, day: number];
  /**
   * The instant of a wall-clock time. Inside a daylight-saving gap that time does not exist, and the
   * first minute after the gap stands in for it, so a daily job still runs that day. An ambiguous
   * time at the end of daylight saving resolves to its first occurrence, so it runs once.
   */
  instantOf(year: number, month: number, day: number, hour: number, minute: number): number;
}

const localClock: Clock = {
  dateOf(instant) {
    const date = new Date(instant);
    return [date.getFullYear(), date.getMonth(), date.getDate()];
  },
  instantOf(year, month, day, hour, minute) {
    const candidate = new Date(year, month, day, hour, minute);
    if (candidate.getHours() === hour && candidate.getMinutes() === minute) {
      return candidate.getTime();
    }
    // The hour after this one is the first that exists again.
    return new Date(year, month, day, hour + 1, 0).getTime();
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function zoneClock(timeZone: string): Clock {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const fields = (instant: number) => {
    const parts = format.formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    return [
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    ] as const;
  };
  /** What the wall clock reads, as if that reading were the time in UTC. */
  const wallClock = (instant: number): number => Date.UTC(...fields(instant));
  const offsetAt = (instant: number) => wallClock(instant) - Math.floor(instant / 1000) * 1000;

  const instantOf: Clock["instantOf"] = (year, month, day, hour, minute) => {
    const wanted = Date.UTC(year, month, day, hour, minute);
    // The offsets on either side of any daylight-saving change nearby give every candidate there is.
    const candidates = [offsetAt(wanted - DAY_MS), offsetAt(wanted + DAY_MS)]
      .map((offset) => wanted - offset)
      .filter((instant) => wallClock(instant) === wanted);
    // None read this time: it is inside a gap, and the hour after this one is the first that exists.
    return candidates.length > 0 ? Math.min(...candidates) : instantOf(year, month, day, hour + 1, 0);
  };

  return {
    dateOf(instant) {
      const [year, month, day] = fields(instant);
      return [year, month, day];
    },
    instantOf,
  };
}

/**
 * The first occurrence strictly after `after`, or null if the schedule can never happen (`0 0 31 2 *`).
 * Read against a named time zone when one is given, and otherwise against the time zone of this process.
 */
export function nextCronOccurrence(schedule: CronSchedule, after: number, timeZone?: string): number | null {
  const clock = timeZone === undefined ? localClock : zoneClock(timeZone);
  const [startYear, startMonth, startDate] = clock.dateOf(after);

  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset += 1) {
    // Arithmetic on the calendar alone, whose days are the same length everywhere.
    const day = new Date(Date.UTC(startYear, startMonth, startDate + offset));
    if (!matchesDay(schedule, day)) {
      continue;
    }
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const instant = clock.instantOf(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hour,
          minute,
        );
        if (instant > after) {
          return instant;
        }
      }
    }
  }
  return null;
}

/** A sentence saying why an expression is unusable, or null when it is fine. */
export function cronProblem(expression: string): string | null {
  let schedule: CronSchedule;
  try {
    schedule = parseCron(expression);
  } catch (error) {
    return (error as Error).message;
  }
  return nextCronOccurrence(schedule, Date.now()) === null ? "This schedule never happens" : null;
}
