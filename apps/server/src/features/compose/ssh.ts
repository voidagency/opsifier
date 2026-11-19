/**
 * The keys a build's `ssh` forwards from the panel's side. A file writes one entry or a list of them,
 * each `id`, `id=path` or `id=path,path`, or a mapping of ids to paths. What Compose gives back once it
 * has resolved the stack may be such strings, `id: path`, or `{ id, path }`. An id alone, `default`
 * among them, forwards an agent and names no path.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every way the paths after a separator can be read: whole, as one key, and split at commas, as Buildx
 * splits them. Nothing is trimmed, since nothing that reads them trims either.
 */
const readings = (rest: string): string[] => [rest, ...rest.split(",")].filter((path) => path !== "");

/**
 * The paths one entry may name, read after its first `=` and after its first `: ` alike. An entry
 * with a variable in it could become any of them once Compose fills it in, so it counts as a path too.
 */
function entryPaths(entry: string): string[] {
  const paths = entry.includes("$") ? [entry] : [];
  for (const separator of ["=", ": "]) {
    const at = entry.indexOf(separator);
    if (at !== -1) {
      paths.push(...readings(entry.slice(at + separator.length)));
    }
  }
  return paths;
}

/** The paths of a mapping, or of a `{ id, path }`: every value counts, an id among them. */
function recordPaths(record: Record<string, unknown>): string[] | null {
  const paths: string[] = [];
  for (const value of Object.values(record)) {
    if (typeof value === "string") {
      paths.push(...readings(value));
    } else if (value !== null) {
      return null;
    }
  }
  return paths;
}

/**
 * Every path a build's `ssh` may name, in whichever of its forms it is written: more is checked, never
 * less. Null for a form none of them is, which is refused rather than guessed at.
 */
export function sshPaths(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  const paths: string[] = [];
  for (const entry of entries) {
    const found = typeof entry === "string" ? entryPaths(entry) : isRecord(entry) ? recordPaths(entry) : null;
    if (found === null) {
      return null;
    }
    paths.push(...found);
  }
  return [...new Set(paths)];
}

/** How an `ssh` none of the forms reads is named in a refusal: short enough to show. */
export function describeSsh(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}
