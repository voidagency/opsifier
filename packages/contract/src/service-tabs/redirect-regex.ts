/**
 * Checks a pattern against the syntax Go's regexp package accepts, because Traefik compiles redirect
 * rules with it and a pattern it cannot compile turns off every router the rule is attached to.
 * JavaScript's own RegExp is no help here: it accepts lookaround and backreferences, which Go refuses,
 * and refuses `(?i)` and `\z`, which Go accepts. Anything unusual is rejected rather than guessed at.
 */

const MAX_COUNT = 1000;
const MAX_DEPTH = 100;
const POSIX_CLASSES = new Set(
  "alnum alpha ascii blank cntrl digit graph lower print punct space upper word xdigit".split(" "),
);
const UNICODE_CLASSES = new Set(
  "L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs C Cc Cf Co Cs Greek Latin Cyrillic Han Hiragana Katakana Hangul Arabic Hebrew Devanagari Thai Any".split(
    " ",
  ),
);
const PERL_CLASS_LETTERS = new Set("dDsSwW".split(""));
const ASSERTION_LETTERS = new Set("AbBz".split(""));
const CONTROL_ESCAPES = new Set("afnrtv".split(""));
const FLAG_LETTERS = new Set("imsU".split(""));

const isOctal = (c: string | undefined) => c !== undefined && c >= "0" && c <= "7";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isWordCharacter = (c: string) => /^[0-9A-Za-z]$/.test(c);
const isAscii = (c: string) => c.charCodeAt(0) < 0x80;

class Parser {
  private position = 0;
  private readonly names = new Set<string>();

  constructor(private readonly pattern: string) {}

  /** The first problem found, or null when Go would compile this pattern. */
  check(): string | null {
    try {
      this.alternation(0);
      if (this.position !== this.pattern.length) {
        throw new SyntaxError("Unmatched )");
      }
      return null;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return error.message;
      }
      throw error;
    }
  }

  private peek(offset = 0): string | undefined {
    return this.pattern[this.position + offset];
  }

  private fail(message: string): never {
    throw new SyntaxError(message);
  }

  /** Returns the largest repeat count multiplied inside, the way Go limits nesting. */
  private alternation(depth: number): number {
    if (depth > MAX_DEPTH) {
      this.fail("Too deeply nested");
    }
    let largest = this.concatenation(depth);
    while (this.peek() === "|") {
      this.position += 1;
      largest = Math.max(largest, this.concatenation(depth));
    }
    return largest;
  }

  private concatenation(depth: number): number {
    let largest = 1;
    let atomProduct = 1;
    let canRepeat = false;
    let afterRepeat = false;
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") {
        return largest;
      }
      if (c === "*" || c === "+" || c === "?") {
        if (!canRepeat || afterRepeat) {
          this.fail("Nothing to repeat, or a repeat stacked on a repeat");
        }
        this.position += 1;
        if (this.peek() === "?") {
          this.position += 1;
        }
        afterRepeat = true;
        continue;
      }
      if (c === "{") {
        const counted = this.repeatCount();
        if (counted === null) {
          this.position += 1;
          canRepeat = true;
          afterRepeat = false;
          continue;
        }
        if (!canRepeat || afterRepeat) {
          this.fail("Nothing to repeat, or a repeat stacked on a repeat");
        }
        const product = counted.product * atomProduct;
        if (product > MAX_COUNT) {
          this.fail("Repeat counts multiply past 1000");
        }
        atomProduct = product;
        largest = Math.max(largest, product);
        afterRepeat = true;
        continue;
      }
      const atom = this.atom(depth);
      atomProduct = atom.product;
      largest = Math.max(largest, atom.product);
      canRepeat = atom.repeatable;
      afterRepeat = false;
    }
  }

  /** `{n}`, `{n,}` or `{n,m}` at the cursor, or null if the brace is just a character. */
  private repeatCount(): { product: number } | null {
    const match = /^\{(\d+)(,(\d*))?\}(\??)/.exec(this.pattern.slice(this.position));
    const low = match?.[1];
    if (match === null || low === undefined) {
      return null;
    }
    const high = match[3];
    const noLeadingZero = (digits: string) => digits.length === 1 || digits[0] !== "0";
    if (!noLeadingZero(low) || (high !== undefined && high !== "" && !noLeadingZero(high))) {
      return null;
    }
    const min = Number(low);
    const max = match[2] === undefined ? min : high === "" || high === undefined ? -1 : Number(high);
    if (min > MAX_COUNT || max > MAX_COUNT || (max !== -1 && min > max)) {
      this.fail("Repeat counts must be 1000 or less, with the smallest first");
    }
    this.position += match[0].length;
    return { product: Math.max(1, max === -1 ? min : max) };
  }

  private atom(depth: number): { repeatable: boolean; product: number } {
    const c = this.peek();
    if (c === "(") {
      return this.group(depth);
    }
    if (c === "[") {
      this.characterClass();
      return { repeatable: true, product: 1 };
    }
    if (c === "\\") {
      return { repeatable: this.escape(), product: 1 };
    }
    this.position += (this.pattern.codePointAt(this.position) ?? 0) > 0xffff ? 2 : 1;
    return { repeatable: true, product: 1 };
  }

  private group(depth: number): { repeatable: boolean; product: number } {
    this.position += 1;
    if (this.peek() === "?") {
      const named = this.namedCapture();
      if (!named) {
        const closed = this.flags();
        if (closed) {
          // `(?i)` applies to what follows, and there is nothing here to repeat.
          return { repeatable: false, product: 1 };
        }
      }
    }
    const product = this.alternation(depth + 1);
    if (this.peek() !== ")") {
      this.fail("Unclosed (");
    }
    this.position += 1;
    return { repeatable: true, product };
  }

  /** `(?P<name>` or `(?<name>`, leaving the cursor on the group's body. */
  private namedCapture(): boolean {
    const rest = this.pattern.slice(this.position + 1);
    const match = /^(?:P?<([^>]*)>)/.exec(rest);
    if (match === null) {
      return false;
    }
    const name = match[1] ?? "";
    if (!/^\w+$/.test(name)) {
      this.fail("Group names use letters, digits and underscores");
    }
    if (this.names.has(name)) {
      this.fail("A group name can only be used once");
    }
    this.names.add(name);
    this.position += 1 + match[0].length;
    return true;
  }

  /** `(?i)` or `(?i:`, returning true when the first form closed the group. */
  private flags(): boolean {
    this.position += 1;
    let sawFlag = false;
    let negative = false;
    for (;;) {
      const c = this.peek();
      if (c !== undefined && FLAG_LETTERS.has(c)) {
        sawFlag = true;
        this.position += 1;
      } else if (c === "-" && !negative) {
        negative = true;
        sawFlag = false;
        this.position += 1;
      } else if ((c === ":" || c === ")") && (!negative || sawFlag)) {
        this.position += 1;
        return c === ")";
      } else {
        this.fail("Unsupported group syntax");
      }
    }
  }

  /** Consumes one escape outside a class. Returns whether a repeat may follow it. */
  private escape(): boolean {
    const c = this.peek(1);
    if (c === undefined) {
      this.fail("Trailing backslash");
    }
    if (c === "Q") {
      const end = this.pattern.indexOf("\\E", this.position + 2);
      const literal =
        end === -1 ? this.pattern.slice(this.position + 2) : this.pattern.slice(this.position + 2, end);
      this.position = end === -1 ? this.pattern.length : end + 2;
      return literal !== "";
    }
    if (ASSERTION_LETTERS.has(c)) {
      this.position += 2;
      return true;
    }
    if (PERL_CLASS_LETTERS.has(c)) {
      this.position += 2;
      return true;
    }
    if (c === "p" || c === "P") {
      this.unicodeClass();
      return true;
    }
    this.singleEscape();
    return true;
  }

  private unicodeClass(): void {
    const match = /^\\[pP](?:\{\^?([A-Za-z]+)\}|([A-Z]))/.exec(this.pattern.slice(this.position));
    const name = match?.[1] ?? match?.[2];
    if (match === null || name === undefined || !UNICODE_CLASSES.has(name)) {
      this.fail("Unknown Unicode class");
    }
    this.position += match[0].length;
  }

  /** A character escape: punctuation, an octal, a hex, or one of `\a\f\n\r\t\v`. */
  private singleEscape(): void {
    const c = this.peek(1);
    if (c === undefined) {
      this.fail("Trailing backslash");
    }
    if (c === "x") {
      this.hexEscape();
      return;
    }
    if (c === "0" || (isOctal(c) && isOctal(this.peek(2)))) {
      this.position += 2;
      for (let extra = 0; extra < 2 && isOctal(this.peek()); extra += 1) {
        this.position += 1;
      }
      return;
    }
    if (CONTROL_ESCAPES.has(c) || (!isWordCharacter(c) && isAscii(c))) {
      this.position += 2;
      return;
    }
    this.fail(`Unsupported escape \\${c}`);
  }

  private hexEscape(): void {
    if (this.peek(2) === "{") {
      const match = /^\\x\{([0-9A-Fa-f]{1,6})\}/.exec(this.pattern.slice(this.position));
      if (match === null || Number.parseInt(match[1] ?? "", 16) > 0x10ffff) {
        this.fail("Invalid hexadecimal escape");
      }
      this.position += match[0].length;
      return;
    }
    if (!isHex(this.peek(2)) || !isHex(this.peek(3))) {
      this.fail("Invalid hexadecimal escape");
    }
    this.position += 4;
  }

  private characterClass(): void {
    this.position += 1;
    if (this.peek() === "^") {
      this.position += 1;
    }
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) {
        this.fail("Unclosed [");
      }
      if (c === "]" && !first) {
        this.position += 1;
        return;
      }
      first = false;
      if (c === "[" && this.peek(1) === ":") {
        this.posixClass();
        continue;
      }
      if (c === "\\" && (this.peek(1) === "p" || this.peek(1) === "P")) {
        this.unicodeClass();
        continue;
      }
      if (c === "\\" && this.peek(1) !== undefined && PERL_CLASS_LETTERS.has(this.peek(1) as string)) {
        this.position += 2;
        continue;
      }
      const low = this.classCharacter();
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        this.position += 1;
        const high = this.classCharacter();
        if (high < low) {
          this.fail("Reversed range in a character class");
        }
      }
    }
  }

  private posixClass(): void {
    const end = this.pattern.indexOf(":]", this.position + 2);
    if (end === -1) {
      // Go reads this as an ordinary `[`, then the colon, inside the class.
      this.position += 1;
      return;
    }
    const name = this.pattern.slice(this.position + 2, end).replace(/^\^/, "");
    if (!POSIX_CLASSES.has(name)) {
      this.fail("Unknown POSIX class");
    }
    this.position = end + 2;
  }

  /** One character inside a class, returned as a code point for range checks. */
  private classCharacter(): number {
    const c = this.peek();
    if (c === undefined) {
      this.fail("Unclosed [");
    }
    if (c === "\\") {
      const start = this.position;
      this.singleEscape();
      return codePointOfEscape(this.pattern.slice(start, this.position));
    }
    const character = Array.from(this.pattern.slice(this.position))[0] ?? c;
    this.position += character.length;
    return character.codePointAt(0) ?? 0;
  }
}

function codePointOfEscape(sequence: string): number {
  const body = sequence.slice(1);
  const controls: Record<string, number> = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11 };
  if (body.length === 1) {
    return controls[body] ?? body.codePointAt(0) ?? 0;
  }
  if (body.startsWith("x{")) {
    return Number.parseInt(body.slice(2, -1), 16);
  }
  if (body.startsWith("x")) {
    return Number.parseInt(body.slice(1), 16);
  }
  return Number.parseInt(body, 8);
}

/** Null when Traefik's Go regexp engine can compile the pattern, otherwise what stops it. */
export function goRegexError(pattern: string): string | null {
  return new Parser(pattern).check();
}
