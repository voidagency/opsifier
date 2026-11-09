// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are the literal text of replacement templates
import type { RedirectRule } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { findRedirectLoop, type LoopDomain } from "./loops";

const domain = (overrides: Partial<LoopDomain> = {}): LoopDomain => ({
  host: "app.example.test",
  path: "/",
  https: false,
  wildcard: false,
  ...overrides,
});

let nextId = 0;
const rule = (regex: string, replacement: string, overrides: Partial<RedirectRule> = {}): RedirectRule => {
  nextId += 1;
  return { id: `rule-${nextId}`, enabled: true, permanent: false, regex, replacement, ...overrides };
};

const loopOf = (saved: RedirectRule, others: RedirectRule[] = [], domains = [domain()]) =>
  findRedirectLoop({ rule: saved }, [...others, saved], domains);

describe("the search for a redirect loop", () => {
  it("finds two rules pointing at each other", () => {
    const toTwo = rule("^(https?://[^/]+)/one$", "${1}/two");
    const toOne = rule("^(https?://[^/]+)/two$", "${1}/one");

    expect(loopOf(toOne, [toTwo])).toBe("http://app.example.test/two");
  });

  it("finds a longer circle", () => {
    const rules = [
      rule("^http://app\\.example\\.test/a$", "http://app.example.test/b"),
      rule("^http://app\\.example\\.test/b$", "http://app.example.test/c"),
    ];
    const closing = rule("^http://app\\.example\\.test/c$", "http://app.example.test/a");

    expect(loopOf(closing, rules)).not.toBeNull();
  });

  it("finds a rule that keeps growing the address and never arrives", () => {
    expect(
      loopOf(rule("^http://app\\.example\\.test/(.*)$", "http://app.example.test/x/${1}")),
    ).not.toBeNull();
  });

  it("finds a downgrade that the service's own HTTPS redirect sends straight back", () => {
    const downgrade = rule("^https://app\\.example\\.test/(.*)$", "http://app.example.test/${1}");

    expect(loopOf(downgrade, [], [domain({ https: true })])).not.toBeNull();
  });

  it("uses a relative target the way a browser would", () => {
    const toTwo = rule("^https?://[^/]+/one$", "/two");
    const toOne = rule("^https?://[^/]+/two$", "/one");

    expect(loopOf(toOne, [toTwo])).not.toBeNull();
  });

  it("sees the group values Go would expand, including a bare name", () => {
    const toTwo = rule("^(?P<origin>https?://[^/]+)/one$", "$origin/two");
    const toOne = rule("^(?P<origin>https?://[^/]+)/two$", "${origin}/one");

    expect(loopOf(toOne, [toTwo])).not.toBeNull();
  });

  it("is not fooled by flags Go accepts and JavaScript spells differently", () => {
    const toTwo = rule("(?i)^(HTTP://[^/]+)/one$", "${1}/two");
    const toOne = rule("(?i)^(HTTP://[^/]+)/two$", "${1}/one");

    expect(loopOf(toOne, [toTwo])).not.toBeNull();
  });

  it("leaves a rule that arrives", () => {
    expect(
      loopOf(rule("^http://app\\.example\\.test/old/(.*)$", "http://app.example.test/new/${1}")),
    ).toBeNull();
  });

  it("knows a rule that leaves the address unchanged is no redirect at all", () => {
    expect(loopOf(rule("^(https?)://app\\.example\\.test/(.*)$", "${1}://app.example.test/${2}"))).toBeNull();
  });

  it("does not follow an address that goes to another service", () => {
    const away = rule("^http://app\\.example\\.test/(.*)$", "http://elsewhere.example.test/${1}");
    const back = rule("^http://elsewhere\\.example\\.test/(.*)$", "http://app.example.test/${1}");

    expect(loopOf(back, [away])).toBeNull();
  });

  it("stops at the upgrade to HTTPS when the domain has HTTPS", () => {
    const upgrade = rule("^http://app\\.example\\.test/(.*)$", "https://app.example.test/${1}");

    expect(loopOf(upgrade, [], [domain({ https: true })])).toBeNull();
  });

  it("ignores a switched-off rule, and does not look at one that is being saved off", () => {
    const toTwo = rule("^(https?://[^/]+)/one$", "${1}/two");
    const off = rule("^(https?://[^/]+)/two$", "${1}/one", { enabled: false });

    expect(loopOf(off, [toTwo])).toBeNull();
    expect(loopOf(toTwo, [off])).toBeNull();
  });

  it("does not blame a new rule for a loop it has nothing to do with", () => {
    const toTwo = rule("^(https?://[^/]+)/one$", "${1}/two");
    const toOne = rule("^(https?://[^/]+)/two$", "${1}/one");

    expect(loopOf(rule("^(https?://[^/]+)/three$", "${1}/four"), [toTwo, toOne])).toBeNull();
  });

  it("has nothing to walk on a service with no address", () => {
    const toTwo = rule("^(https?://[^/]+)/one$", "${1}/two");
    const toOne = rule("^(https?://[^/]+)/two$", "${1}/one");

    expect(loopOf(toOne, [toTwo], [])).toBeNull();
  });

  it("gives up in time on a pattern built to run for ever, and refuses nothing over it", () => {
    const started = Date.now();

    expect(loopOf(rule(`^http://${"a".repeat(45)}(a+)+!/$`, "http://x/"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("looks at what an address brings, for a change of domain", () => {
    const toTwo = rule("^http://one\\.example\\.test/(.*)$", "http://two.example.test/${1}");
    const toOne = rule("^http://two\\.example\\.test/(.*)$", "http://one.example.test/${1}");
    const domains = [domain({ host: "one.example.test" }), domain({ host: "two.example.test" })];

    expect(findRedirectLoop({ host: "two.example.test" }, [toTwo, toOne], domains)).not.toBeNull();
    expect(findRedirectLoop({ host: "other.example.test" }, [toTwo, toOne], domains)).toBeNull();
  });
});
