import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from "./format";

describe("formatBytes", () => {
  it("shows bytes in the largest sensible unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MB");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, null, undefined])(
    "never prints %j as a size",
    (value) => {
      expect(formatBytes(value)).toBe("0 B");
    },
  );
});

describe("formatPercent", () => {
  it("keeps one decimal and survives bad input", () => {
    expect(formatPercent(1.234)).toBe("1.2%");
    expect(formatPercent(Number.NaN)).toBe("0.0%");
  });
});

describe("formatDuration", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const after = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();

  it("reads as seconds, minutes, then hours", () => {
    expect(formatDuration(start, after(12))).toBe("12s");
    expect(formatDuration(start, after(64))).toBe("1m 04s");
    expect(formatDuration(start, after(3660))).toBe("1h 01m");
  });

  it("counts up while running and shows dashes before starting", () => {
    expect(formatDuration(start, null, Date.parse(after(5)))).toBe("5s");
    expect(formatDuration(null, null)).toBe("--");
  });
});

describe("formatRelativeTime", () => {
  it("follows the language", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

    expect(formatRelativeTime(minutesAgo(3), "en", now)).toBe("3 minutes ago");
    expect(formatRelativeTime(minutesAgo(180), "en", now)).toBe("3 hours ago");
    expect(formatRelativeTime(minutesAgo(3), "fr", now)).toBe("il y a 3 minutes");
  });
});
