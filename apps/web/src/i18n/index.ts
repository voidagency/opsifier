import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const languages = ["en", "fr"] as const;
export type Language = (typeof languages)[number];

const storageKey = "opsifier.language";

type Bundle = { default: Record<string, unknown> };
const bundles = import.meta.glob<Bundle>("./*/*.json", { eager: true });

// One JSON file per feature and language: ./<language>/<feature>.json becomes a namespace.
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, bundle] of Object.entries(bundles)) {
  const [, language, feature] = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
  if (language && feature) {
    resources[language] = { ...resources[language], [feature]: bundle.default };
  }
}

function isLanguage(value: string | null | undefined): value is Language {
  return languages.includes(value as Language);
}

function detectLanguage(): Language {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    // Storage can be blocked. Fall back to the browser's language.
  }
  if (isLanguage(stored)) {
    return stored;
  }
  const browser = navigator.language.split("-")[0];
  return isLanguage(browser) ? browser : "en";
}

const initialLanguage = detectLanguage();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "en",
  defaultNS: "common",
  initAsync: false,
  interpolation: { escapeValue: false },
});

document.documentElement.lang = initialLanguage;

/** Applies a language immediately and remembers it in this browser. */
export function setLanguage(language: Language): void {
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
  try {
    localStorage.setItem(storageKey, language);
  } catch {
    // The choice still applies until the next reload.
  }
}

export { i18n };
