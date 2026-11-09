import { createContext, Script } from "node:vm";
import type { RedirectRule } from "@opsifier/contract";

/**
 * Whether a redirect rule, or an address given to the service, would send clients round in circles.
 * Nothing can decide that for every address a pattern might match, so this follows real ones: the
 * service's own addresses, under the paths its rules name, and only for as long as they stay on this
 * service. It refuses only a loop it actually walked. A pattern it can't evaluate, or a search that
 * runs out of time, says nothing either way.
 */

export interface LoopDomain {
  host: string;
  path: string;
  https: boolean;
  wildcard: boolean;
}

/** What just changed: a loop that was already there, and has nothing to do with it, stays removable. */
export type LoopFocus = { rule: RedirectRule } | { host: string };

/** Browsers give up at about twenty. A rule still redirecting here is growing, not arriving. */
const MAX_HOPS = 10;
const MAX_WALKS = 64;
const SEARCH_BUDGET_MS = 500;
const PATTERN_TIMEOUT_MS = 50;
const TAILS = ["", "x", "1", "/x", "/1"];

const LITERAL_PATH = /\/(?:\\[./+-]|[A-Za-z0-9._~%!'+,;:@&=/-])*/g;
const GO_VARIABLE = /\$(?:\$|\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/g;
const LEADING_FLAGS = /^\(\?([ims]+)\)/;

class OutOfTime extends Error {}

interface Compiled {
  rule: RedirectRule;
  pattern: RegExp;
}

interface Match {
  index: number;
  groups: readonly (string | undefined)[];
  named?: Readonly<Record<string, string | undefined>>;
}

const RUN = new Script(
  "subjects.map((subject) => Array.from(subject.matchAll(pattern), (match) => ({ index: match.index, groups: Array.from(match), named: match.groups })))",
);

/**
 * Patterns come from whoever can edit a service, and Go is the only engine that runs them safely.
 * JavaScript's backtracks, so here every evaluation has a clock that can stop it mid-match.
 */
function patternRunner(): (pattern: RegExp, subjects: readonly string[]) => Match[][] {
  const sandbox = createContext({});
  return (pattern, subjects) => {
    Object.assign(sandbox, { pattern, subjects });
    try {
      return RUN.runInContext(sandbox, { timeout: PATTERN_TIMEOUT_MS }) as Match[][];
    } catch {
      throw new OutOfTime();
    }
  };
}

/** The Go syntax that means the same thing here under another spelling. Anything else is left out. */
function toJavaScript(regex: string): RegExp | null {
  const flags = LEADING_FLAGS.exec(regex);
  const body = (flags === null ? regex : regex.slice(flags[0].length))
    .replaceAll("(?P<", "(?<")
    .replaceAll("\\A", "^")
    .replaceAll("\\z", "$");
  try {
    return new RegExp(body, `g${flags?.[1] ?? ""}`);
  } catch {
    return null;
  }
}

/** `$1`, `${1}` and `${name}` as Go expands them: a bare name runs as far as it can. */
function expand(template: string, match: Match): string {
  return template.replace(GO_VARIABLE, (whole, braced?: string, bare?: string) => {
    if (whole === "$$") {
      return "$";
    }
    const name = braced ?? bare ?? "";
    return (/^\d+$/.test(name) ? match.groups[Number(name)] : match.named?.[name]) ?? "";
  });
}

function rewrite(url: string, template: string, matches: readonly Match[]): string | null {
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += url.slice(cursor, match.index) + expand(template, match);
    cursor = match.index + (match.groups[0] ?? "").length;
  }
  try {
    return new URL(result + url.slice(cursor), url).href;
  } catch {
    return null;
  }
}

const isUnder = (path: string, parent: string): boolean =>
  parent === "/" || path === parent || path.startsWith(`${parent}/`);

function routeFor(url: URL, domains: readonly LoopDomain[]): LoopDomain | undefined {
  return domains.find(
    (domain) =>
      (domain.wildcard ? url.hostname.slice(url.hostname.indexOf(".") + 1) : url.hostname) === domain.host &&
      (url.protocol === "http:" || domain.https) &&
      isUnder(url.pathname, domain.path),
  );
}

interface Walk {
  rules: readonly Compiled[];
  domains: readonly LoopDomain[];
  focus: LoopFocus;
  run: ReturnType<typeof patternRunner>;
  deadline: number;
}

interface Hop {
  url: string;
  rule: RedirectRule | null;
}

/** One request. Traefik sends a client away only if a rule changes the address, in rule order. */
function nextHop(url: string, { rules, domains, run }: Walk): Hop | null {
  const parsed = new URL(url);
  const route = routeFor(parsed, domains);
  if (route === undefined) {
    return null;
  }
  if (parsed.protocol === "http:" && route.https) {
    return { url: `https:${url.slice("http:".length)}`, rule: null };
  }
  for (const { rule, pattern } of rules) {
    const [matches = []] = run(pattern, [url]);
    const next = matches.length === 0 ? null : rewrite(url, rule.replacement, matches);
    if (next !== null && next !== url) {
      return { url: next, rule };
    }
  }
  return null;
}

function walksInCircles(start: string, walk: Walk): boolean {
  const { focus, deadline } = walk;
  const seen = new Set([start]);
  let url = start;
  let involved = "host" in focus;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (Date.now() > deadline) {
      throw new OutOfTime();
    }
    const next = nextHop(url, walk);
    if (next === null) {
      return false;
    }
    involved ||= "rule" in focus && next.rule?.id === focus.rule.id;
    if (seen.has(next.url)) {
      return involved;
    }
    seen.add(next.url);
    url = next.url;
  }
  return involved;
}

function literalPaths(text: string): string[] {
  return Array.from(text.matchAll(LITERAL_PATH), (match) => {
    const literal = match[0].replaceAll("\\", "");
    // `//host/path`, from a URL written out in full: only what follows the host is a path.
    return literal.startsWith("//") ? literal.slice(literal.indexOf("/", 2)) : literal;
  }).filter((path) => path.startsWith("/"));
}

function startingPoints(
  rules: readonly RedirectRule[],
  domains: readonly LoopDomain[],
  focus: LoopFocus,
): string[] {
  const named = rules.flatMap((rule) => [...literalPaths(rule.regex), ...literalPaths(rule.replacement)]);
  const paths = new Set(["/", ...domains.map((domain) => domain.path), ...named]);
  const urls = new Set<string>();
  for (const domain of domains) {
    const host = domain.wildcard ? `x.${domain.host}` : domain.host;
    if ("host" in focus && focus.host !== host) {
      continue;
    }
    for (const path of paths) {
      for (const tail of TAILS) {
        urls.add(`https://${host}${path}${tail}`);
        urls.add(`http://${host}${path}${tail}`);
      }
    }
  }
  return [...urls].flatMap((url) => {
    try {
      return [new URL(url).href];
    } catch {
      return [];
    }
  });
}

/** An address from which the service's redirects never end because of `focus`, or null. */
export function findRedirectLoop(
  focus: LoopFocus,
  rules: readonly RedirectRule[],
  domains: readonly LoopDomain[],
): string | null {
  const compiled = rules.flatMap((rule) => {
    const pattern = rule.enabled ? toJavaScript(rule.regex) : null;
    return pattern === null ? [] : [{ rule, pattern }];
  });
  const own = "rule" in focus ? compiled.find(({ rule }) => rule.id === focus.rule.id) : undefined;
  if (compiled.length === 0 || ("rule" in focus && own === undefined)) {
    return null;
  }
  const run = patternRunner();
  const walk: Walk = { rules: compiled, domains, focus, run, deadline: Date.now() + SEARCH_BUDGET_MS };
  try {
    const candidates = startingPoints(rules, domains, focus);
    const matched = own === undefined ? null : run(own.pattern, candidates);
    const starts = candidates
      .filter((_, index) => matched === null || (matched[index] ?? []).length > 0)
      .slice(0, MAX_WALKS);
    return starts.find((start) => walksInCircles(start, walk)) ?? null;
  } catch (error) {
    if (error instanceof OutOfTime) {
      return null;
    }
    throw error;
  }
}
