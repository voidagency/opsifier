import type { ProxyPageName } from "../../core/proxy";

export type PageLanguage = "en" | "fr";

interface PageCopy {
  title: string;
  message: string;
}

export interface PageStrings {
  documentTitle: Record<ProxyPageName | "maintenance", string>;
  pages: Record<ProxyPageName, PageCopy>;
  maintenance: PageCopy;
  retry: string;
}

export const strings: Record<PageLanguage, PageStrings> = {
  en: {
    documentTitle: {
      "bad-gateway": "Site not answering",
      "not-found": "Nothing at this address",
      stopped: "Site switched off",
      maintenance: "Down for maintenance",
    },
    pages: {
      "bad-gateway": {
        title: "This site isn't answering",
        message: "The application behind this address could not be reached. It may still be starting up.",
      },
      "not-found": {
        title: "Nothing at this address",
        message: "No site is set up here on this server. Check the address and try again.",
      },
      stopped: {
        title: "This site is switched off",
        message: "Its owner has stopped the application behind this address for now.",
      },
    },
    maintenance: {
      title: "Down for maintenance",
      message: "Work is under way on this site. It will be back shortly.",
    },
    retry: "Try again",
  },
  fr: {
    documentTitle: {
      "bad-gateway": "Site injoignable",
      "not-found": "Rien à cette adresse",
      stopped: "Site à l'arrêt",
      maintenance: "Site en maintenance",
    },
    pages: {
      "bad-gateway": {
        title: "Ce site ne répond pas",
        message:
          "L'application derrière cette adresse est injoignable. Elle est peut-être en cours de démarrage.",
      },
      "not-found": {
        title: "Rien à cette adresse",
        message: "Aucun site n'est configuré ici sur ce serveur. Vérifiez l'adresse puis réessayez.",
      },
      stopped: {
        title: "Ce site est à l'arrêt",
        message: "Son propriétaire a arrêté pour l'instant l'application derrière cette adresse.",
      },
    },
    maintenance: {
      title: "Site en maintenance",
      message: "Des travaux sont en cours sur ce site. Il sera bientôt de retour.",
    },
    retry: "Réessayer",
  },
};

/** The visitor's first choice between English and French, by quality value. Defaults to English. */
export function pickLanguage(header: string | undefined): PageLanguage {
  const preferences = (header ?? "")
    .split(",")
    .map((part) => {
      const [range = "", ...parameters] = part.trim().split(";");
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const value = quality === undefined ? 1 : Number.parseFloat(quality.trim().slice(2));
      return { language: range.trim().toLowerCase().split("-")[0], value: Number.isNaN(value) ? 0 : value };
    })
    .filter((entry) => entry.value > 0);
  const best = preferences
    .filter((entry) => entry.language === "fr" || entry.language === "en")
    .sort((a, b) => b.value - a.value)[0];
  return best?.language === "fr" ? "fr" : "en";
}
