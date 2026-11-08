/** What replaces a secret in anything a person can read. */
export const REDACTED = "[redacted]";

const MIN_LITERAL_CHARS = 8;

/** Secrets that look the same wherever they come from, caught even when nobody registered them. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(https?):\/\/[^\s/@]+@/gi, `$1://${REDACTED}@`],
  [/\bauthorization:\s*(?:basic|bearer|token)\s+\S+/gi, `Authorization: ${REDACTED}`],
];

/** Removes known secrets and anything shaped like one. Output is fed in line by line, so nothing is split. */
export class Redactor {
  private readonly literals = new Set<string>();

  /** A multi-line secret is registered line by line, because that is how output arrives. */
  add(secret: string): this {
    for (const line of secret.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_LITERAL_CHARS) {
        this.literals.add(trimmed);
      }
    }
    return this;
  }

  /** A token, and the two other spellings it takes on its way into an HTTP request. */
  addToken(token: string): this {
    this.add(token);
    this.add(encodeURIComponent(token));
    this.add(Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"));
    return this;
  }

  apply(text: string): string {
    let result = text;
    // The longest first, so one secret containing another is removed whole.
    for (const literal of [...this.literals].sort((a, b) => b.length - a.length)) {
      result = result.split(literal).join(REDACTED);
    }
    for (const [pattern, replacement] of PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }
}
