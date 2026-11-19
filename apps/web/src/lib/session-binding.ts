/**
 * The second secret of a session opened over plain HTTP. A browser sends the session cookie to every
 * port of the server, so a service published on another port receives it too. This secret stays
 * with the panel's own pages, since storage is kept per address with its port, and goes back with
 * every request: a cookie caught anywhere else opens nothing.
 */
const KEY = "opsifier-session-binding";

/** Where the secret lives when the browser refuses storage, so that at least this page keeps working. */
let unstored: string | null = null;

export function sessionBinding(): string | null {
  try {
    return window.localStorage.getItem(KEY) ?? unstored;
  } catch {
    return unstored;
  }
}

/** Kept after a sign-in that returned one, forgotten after any other sign-in and after signing out. */
export function keepSessionBinding(binding: string | undefined): void {
  unstored = binding ?? null;
  try {
    if (binding === undefined) {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, binding);
    }
  } catch {
    // Storage is off: the copy in memory serves until the page is closed.
  }
}

/** What a call to the panel carries. */
export function bindingHeaders(): Record<string, string> {
  const binding = sessionBinding();
  return binding === null ? {} : { "X-Opsifier-Binding": binding };
}

/** For an address the browser opens by itself, a download or a hop, which can't carry a header. */
export function withBinding(url: string): string {
  const binding = sessionBinding();
  if (binding === null) {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}binding=${encodeURIComponent(binding)}`;
}

/** The subprotocols a WebSocket to the panel asks for: a WebSocket carries no header of its own. */
export function panelProtocols(): string[] {
  const binding = sessionBinding();
  return binding === null ? ["opsifier"] : ["opsifier", `opsifier-binding.${binding}`];
}
