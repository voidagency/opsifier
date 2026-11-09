/** What replaces a secret in anything a person can read. */
export const REDACTED = "[redacted]";

const MIN_LITERAL_CHARS = 8;
/** A value known to be a secret is worth hiding even when it is too short to be hidden on suspicion. */
const MIN_SECRET_CHARS = 6;
/** Any run this long from inside a known secret counts as the secret, wherever it turns up. */
const PIECE_CHARS = 8;
/** How much of one secret is cut into pieces, so that an enormous value can't fill the memory. */
const MAX_PIECED_CHARS = 4096;
/** How long a line that could be the first part of a split secret waits to see what follows it. */
const HOLD_MS = 150;
/** How many of BuildKit's concurrent steps are followed at once. */
const MAX_STEPS = 64;

/** Secrets that look the same wherever they come from, caught even when nobody registered them. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(https?):\/\/[^\s/@]+@/gi, `$1://${REDACTED}@`],
  [/\bauthorization:\s*(?:basic|bearer|token)\s+\S+/gi, `Authorization: ${REDACTED}`],
];

/** Names that announce a credential. A name can only ever add to what is hidden. */
const CREDENTIAL_NAME =
  /(?:^|[_.-])(?:pass|passwd|password|passphrase|pwd|secret|token|key|cred|credential|auth|private|salt|cookie|signature|dsn|cert)s?(?:$|[_.-])|(?:key|token|secret|password)$/i;
/**
 * Values no one could mistake for a secret and that ordinary output is full of. Masking them would blank
 * out the words people read logs for and hide nothing.
 */
const ORDINARY_VALUE =
  /^(?:production|development|staging|preview|testing|localhost|disabled|postgres|postgresql|\d+(?:\.\d+)*|\/[\w./-]*)$/i;
/** Long enough, with letters and digits and nothing that makes it an address: a key, whatever it is called. */
const RANDOM_LOOKING = /^(?=.*[A-Za-z])(?=.*\d)[^\s:/]{16,}$/;
/** The password in an address such as postgres://user:secret@host/db, which is printed on its own too. */
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:([^/@\s]+)@/i;
/** The armour around a PEM block is the same in every key, so no piece of it says anything. */
const PEM_ARMOUR = /^-----(?:BEGIN|END) /;

/** Removes known secrets and anything shaped like one, from one line at a time. See {@link LineRedactor}. */
export class Redactor {
  private readonly literals = new Set<string>();
  private readonly pieces = new Set<string>();
  /** The longest first, so one secret containing another is removed whole. */
  private ordered: string[] | null = [];

  /** A multi-line secret is registered line by line, because that is how output arrives. */
  add(secret: string): this {
    return this.register(secret, MIN_LITERAL_CHARS);
  }

  /** A value known to be a secret: short ones count, and so does any long enough piece of one. */
  addSecret(secret: string): this {
    this.register(secret, MIN_SECRET_CHARS);
    this.register(encodeURIComponent(secret), MIN_SECRET_CHARS);
    for (const line of secret.split(/\r?\n/)) {
      if (!PEM_ARMOUR.test(line)) {
        const text = line.trim().slice(0, MAX_PIECED_CHARS);
        for (let at = 0; at + PIECE_CHARS <= text.length; at += 1) {
          const piece = text.slice(at, at + PIECE_CHARS);
          // Words of a passphrase are also words of everything else.
          if (!/\s/.test(piece)) {
            this.pieces.add(piece);
          }
        }
      }
    }
    return this;
  }

  /** A variable's value, which could be anything. Its name and its shape say how far to go. */
  addVariable(name: string, value: string): this {
    if (CREDENTIAL_NAME.test(name) || RANDOM_LOOKING.test(value.trim())) {
      return this.addSecret(value);
    }
    if (ORDINARY_VALUE.test(value.trim())) {
      return this;
    }
    this.add(value);
    const password = URL_PASSWORD.exec(value.trim())?.[1];
    return password === undefined ? this : this.addSecret(password);
  }

  /** A token, and the two other spellings it takes on its way into an HTTP request. */
  addToken(token: string): this {
    this.addSecret(token);
    this.add(Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"));
    return this;
  }

  private register(secret: string, minChars: number): this {
    for (const line of secret.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= minChars) {
        this.literals.add(trimmed);
        this.ordered = null;
      }
    }
    return this;
  }

  apply(text: string): string {
    let result = text;
    this.ordered ??= [...this.literals].sort((a, b) => b.length - a.length);
    for (const literal of this.ordered) {
      result = result.split(literal).join(REDACTED);
    }
    result = this.removePieces(result);
    for (const [pattern, replacement] of PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  /** Every stretch of the text that is a run of pieces of secrets, each as one mark. */
  private removePieces(text: string): string {
    if (this.pieces.size === 0) {
      return text;
    }
    let result = "";
    let copied = 0;
    for (let at = 0; at + PIECE_CHARS <= text.length; ) {
      if (!this.pieces.has(text.slice(at, at + PIECE_CHARS))) {
        at += 1;
        continue;
      }
      let end = at + PIECE_CHARS;
      while (end < text.length && this.pieces.has(text.slice(end + 1 - PIECE_CHARS, end + 1))) {
        end += 1;
      }
      result += `${text.slice(copied, at)}${REDACTED}`;
      copied = end;
      at = end;
    }
    return copied === 0 ? text : result + text.slice(copied);
  }

  /** The first whole secret in the text, for putting one back together across lines. */
  find(text: string): { start: number; end: number } | null {
    let first: { start: number; end: number } | null = null;
    for (const literal of this.literals) {
      const start = text.indexOf(literal);
      if (start !== -1 && (first === null || start < first.start)) {
        first = { start, end: start + literal.length };
      }
    }
    return first;
  }

  /** How many characters at the end of the text could be the beginning of a secret. */
  undecided(text: string): number {
    let longest = 0;
    for (const literal of this.literals) {
      const head = literal.charAt(0);
      for (
        let at = text.indexOf(head, Math.max(0, text.length - literal.length + 1));
        at !== -1 && text.length - at > longest;
        at = text.indexOf(head, at + 1)
      ) {
        if (literal.startsWith(text.slice(at))) {
          longest = text.length - at;
          break;
        }
      }
    }
    return longest;
  }
}

interface HeldLine<M> {
  prefix: string;
  body: string;
  meta: M;
}

/** BuildKit runs steps side by side, and each line of output says which one is speaking. */
const BUILDKIT_STEP = /^(#\d+) \d+\.\d+ /;

function splitStep(line: string): { key: string; prefix: string; body: string } {
  const step = BUILDKIT_STEP.exec(line);
  return step === null
    ? { key: "", prefix: "", body: line }
    : { key: step[1] as string, prefix: step[0], body: line.slice(step[0].length) };
}

/**
 * Line-by-line output with secrets removed, including one that was split over several lines. A line that
 * ends with what could be the start of a secret waits briefly for the next one: if together they spell
 * it, every part goes, and otherwise they are passed on untouched.
 */
export class LineRedactor<M = undefined> {
  private readonly held = new Map<string, HeldLine<M>[]>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private redactor: Redactor,
    private readonly emit: (line: string, meta: M) => void,
    /** Null never lets a line wait on the clock: for text that is all here, and ends with `flush`. */
    private readonly holdMs: number | null = HOLD_MS,
  ) {}

  /** For a stream that outlives a change to what counts as a secret. */
  use(redactor: Redactor): void {
    this.redactor = redactor;
  }

  write(line: string, meta: M): void {
    const { key, prefix, body } = splitStep(line);
    const lines = this.held.get(key) ?? [];
    lines.push({ prefix, body: this.redactor.apply(body), meta });
    this.removeSplitSecrets(lines);
    this.settle(key, lines);
    this.schedule();
  }

  /** Passes on whatever is still waiting. Call it when the stream ends. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const lines of this.held.values()) {
      for (const line of lines) {
        this.send(line);
      }
    }
    this.held.clear();
  }

  private send(line: HeldLine<M>): void {
    this.emit(`${line.prefix}${line.body}`, line.meta);
  }

  /** What is inside one line went already, so anything found here spans several: each loses its part. */
  private removeSplitSecrets(lines: HeldLine<M>[]): void {
    for (let attempt = 0; lines.length > 1 && attempt < 64; attempt += 1) {
      const found = this.redactor.find(lines.map((line) => line.body).join(""));
      if (found === null) {
        return;
      }
      let lineStart = 0;
      for (const line of lines) {
        const from = Math.max(found.start, lineStart) - lineStart;
        const to = Math.min(found.end, lineStart + line.body.length) - lineStart;
        lineStart += line.body.length;
        if (from < to) {
          line.body = `${line.body.slice(0, from)}${REDACTED}${line.body.slice(to)}`;
        }
      }
    }
  }

  /** Lines leave as soon as no secret can still run through them. */
  private settle(key: string, lines: HeldLine<M>[]): void {
    const joined = lines.map((line) => line.body).join("");
    let room = joined.length - this.redactor.undecided(joined);
    while (lines[0] !== undefined && lines[0].body.length <= room) {
      room -= lines[0].body.length;
      this.send(lines[0]);
      lines.shift();
    }
    if (lines.length === 0) {
      this.held.delete(key);
      return;
    }
    this.held.set(key, lines);
    if (this.held.size > MAX_STEPS) {
      this.flush();
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.holdMs !== null && this.held.size > 0) {
      this.timer = setTimeout(() => this.flush(), this.holdMs);
      this.timer.unref();
    }
  }
}

/** The same for text that is all here already, such as a log read back from the disk. */
export function redactLines(redactor: Redactor, text: string): string {
  const output: string[] = [];
  const lines = new LineRedactor(redactor, (line) => output.push(line), null);
  for (const line of text.split("\n")) {
    lines.write(line, undefined);
  }
  lines.flush();
  return output.join("\n");
}
