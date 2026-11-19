import { imageReference } from "@opsifier/contract";

/**
 * Reads which images a Dockerfile can make BuildKit fetch: its `FROM` lines, `COPY --from=` and
 * `RUN --mount=…from=`, after the substitution of build arguments, and the frontend its syntax line
 * asks for. Earlier stages, by name or by number, and `scratch` are not images.
 *
 * It follows BuildKit's own parser, but a file can be read more than one way: under either escape
 * character, by a parser that knows heredocs and one that doesn't, and by one that takes an escaped
 * escape character at the end of a line for a continuation and one that doesn't. A file can choose
 * among those with its own lines, so it is read every way, and what any reading finds counts. This is a
 * second line, behind `--pull`, which is what keeps a build from the images the server already holds.
 */

export interface DockerfileImages {
  /** Every image reference a reading found, as written once substituted. */
  images: string[];
  /** What a syntax directive names, on any line, in any of the forms BuildKit looks for. */
  frontends: string[];
  /**
   * Whether the file is one JSON object, where BuildKit looks for a syntax too, with key comparisons that
   * have changed from one version to the next: no Dockerfile is written that way.
   */
  json: boolean;
  /** Words whose substitution can't be worked out: an expansion BuildKit has and this reader hasn't. */
  unresolved: string[];
}

/** What Go's `unicode.IsSpace` takes for blank, which is what BuildKit trims and splits on. */
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

interface Reading {
  escapeToken: "\\" | "`";
  /** Whether an escape character that is itself escaped still continues the line, as older parsers have it. */
  escapedContinues: boolean;
  heredocs: boolean;
}

const READINGS: readonly Reading[] = (["\\", "`"] as const).flatMap((escapeToken) =>
  [true, false].flatMap((escapedContinues) =>
    [true, false].map((heredocs) => ({ escapeToken, escapedContinues, heredocs })),
  ),
);

/** Past this many ways for one word to come out, the reader gives up on it rather than guess. */
const MAX_CANDIDATES = 256;

/**
 * The longest word the reader expands, and the longest way one may come out: an image reference has at
 * most 512 characters, so anything longer can't name one.
 */
const MAX_WORD = 1024;

/** The longest file the reader reads at all. The panel takes an inline Dockerfile of 256 KiB at most. */
export const MAX_DOCKERFILE_LENGTH = 1024 * 1024;

/**
 * How much one file may make the reader do, all readings together, in characters it writes plus a share
 * for every name it weighs. Saving a source reads the file in the request, so a file written to be slow
 * to read stops here, and is then a file it can't read.
 */
const MAX_WORK = 2_000_000;
const WORK_PER_NAME = 64;

/** What the reader reports, among the words it could not work out, once a file has used up its work. */
export const TOO_MUCH_TO_READ = "more names than the panel reads in one file";

/** What is left of {@link MAX_WORK}, shared by everything that reads one file. */
interface Budget {
  left: number;
}

/** Thrown from deep inside an expansion the reader gives up on; whoever started it decides what that means. */
class GaveUp extends Error {
  override readonly name = "GaveUp";
}
const GAVE_UP = new GaveUp("The reader gave up on a word.");

function charge(budget: Budget, cost: number): void {
  budget.left -= cost;
  if (budget.left <= 0) {
    throw GAVE_UP;
  }
}

/**
 * What each variable can hold. No value at all means the reader could not work it out: that only matters
 * once an image reference uses it.
 */
type Env = ReadonlyMap<string, readonly string[]>;

const UNKNOWN: readonly string[] = [];

const ARCHITECTURES = ["amd64", "arm64", "arm", "386", "ppc64le", "s390x", "riscv64", "mips64le", "loong64"];
const VARIANTS = ["v5", "v6", "v7", "v8"];
const PLATFORMS = [
  ...ARCHITECTURES.map((architecture) => `linux/${architecture}`),
  ...VARIANTS.map((variant) => `linux/arm/${variant}`),
  "linux/arm64/v8",
];

/** BuildKit gives every build these without a declaration. The server's own platform is one of them. */
function platformArgs(): Map<string, readonly string[]> {
  const env = new Map<string, readonly string[]>();
  for (const prefix of ["BUILD", "TARGET"]) {
    env.set(`${prefix}PLATFORM`, PLATFORMS);
    env.set(`${prefix}OS`, ["linux"]);
    env.set(`${prefix}ARCH`, ARCHITECTURES);
    env.set(`${prefix}VARIANT`, ["", ...VARIANTS]);
  }
  return env;
}

/**
 * Blank as BuildKit's parser has it, which is Go's: next line (U+0085) is blank and the byte order mark
 * is not, the other way round from JavaScript's `\s`. Every one of them is a single UTF-16 unit.
 */
const GO_SPACE_CHARACTER = new RegExp(`[${GO_SPACE}]`, "u");
const isGoSpace = (ch: string): boolean => GO_SPACE_CHARACTER.test(ch);

function goTrimStart(text: string): string {
  let start = 0;
  while (start < text.length && isGoSpace(text[start] as string)) {
    start += 1;
  }
  return text.slice(start);
}

function goTrim(text: string): string {
  const trimmed = goTrimStart(text);
  let end = trimmed.length;
  while (end > 0 && isGoSpace(trimmed[end - 1] as string)) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

/** A variable's name as BuildKit reads one: Unicode letters and digits, and `_`. */
const DIGIT = /^\p{Nd}$/u;
const NAME_START = /^[\p{L}_]$/u;
const NAME_PART = /^[\p{L}\p{Nd}_]$/u;
const SPECIAL_PARAMETER = /^[@*#?\-$!0]$/;

/**
 * The ways one word can come out, at most {@link MAX_CANDIDATES} of them and none longer than
 * {@link MAX_WORD}, every character written charged to the budget. Past any of those it gives up.
 */
function kept(values: Iterable<string>, budget: Budget): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value.length > MAX_WORD) {
      throw GAVE_UP;
    }
    charge(budget, value.length + 1);
    unique.add(value);
    if (unique.size > MAX_CANDIDATES) {
      throw GAVE_UP;
    }
  }
  return [...unique];
}

function* joined(left: readonly string[], right: readonly string[]): Generator<string> {
  for (const head of left) {
    for (const tail of right) {
      yield head + tail;
    }
  }
}

/** The ways a word can come out so far. Text they all share waits apart, so a long word stays cheap. */
class Ways {
  private results = [""];
  private longest = 0;
  private shared = "";

  constructor(private readonly budget: Budget) {}

  add(values: readonly string[]): void {
    if (values.length === 1) {
      const value = values[0] as string;
      charge(this.budget, value.length);
      this.shared += value;
      if (this.longest + this.shared.length > MAX_WORD) {
        throw GAVE_UP;
      }
      return;
    }
    this.flush();
    this.results = kept(joined(this.results, values), this.budget);
    this.longest = Math.max(...this.results.map((result) => result.length));
  }

  done(): string[] {
    this.flush();
    return this.results;
  }

  private flush(): void {
    if (this.shared !== "") {
      const shared = this.shared;
      charge(this.budget, this.results.length * shared.length);
      this.results = this.results.map((result) => result + shared);
      this.longest += shared.length;
      this.shared = "";
    }
  }
}

/** How deep substitutions may sit in each other's defaults before the reader stops following them. */
const MAX_DEPTH = 16;

/**
 * The words BuildKit's shell lexer makes of a word: quotes taken off, escapes applied and variables
 * substituted. A variable can hold more than one value here, so each result is one way it comes out.
 */
class Expansion {
  private pos = 0;
  private depth = 0;

  private constructor(
    private readonly text: string,
    private readonly env: Env,
    private readonly escapeToken: string,
    private readonly budget: Budget,
  ) {}

  /**
   * Every way a word comes out, or null when the reader gives up on it: a substitution it doesn't
   * follow, a variable it couldn't work out, too many ways, too long a word, or no work left.
   */
  static of(text: string, env: Env, escapeToken: string, budget: Budget): string[] | null {
    if (text.length > MAX_WORD) {
      return null;
    }
    try {
      return new Expansion(text, env, escapeToken, budget).until(null);
    } catch (error) {
      if (error === GAVE_UP) {
        return null;
      }
      throw error;
    }
  }

  /** Everything up to `stop`, or to the end. */
  private until(stop: string | null): string[] {
    const ways = new Ways(this.budget);
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (stop !== null && ch === stop) {
        this.pos += 1;
        return ways.done();
      }
      if (ch === "'") {
        ways.add([this.singleQuoted()]);
      } else if (ch === '"') {
        ways.add(this.doubleQuoted());
      } else if (ch === "$") {
        ways.add(this.dollar());
      } else {
        this.pos += 1;
        if (ch === this.escapeToken) {
          const next = this.text[this.pos];
          if (next === undefined) {
            break;
          }
          this.pos += 1;
          ways.add([next]);
        } else {
          ways.add([ch]);
        }
      }
    }
    if (stop !== null) {
      // BuildKit refuses a substitution that is never closed.
      throw GAVE_UP;
    }
    return ways.done();
  }

  private singleQuoted(): string {
    const end = this.text.indexOf("'", this.pos + 1);
    if (end === -1) {
      throw GAVE_UP;
    }
    const inside = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return inside;
  }

  private doubleQuoted(): string[] {
    this.pos += 1;
    const ways = new Ways(this.budget);
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw GAVE_UP;
      }
      if (ch === '"') {
        this.pos += 1;
        return ways.done();
      }
      if (ch === "$") {
        ways.add(this.dollar());
        continue;
      }
      this.pos += 1;
      if (ch === this.escapeToken) {
        const next = this.text[this.pos];
        if (next === undefined) {
          continue;
        }
        if (next === '"' || next === "$" || next === this.escapeToken) {
          this.pos += 1;
          ways.add([next]);
          continue;
        }
      }
      ways.add([ch]);
    }
  }

  /** The whole character at the current position, which may take two UTF-16 units. */
  private character(): string {
    const code = this.text.codePointAt(this.pos);
    return code === undefined ? "" : String.fromCodePoint(code);
  }

  /** The characters from here that `matches` takes, one whole character at a time. */
  private run(matches: RegExp): string {
    let taken = "";
    for (let ch = this.character(); ch !== "" && matches.test(ch); ch = this.character()) {
      taken += ch;
      this.pos += ch.length;
    }
    return taken;
  }

  private name(): string {
    const first = this.character();
    if (first === "") {
      return "";
    }
    if (DIGIT.test(first)) {
      return this.run(DIGIT);
    }
    if (SPECIAL_PARAMETER.test(first)) {
      this.pos += 1;
      return first;
    }
    return NAME_START.test(first) ? this.run(NAME_PART) : "";
  }

  /** A variable the reader couldn't work out makes whatever uses it one it can't work out either. */
  private valuesOf(name: string): readonly string[] {
    const values = this.env.get(name) ?? [""];
    if (values.length === 0) {
      throw GAVE_UP;
    }
    return values;
  }

  private dollar(): string[] {
    this.pos += 1;
    if (this.text[this.pos] !== "{") {
      const name = this.name();
      return name === "" ? ["$"] : [...this.valuesOf(name)];
    }
    this.pos += 1;
    const first = this.text[this.pos];
    if (first === undefined || first === "{" || first === "}" || first === ":" || this.depth >= MAX_DEPTH) {
      throw GAVE_UP;
    }
    const name = this.name();
    const values = this.valuesOf(name);
    let modifier = this.text[this.pos] ?? "";
    this.pos += 1;
    if (modifier === "}") {
      return [...values];
    }
    if (modifier === ":") {
      modifier += this.text[this.pos] ?? "";
      this.pos += 1;
    }
    if (!["-", ":-", "+", ":+", "?", ":?"].includes(modifier)) {
      // Patterns and replacements could make any name out of the value: nothing can be said of it.
      throw GAVE_UP;
    }
    this.depth += 1;
    const word = this.until("}");
    this.depth -= 1;
    return kept(this.substituted(modifier, values, word), this.budget);
  }

  private *substituted(
    modifier: string,
    values: readonly string[],
    word: readonly string[],
  ): Generator<string> {
    for (const value of values) {
      if (modifier === ":-" || modifier === "-") {
        yield* value !== "" ? [value] : modifier === "-" ? ["", ...word] : word;
      } else if (modifier === ":+" || modifier === "+") {
        yield* value !== "" ? word : modifier === "+" ? ["", ...word] : [""];
      } else {
        yield value;
      }
    }
  }
}

/** BuildKit's `parseWords`: split on blanks outside quotes, with the quotes and escapes left in. */
function parseWords(text: string, escapeToken: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  let blankOk = false;
  for (let pos = 0; pos < text.length; pos += 1) {
    const ch = text[pos] as string;
    if (quote !== "") {
      if (ch === quote) {
        quote = "";
      } else if (ch === escapeToken && quote !== "'") {
        if (pos + 1 === text.length) {
          quote = "";
          continue;
        }
        word += ch;
        pos += 1;
        word += text[pos];
        continue;
      }
      word += ch;
      continue;
    }
    if (isGoSpace(ch)) {
      if (inWord && (blankOk || word !== "")) {
        words.push(word);
      }
      word = "";
      inWord = false;
      blankOk = false;
      continue;
    }
    inWord = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
      blankOk = true;
    }
    if (ch === escapeToken) {
      if (pos + 1 === text.length) {
        continue;
      }
      word += ch;
      pos += 1;
      word += text[pos];
      continue;
    }
    word += ch;
  }
  if (inWord && (blankOk || word !== "")) {
    words.push(word);
  }
  return words;
}

/** What Go's `unicode.IsSpace` says of a byte taken for the character of that code: NEL and NBSP too. */
const isByteSpace = (ch: string): boolean => /^[\t\n\v\f\r \x85\xa0]$/.test(ch);

/**
 * BuildKit's `extractBuilderFlags`: the words starting with `--` at the head of an instruction's
 * arguments, quotes taken off and escapes applied, and what is left after them. It reads the line a byte
 * at a time, each taken for the character of that code, so here it is read from the line's UTF-8 bytes
 * as Latin-1: a character with a byte 0x85 or 0xA0, which Go takes for blanks, ends a flag in its middle,
 * and a flag holds what BuildKit makes of the bytes, not the characters.
 */
function builderFlags(text: string): { flags: string[]; rest: string } {
  const line = Buffer.from(text, "utf8").toString("latin1");
  const restFrom = (pos: number) => Buffer.from(line.slice(pos), "latin1").toString("utf8");
  const flags: string[] = [];
  let phase: "spaces" | "word" | "quote" = "spaces";
  let word = "";
  let quote = "";
  let blankOk = false;
  for (let pos = 0; pos <= line.length; pos += 1) {
    const ch = line[pos] ?? "";
    if (phase === "spaces") {
      if (pos === line.length) {
        break;
      }
      if (isByteSpace(ch)) {
        continue;
      }
      if (ch !== "-" || line[pos + 1] !== "-") {
        return { flags, rest: restFrom(pos) };
      }
      phase = "word";
    }
    if (pos === line.length) {
      if (word !== "--" && (blankOk || word !== "")) {
        flags.push(word);
      }
      break;
    }
    if (phase === "word") {
      if (isByteSpace(ch)) {
        phase = "spaces";
        if (word === "--") {
          return { flags, rest: restFrom(pos) };
        }
        if (blankOk || word !== "") {
          flags.push(word);
        }
        word = "";
        blankOk = false;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        blankOk = true;
        phase = "quote";
        continue;
      }
      if (ch === "\\") {
        if (pos + 1 < line.length) {
          pos += 1;
          word += line[pos];
        }
        continue;
      }
      word += ch;
      continue;
    }
    if (ch === quote) {
      phase = "word";
      continue;
    }
    if (ch === "\\") {
      if (pos + 1 === line.length) {
        phase = "word";
        continue;
      }
      pos += 1;
      word += line[pos];
      continue;
    }
    word += ch;
  }
  return { flags, rest: "" };
}

interface Instruction {
  command: string;
  flags: Array<{ name: string; value: string | null }>;
  rest: string;
}

/**
 * BuildKit's `splitCommand`: the line trimmed of Go's blanks, then the instruction's name up to the first
 * ASCII blank, which is all its own pattern splits on.
 */
function splitInstruction(text: string): Instruction {
  const match = /^([^\t\v\f\r ]+)(?:[\t\v\f\r ]+([\s\S]*))?$/.exec(goTrim(text));
  const { flags, rest } = builderFlags(match?.[2] ?? "");
  return {
    command: (match?.[1] ?? "").toLowerCase(),
    flags: flags.map((flag) => {
      const body = flag.replace(/^--/, "");
      const equals = body.indexOf("=");
      return equals === -1
        ? { name: body.toLowerCase(), value: null }
        : { name: body.slice(0, equals).toLowerCase(), value: body.slice(equals + 1) };
    }),
    rest: goTrim(rest),
  };
}

/** The fields of a `--mount` value, read as Go's CSV reader reads them, and kept when it would refuse. */
function csvFields(value: string): string[] {
  const fields: string[] = [];
  let pos = 0;
  while (pos <= value.length) {
    if (value[pos] === '"') {
      let field = "";
      pos += 1;
      while (pos < value.length) {
        if (value[pos] === '"') {
          if (value[pos + 1] === '"') {
            field += '"';
            pos += 2;
            continue;
          }
          pos += 1;
          break;
        }
        field += value[pos];
        pos += 1;
      }
      const comma = value.indexOf(",", pos);
      field += value.slice(pos, comma === -1 ? value.length : comma);
      fields.push(field);
      pos = comma === -1 ? value.length + 1 : comma + 1;
      continue;
    }
    const comma = value.indexOf(",", pos);
    fields.push(value.slice(pos, comma === -1 ? value.length : comma));
    pos = comma === -1 ? value.length + 1 : comma + 1;
  }
  return fields;
}

/** What a `--mount` takes its files from, if it says. */
function mountSources(value: string): string[] {
  return csvFields(value).flatMap((field) => {
    const equals = field.indexOf("=");
    return equals !== -1 && field.slice(0, equals).trim().toLowerCase() === "from"
      ? [field.slice(equals + 1)]
      : [];
  });
}

const isJsonArray = (text: string): boolean => {
  if (!text.startsWith("[")) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string");
  } catch {
    return false;
  }
};

function holdsHeredocs(text: string, nested = false): boolean {
  const { command, rest } = splitInstruction(text);
  if (command === "onbuild") {
    // BuildKit refuses `ONBUILD ONBUILD`: one level is all there is to read.
    return !nested && holdsHeredocs(rest, true);
  }
  return (command === "run" || command === "copy" || command === "add") && !isJsonArray(rest);
}

interface Heredoc {
  marker: string;
  /** `<<-`: leading tabs are taken off a line before it is compared with the marker. */
  chomp: boolean;
}

const NO_VALUES: Env = new Map();

/** A `$` substitution from `pos`, read from nothing, as the parser has no build argument. */
function substituteFromNothing(line: string, pos: number): { value: string; end: number } {
  const rest = line.slice(pos);
  let length = 1;
  if (rest.startsWith("${")) {
    let depth = 0;
    for (let index = 1; index < rest.length; index += 1) {
      depth += rest[index] === "{" ? 1 : rest[index] === "}" ? -1 : 0;
      if (depth === 0) {
        length = index + 1;
        break;
      }
      length = rest.length;
    }
  } else {
    length = /^\$(?:\p{Nd}+|[\p{L}_][\p{L}\p{Nd}_]*|[@*#?\-$!0])/u.exec(rest)?.[0].length ?? 1;
  }
  const values = Expansion.of(rest.slice(0, length), NO_VALUES, "\\", { left: MAX_WORK });
  return { value: values?.[0] ?? "", end: pos + length };
}

/**
 * The shell words of an instruction as BuildKit's heredoc detection reads them, with `\` as the escape
 * character whatever the file says: quotes and escapes kept, and variables substituted from nothing,
 * outside single quotes.
 */
function shellWordsForHeredocs(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let pos = 0;
  while (pos < line.length) {
    const ch = line[pos] as string;
    if (isGoSpace(ch)) {
      if (inWord) {
        words.push(word);
      }
      word = "";
      inWord = false;
      pos += 1;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = line.indexOf("'", pos + 1);
      const close = end === -1 ? line.length : end + 1;
      word += line.slice(pos, close);
      pos = close;
    } else if (ch === '"') {
      word += '"';
      pos += 1;
      while (pos < line.length && line[pos] !== '"') {
        const inner = line[pos] as string;
        if (inner === "$") {
          const { value, end } = substituteFromNothing(line, pos);
          word += value;
          pos = end;
        } else if (inner === "\\" && /["$\\]/.test(line[pos + 1] ?? "")) {
          word += line.slice(pos, pos + 2);
          pos += 2;
        } else {
          word += inner;
          pos += 1;
        }
      }
      if (pos < line.length) {
        word += '"';
        pos += 1;
      }
    } else if (ch === "\\") {
      word += line.slice(pos, pos + 2);
      pos += 2;
    } else if (ch === "$") {
      const { value, end } = substituteFromNothing(line, pos);
      word += value;
      pos = end;
    } else {
      word += ch;
      pos += 1;
    }
  }
  if (inWord) {
    words.push(word);
  }
  return words;
}

/**
 * BuildKit's `heredocsFromLine`: every word of the form `<<NAME`, in order. The marker is the name with
 * its quotes taken off and its escapes applied; no substitution is left in it by then. A marker this
 * reader can't make out counts as no heredoc, which the readings without heredocs cover.
 */
function heredocsOf(line: string): Heredoc[] {
  return shellWordsForHeredocs(line).flatMap((word) => {
    const match = /^(\d*)<<(-?)([^<]*)$/.exec(word);
    const rest = match?.[3] ?? "";
    if (match === null || rest === "") {
      return [];
    }
    const marker = Expansion.of(rest, NO_VALUES, "\\", { left: MAX_WORK })?.[0];
    return marker === undefined ? [] : [{ marker, chomp: match[2] === "-" }];
  });
}

function physicalLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, ""));
}

/** A comment as BuildKit tells one, after Go's blanks. */
const isComment = (line: string): boolean => goTrimStart(line).startsWith("#");

function trimContinuation(line: string, reading: Reading): { text: string; continues: boolean } {
  const match = new RegExp(`${reading.escapeToken === "\\" ? "\\\\" : "`"}[ \\t]*$`).exec(line);
  if (match === null) {
    return { text: line, continues: false };
  }
  const before = line.slice(0, match.index);
  if (!reading.escapedContinues && before.endsWith(reading.escapeToken)) {
    return { text: line, continues: false };
  }
  return { text: before, continues: true };
}

/** The instructions of a file, one per entry, as one reading has them. */
function instructionsOf(lines: readonly string[], reading: Reading): string[] {
  const instructions: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const first = goTrimStart(lines[index] ?? "");
    index += 1;
    if (first === "" || first.startsWith("#")) {
      continue;
    }
    let { text, continues } = trimContinuation(first, reading);
    while (continues && index < lines.length) {
      const next = lines[index] ?? "";
      index += 1;
      if (isComment(next) || goTrim(next) === "") {
        continue;
      }
      const joined = trimContinuation(next, reading);
      text += joined.text;
      continues = joined.continues;
    }
    if (goTrim(text) === "") {
      continue;
    }
    instructions.push(text);
    if (reading.heredocs && holdsHeredocs(text)) {
      for (const { marker, chomp } of heredocsOf(text)) {
        while (index < lines.length) {
          const body = lines[index] ?? "";
          index += 1;
          if ((chomp ? body.replace(/^\t+/, "") : body) === marker) {
            break;
          }
        }
      }
    }
  }
  return instructions;
}

interface Found {
  images: Set<string>;
  unresolved: Set<string>;
  budget: Budget;
}

/** The longest image reference: past it, nothing BuildKit reads as one. */
const MAX_REFERENCE = 512;

/** A word as an error may quote it: the start of one too long to be a name is enough to find it. */
const quoted = (word: string): string => {
  const trimmed = word.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
};

function collect(
  instructions: readonly string[],
  reading: Reading,
  buildArgs: ReadonlyMap<string, string>,
  found: Found,
): void {
  const meta = platformArgs();
  const stages = new Set<string>();
  let stage: Map<string, readonly string[]> | null = null;

  /** The values a word can take, or {@link UNKNOWN}, which is only worth saying once a name uses it. */
  const expandValue = (word: string, env: Env): readonly string[] =>
    Expansion.of(word, env, reading.escapeToken, found.budget) ?? UNKNOWN;

  /** The names an image reference can come out as. One the reader can't work out is said so. */
  const expandName = (word: string, env: Env): readonly string[] => {
    const values = expandValue(word, env);
    if (values === UNKNOWN) {
      found.unresolved.add(quoted(word));
    }
    return values;
  };

  const notImages = new Set<string>();
  const consider = (candidate: string) => {
    const value = candidate.trim();
    if (value === "" || value.length > MAX_REFERENCE || found.images.has(value) || notImages.has(value)) {
      return;
    }
    const lower = value.toLowerCase();
    if (/^\d+$/.test(value) || stages.has(lower) || lower === "scratch") {
      return;
    }
    found.budget.left -= WORK_PER_NAME;
    // Anything else BuildKit refuses outright, before it looks for an image.
    if (imageReference.safeParse(value).success) {
      found.images.add(value);
    } else {
      notImages.add(value);
    }
  };

  const declare = (rest: string, env: Map<string, readonly string[]>, global: boolean) => {
    for (const word of parseWords(rest, reading.escapeToken)) {
      const equals = word.indexOf("=");
      const name = equals === -1 ? word : word.slice(0, equals);
      const given = buildArgs.get(name);
      if (given !== undefined) {
        env.set(name, [given]);
      } else if (equals !== -1) {
        env.set(name, expandValue(word.slice(equals + 1), env));
      } else if (!global) {
        env.set(name, meta.get(name) ?? [""]);
      } else if (!env.has(name)) {
        env.set(name, [""]);
      }
    }
  };

  const setEnv = (rest: string, env: Map<string, readonly string[]>) => {
    const words = parseWords(rest, reading.escapeToken);
    if (words.length === 0) {
      return;
    }
    if (!(words[0] ?? "").includes("=")) {
      const [name = "", value = ""] = rest.split(/[\t\v\f\r ]+([\s\S]*)/);
      env.set(name, expandValue(value, env));
      return;
    }
    for (const word of words) {
      const equals = word.indexOf("=");
      if (equals > 0) {
        env.set(word.slice(0, equals), expandValue(word.slice(equals + 1), env));
      }
    }
  };

  const handle = (text: string, nested: boolean) => {
    const { command, flags, rest } = splitInstruction(text);
    if (command === "onbuild") {
      // BuildKit refuses `ONBUILD ONBUILD`, so a deeper one never builds: reading one level is enough,
      // and keeps a line of a thousand of them from being read a thousand times.
      if (!nested) {
        handle(rest, true);
      }
      return;
    }
    const env = stage ?? meta;
    for (const { name, value } of flags) {
      const sources =
        value === null ? [] : name === "from" ? [value] : name === "mount" ? mountSources(value) : [];
      for (const source of sources) {
        // BuildKit may or may not substitute these, depending on its version: both count.
        for (const candidate of [source, ...expandName(source, env)]) {
          consider(candidate);
        }
      }
    }
    if (nested) {
      return;
    }
    if (command === "arg") {
      declare(rest, env, stage === null);
    } else if (command === "env" && stage !== null) {
      setEnv(rest, stage);
    } else if (command === "from") {
      const words = rest.split(/[\t\v\f\r ]+/).filter((word) => word !== "");
      if (words[0] !== undefined) {
        for (const candidate of expandName(words[0], meta)) {
          consider(candidate);
        }
      }
      // A stage sees a global argument once it names it again: either way, here.
      stage = new Map(
        [...meta].map(([name, values]) => [name, values === UNKNOWN ? UNKNOWN : [...values, ""]]),
      );
      if (words.length >= 3 && words[1]?.toLowerCase() === "as" && words[2] !== undefined) {
        stages.add(words[2].toLowerCase());
      }
    }
  };

  for (const instruction of instructions) {
    if (found.budget.left <= 0) {
      return;
    }
    handle(instruction, false);
  }
}

const SYNTAX_DIRECTIVE = new RegExp(
  `^[${GO_SPACE}]*(?:#!?|//)[${GO_SPACE}]*syntax[${GO_SPACE}]*=[${GO_SPACE}]*([^${GO_SPACE}]+)`,
  "iu",
);

/** BuildKit drops a byte order mark, then a first line that starts with `#!`, before it looks for a syntax. */
function withoutPreamble(text: string): string {
  const body = text.replace(/^\uFEFF/, "");
  if (!body.startsWith("#!")) {
    return body;
  }
  const end = body.indexOf("\n");
  return end === -1 ? "" : body.slice(end + 1);
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** BuildKit looks for the syntax in comments of either kind, on lines of their own. */
function frontendsOf(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const match = SYNTAX_DIRECTIVE.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/**
 * The images and frontend a Dockerfile asks for. `buildArgs` are the values the build passes, which
 * replace the defaults of the arguments the file declares.
 */
export function readDockerfileImages(
  text: string,
  buildArgs: ReadonlyMap<string, string> = new Map(),
): DockerfileImages {
  if (text.length > MAX_DOCKERFILE_LENGTH) {
    return { images: [], frontends: [], json: false, unresolved: [TOO_MUCH_TO_READ] };
  }
  const lines = physicalLines(text);
  const found: Found = { images: new Set(), unresolved: new Set(), budget: { left: MAX_WORK } };
  for (const reading of READINGS) {
    if (found.budget.left <= 0) {
      break;
    }
    collect(instructionsOf(lines, reading), reading, buildArgs, found);
  }
  return {
    images: [...found.images],
    frontends: [...new Set(frontendsOf(lines))],
    json: isJsonObject(withoutPreamble(text)),
    // Once the work is used up, that is why a word could not be worked out: it is said first.
    unresolved: found.budget.left <= 0 ? [TOO_MUCH_TO_READ, ...found.unresolved] : [...found.unresolved],
  };
}
