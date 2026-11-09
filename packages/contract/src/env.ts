import { z } from "zod";

const MAX_ENV_LENGTH = 128 * 1024;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface EnvPair {
  key: string;
  value: string;
}

/** Only a value wrapped in double quotes loses them. Everything else is kept as typed. */
function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : value;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Reads dotenv text. Blank lines and `#` comments are skipped, `KEY=` is an empty value, and spaces
 * inside a value stay. A line with no valid `KEY=` is skipped: saving rejects those, see {@link envText}.
 */
export function parseEnvText(text: string): EnvPair[] {
  const pairs: EnvPair[] = [];
  for (const raw of splitLines(text)) {
    const line = raw.trimStart();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = separator === -1 ? "" : line.slice(0, separator).trimEnd();
    if (ENV_KEY.test(key)) {
      pairs.push({ key, value: unquote(line.slice(separator + 1)) });
    }
  }
  return pairs;
}

/** The 1-based number of the first line that is neither blank, a comment nor `KEY=value`. Null if none. */
export function firstInvalidEnvLine(text: string): number | null {
  for (const [index, raw] of splitLines(text).entries()) {
    const line = raw.trimStart();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1 || !ENV_KEY.test(line.slice(0, separator).trimEnd())) {
      return index + 1;
    }
  }
  return null;
}

/** Dotenv text as saved from the editor. */
export const envText = z
  .string()
  .max(MAX_ENV_LENGTH, "This is too long")
  .superRefine((text, context) => {
    const line = firstInvalidEnvLine(text);
    if (line !== null) {
      context.addIssue({ code: "custom", message: `Line ${line} must look like NAME=value` });
    }
  });

/** The text of a set of variables: what is saved, and what a deliberate reveal returns. */
export const envDocument = z.object({ env: envText });
export type EnvDocument = z.infer<typeof envDocument>;

/** A set of variables as a page sees it: what they are called, and nothing of what they hold. */
export const envSummary = z.object({ names: z.array(z.string()) });
export type EnvSummary = z.infer<typeof envSummary>;
