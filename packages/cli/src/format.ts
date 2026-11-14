import type { ServiceStatus } from "@opsifier/contract";

export interface Styles {
  /** Paints a state word. Colour only ever repeats what the word already says. */
  state(state: ServiceStatus, text: string): string;
  dim(text: string): string;
  /** An address a terminal lets people open with a click. Plain text anywhere else. */
  link(url: string): string;
}

const CODES: Record<ServiceStatus, number> = {
  failing: 31,
  unknown: 33,
  starting: 33,
  running: 32,
  stopped: 90,
  undeployed: 90,
};

export function createStyles(colors: boolean): Styles {
  const paint = (code: number, text: string) => (colors ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    state: (state, text) => paint(CODES[state], text),
    dim: (text) => paint(90, text),
    // OSC 8: terminals that know it make the text clickable, the others show the text as it is.
    link: (url) => (colors ? `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\` : url),
  };
}

/** Column widths come from the plain text; `paint` only decorates the cell once it is padded. */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  paint: (padded: string, row: readonly string[], column: number) => string = (padded) => padded,
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (row: readonly string[], decorate: boolean) =>
    row
      .map((cell, column) => {
        const padded = cell.padEnd(widths[column] ?? 0);
        return decorate ? paint(padded, row, column) : padded;
      })
      .join("  ")
      .trimEnd();
  return [renderRow(headers, false), ...rows.map((row) => renderRow(row, true))].join("\n");
}

/** Label and value, one pair per line, the values lined up. */
export function renderFields(fields: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

/** Local time, down to the minute, in one fixed format that reads the same in every language. */
export function formatTime(iso: string | null): string {
  if (iso === null) {
    return "-";
  }
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Problems first, the order the panel's own screens use. */
const SEVERITY: Record<ServiceStatus, number> = {
  failing: 0,
  unknown: 1,
  starting: 2,
  running: 3,
  stopped: 4,
  undeployed: 5,
};

export const bySeverity = (a: ServiceStatus, b: ServiceStatus): number => SEVERITY[a] - SEVERITY[b];

/** The wake strip of a service, one mark per deployment, oldest first. */
export const WAKE_MARK: Record<string, string> = {
  succeeded: "+",
  failed: "x",
  running: ">",
  cancelled: "-",
};

/** 950 B, 12.3 KB, 4.1 MB, 1.2 GB. */
export function sizeText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}
