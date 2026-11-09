/** `1.2.3`, with an optional `v` and any pre-release or build suffix. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  numbers: [number, number, number];
  pre: string[] | null;
}

function parse(version: string): Parsed | null {
  const match = SEMVER.exec(version.trim());
  if (match === null) {
    return null;
  }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

export const isVersion = (value: string): boolean => parse(value) !== null;

function comparePre(a: string[] | null, b: string[] | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x, y] = [a[index], b[index]];
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? -1 : 1;
    }
    if (x !== y) {
      const [m, n] = [Number(x), Number(y)];
      if (Number.isInteger(m) && Number.isInteger(n)) {
        return m - n;
      }
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Negative when `a` is older than `b`. Anything that isn't a version sorts before everything that is. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  if (x === null || y === null) {
    return x === y ? 0 : x === null ? -1 : 1;
  }
  for (const index of [0, 1, 2] as const) {
    if (x.numbers[index] !== y.numbers[index]) {
      return x.numbers[index] - y.numbers[index];
    }
  }
  return comparePre(x.pre, y.pre);
}
