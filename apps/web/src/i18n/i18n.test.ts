import { describe, expect, it } from "vitest";

type Bundle = { default: Record<string, unknown> };

const bundles = import.meta.glob<Bundle>("./*/*.json", { eager: true });

function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, inner]) =>
    flatten(inner, prefix === "" ? key : `${prefix}.${key}`),
  );
}

const byLanguage = (language: string) => {
  const entries: Record<string, string[]> = {};
  for (const [path, bundle] of Object.entries(bundles)) {
    const [, lang, namespace] = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
    if (lang === language && namespace !== undefined) {
      entries[namespace] = flatten(bundle.default).sort();
    }
  }
  return entries;
};

const withoutPlural = (keys: string[]) => keys.map((key) => key.replace(/_(one|other)$/, ""));

describe("translations", () => {
  const en = byLanguage("en");
  const fr = byLanguage("fr");

  it("have the same namespaces in English and French", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(Object.keys(en))("have the same keys for %s", (namespace) => {
    expect(withoutPlural(fr[namespace] ?? [])).toEqual(withoutPlural(en[namespace] ?? []));
  });
});
