import { notFound } from "@tanstack/react-router";

/** How the panel names projects, services and engines: nothing that could leave a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
/** Ids the panel makes, which may start with `_` or `-`: still no dot, slash, space or control. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A name read from the address bar, before a page puts it in the API addresses it calls. The router
 * decodes `%2F`, `%2E` or `%09` in it, so a name the panel would never give, with a slash, a dot step
 * or a control character, opens no page at all.
 */
export function routeName(value: string, rule: RegExp = NAME): string {
  if (!rule.test(value)) {
    throw notFound();
  }
  return value;
}

function checkedParams<const K extends string>(rule: RegExp, keys: readonly K[]) {
  return {
    parse: (raw: Record<K, string>): Record<K, string> => {
      const checked = {} as Record<K, string>;
      for (const key of keys) {
        checked[key] = routeName(raw[key], rule);
      }
      return checked;
    },
  };
}

/** A route's `params` option that checks these names before any of its loaders or pages read them. */
export const namedParams = <const K extends string>(...keys: K[]) => checkedParams(NAME, keys);

/** The same for ids the panel generated. */
export const idParams = <const K extends string>(...keys: K[]) => checkedParams(ID, keys);
