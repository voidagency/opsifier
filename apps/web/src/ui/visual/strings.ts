import i18next from "i18next";

/** The `visual` namespace: the words of the state language. Keep labels to one or two words. */
export const visualStrings = {
  en: {
    state: {
      failed: "Failed",
      degraded: "Degraded",
      unknown: "Unknown",
      progress: "In progress",
      running: "Running",
      stopped: "Stopped",
    },
    health: {
      label: "Health summary",
      count: "{{state}}: {{count}}",
      problems_one: "{{count}} problem",
      problems_other: "{{count}} problems",
      allClear: "All clear",
      empty: "Nothing yet",
    },
    quantity: {
      noData: "No data",
    },
  },
  fr: {
    state: {
      failed: "En échec",
      degraded: "Dégradé",
      unknown: "Inconnu",
      progress: "En cours",
      running: "En marche",
      stopped: "Arrêté",
    },
    health: {
      label: "Résumé de l'état",
      count: "{{state}} : {{count}}",
      problems_one: "{{count}} problème",
      problems_other: "{{count}} problèmes",
      allClear: "Tout va bien",
      empty: "Rien pour l'instant",
    },
    quantity: {
      noData: "Aucune donnée",
    },
  },
} as const;

function register(): void {
  for (const [language, strings] of Object.entries(visualStrings)) {
    i18next.addResourceBundle(language, "visual", strings);
  }
}

if (i18next.isInitialized) {
  register();
} else {
  i18next.on("initialized", register);
}
