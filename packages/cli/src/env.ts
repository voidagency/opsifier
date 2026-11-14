/**
 * Reading and editing a set of variables as dotenv text, by the panel's own rules: `NAME=value` per line,
 * blank lines and `#` comments kept, a value wrapped in double quotes losing them and nothing else
 * escaped. The panel saves the whole text at once, so a change is made on the text and sent back whole.
 */

/** A variable's name, as the panel accepts it. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The name a line defines, or undefined for a blank line, a comment or anything the panel skips. */
function nameOf(raw: string): string | undefined {
  const line = raw.trimStart();
  if (line === "" || line.startsWith("#")) {
    return undefined;
  }
  const separator = line.indexOf("=");
  const name = separator === -1 ? "" : line.slice(0, separator).trimEnd();
  return ENV_NAME.test(name) ? name : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : value;
}

const linesOf = (text: string): string[] => (text === "" ? [] : text.split(/\r?\n/));

/** Every variable and its value. When a name is defined twice, the later line wins, as on the panel. */
export function readEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of linesOf(text)) {
    const name = nameOf(raw);
    if (name !== undefined) {
      const line = raw.trimStart();
      values.set(name, unquote(line.slice(line.indexOf("=") + 1)));
    }
  }
  return values;
}

/** The line that saves exactly this value. Only a value that would lose its own quotes gets new ones. */
export function envLine(name: string, value: string): string {
  const trimmed = value.trim();
  const wouldLoseQuotes = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  return `${name}=${wouldLoseQuotes ? `"${value}"` : value}`;
}

function textOf(lines: string[]): string {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/**
 * Sets these values: a name already there keeps its place, with any later duplicate of it dropped, and a
 * new one is added at the end. Comments, blank lines and every other variable stay as they were.
 */
export function setEnv(text: string, values: ReadonlyMap<string, string>): string {
  const pending = new Map(values);
  const lines: string[] = [];
  for (const raw of linesOf(text)) {
    const name = nameOf(raw);
    if (name === undefined || !values.has(name)) {
      lines.push(raw);
      continue;
    }
    const value = pending.get(name);
    if (value !== undefined) {
      lines.push(envLine(name, value));
      pending.delete(name);
    }
  }
  if (lines.length > 0 && pending.size > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
  }
  for (const [name, value] of pending) {
    lines.push(envLine(name, value));
  }
  return textOf(lines);
}

/** Removes every line that defines one of these names. `removed` says which ones were there. */
export function unsetEnv(text: string, names: ReadonlySet<string>): { text: string; removed: Set<string> } {
  const removed = new Set<string>();
  const lines = linesOf(text).filter((raw) => {
    const name = nameOf(raw);
    if (name !== undefined && names.has(name)) {
      removed.add(name);
      return false;
    }
    return true;
  });
  return { text: textOf(lines), removed };
}
