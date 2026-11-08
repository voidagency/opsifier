import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const themePreferences: readonly ThemePreference[] = ["system", "light", "dark"];

/** Also read by public/theme-boot.js, which applies the theme before first paint. */
const storageKey = "opsifier.theme";

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Storage can be blocked. The system theme still applies.
  }
  return "system";
}

let preference = readPreference();

function resolve(): ResolvedTheme {
  if (preference === "system") {
    return darkScheme.matches ? "dark" : "light";
  }
  return preference;
}

function apply(): void {
  document.documentElement.dataset.theme = resolve();
  for (const listener of listeners) {
    listener();
  }
}

darkScheme.addEventListener("change", () => {
  if (preference === "system") {
    apply();
  }
});

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, next);
    }
  } catch {
    // The choice still applies until the next reload.
  }
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, resolve);
}
