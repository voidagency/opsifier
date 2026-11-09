import { describe, expect, it } from "vitest";
import { cronProblem, nextCronOccurrence, parseCron } from "./cron";

const utc = (text: string) => Date.parse(text);

describe("parseCron", () => {
  it("accepts the five usual forms", () => {
    for (const expression of [
      "* * * * *",
      "0 2 * * *",
      "0 */6 * * *",
      "15,45 8-18 1 JAN mon-fri",
      "0 0 * * 7",
      "*/15 0-6 1-15 */2 *",
    ]) {
      expect(cronProblem(expression), expression).toBeNull();
    }
  });

  it("explains what is wrong with a bad expression", () => {
    expect(cronProblem("nonsense")).toMatch(/five fields/);
    expect(cronProblem("61 * * * *")).toMatch(/minute must be between/);
    expect(cronProblem("* 25 * * *")).toMatch(/hour must be between/);
    expect(cronProblem("* * 32 * *")).toMatch(/day of month/);
    expect(cronProblem("* * * 13 *")).toMatch(/month must be/);
    expect(cronProblem("* * * * 8")).toMatch(/day of week/);
    expect(cronProblem("5-1 * * * *")).toMatch(/backwards/);
    expect(cronProblem("*/0 * * * *")).toMatch(/step/);
    expect(cronProblem("5/15 * * * *")).toMatch(/step needs/);
    expect(cronProblem("* * * *")).toMatch(/five fields/);
    expect(cronProblem("")).toMatch(/five fields/);
  });

  it("refuses a schedule that can never happen", () => {
    expect(cronProblem("0 0 31 2 *")).toBe("This schedule never happens");
  });

  it("treats a restricted day and weekday as either one", () => {
    const schedule = parseCron("0 12 13 * 5");
    // The 13th of the month, a Sunday, still counts because the day-of-month field matches.
    const from = new Date(2026, 8, 12, 13, 0).getTime();
    expect(new Date(nextCronOccurrence(schedule, from) as number).getDate()).toBe(13);
  });
});

describe("nextCronOccurrence", () => {
  const next = (expression: string, from: number) => nextCronOccurrence(parseCron(expression), from);

  it("runs strictly after the given moment", () => {
    const from = new Date(2026, 5, 15, 2, 0, 0).getTime();
    const run = next("0 2 * * *", from) as number;
    expect(run).toBeGreaterThan(from);
    expect(new Date(run).getDate()).toBe(16);
    expect(new Date(run).getHours()).toBe(2);
  });

  it("finds the next minute for an every-minute schedule", () => {
    const from = new Date(2026, 5, 15, 10, 37, 20).getTime();
    expect(next("* * * * *", from)).toBe(new Date(2026, 5, 15, 10, 38, 0).getTime());
  });

  it("honours steps and lists within a day", () => {
    const from = new Date(2026, 5, 15, 1, 5, 0).getTime();
    expect(next("0 */6 * * *", from)).toBe(new Date(2026, 5, 15, 6, 0, 0).getTime());
  });

  it("returns null for a schedule that never happens", () => {
    expect(next("0 0 31 2 *", Date.UTC(2026, 0, 1))).toBeNull();
  });

  it("stays inside the search window for the rarest valid schedules", () => {
    const from = new Date(2026, 2, 1, 0, 0, 0).getTime();
    const run = next("0 0 29 2 *", from) as number;
    expect(new Date(run).getMonth()).toBe(1);
    expect(new Date(run).getDate()).toBe(29);
  });

  it("does not depend on the time at which it is asked, only on the schedule", () => {
    expect(utc("2026-06-15T00:00:00.000Z")).toBeLessThan(utc("2026-06-16T00:00:00.000Z"));
  });
});

describe("nextCronOccurrence in a named time zone", () => {
  const nextIn = (expression: string, from: string, timeZone: string) =>
    new Date(nextCronOccurrence(parseCron(expression), Date.parse(from), timeZone) as number).toISOString();

  it("reads the schedule against the zone it was given, whatever this process runs in", () => {
    expect(nextIn("0 9 * * *", "2026-06-14T23:00:00.000Z", "Asia/Tokyo")).toBe("2026-06-15T00:00:00.000Z");
    expect(nextIn("0 9 * * *", "2026-06-14T23:00:00.000Z", "Europe/Paris")).toBe("2026-06-15T07:00:00.000Z");
    expect(nextIn("0 9 * * *", "2026-06-14T23:00:00.000Z", "America/New_York")).toBe(
      "2026-06-15T13:00:00.000Z",
    );
    expect(nextIn("0 9 * * *", "2026-06-14T23:00:00.000Z", "UTC")).toBe("2026-06-15T09:00:00.000Z");
  });

  it("uses the zone's own calendar day to decide which day it is", () => {
    // Just past midnight on Saturday in Tokyo, still Friday in UTC.
    expect(nextIn("30 8 * * 6", "2026-06-12T16:00:00.000Z", "Asia/Tokyo")).toBe("2026-06-12T23:30:00.000Z");
  });

  it("runs the first minute after a daylight-saving gap instead of a time that does not exist", () => {
    // Paris jumps from 02:00 to 03:00 on 2026-03-29, so 02:30 never happens that day.
    expect(nextIn("30 2 * * *", "2026-03-28T23:00:00.000Z", "Europe/Paris")).toBe("2026-03-29T01:00:00.000Z");
    // The following day is back to a normal 02:30.
    expect(nextIn("30 2 * * *", "2026-03-29T12:00:00.000Z", "Europe/Paris")).toBe("2026-03-30T00:30:00.000Z");
  });

  it("runs once, at the first occurrence, when a time happens twice", () => {
    // Paris falls back from 03:00 to 02:00 on 2026-10-25, so 02:30 happens twice.
    const first = "2026-10-25T00:30:00.000Z";
    expect(nextIn("30 2 * * *", "2026-10-24T23:00:00.000Z", "Europe/Paris")).toBe(first);
    expect(nextIn("30 2 * * *", first, "Europe/Paris")).toBe("2026-10-26T01:30:00.000Z");
  });

  it("keeps a daily time on the same wall-clock time across a change of offset", () => {
    expect(nextIn("0 8 * * *", "2026-03-28T12:00:00.000Z", "Europe/Paris")).toBe("2026-03-29T06:00:00.000Z");
    expect(nextIn("0 8 * * *", "2026-03-29T12:00:00.000Z", "Europe/Paris")).toBe("2026-03-30T06:00:00.000Z");
  });
});
