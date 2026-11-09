/**
 * Why a call did not succeed: a refusal from the panel, with the panel's own code and message, or
 * something the client stopped before anything was sent. Both carry the shape of an API error.
 */
export class ClientError extends Error {
  override readonly name = "ClientError";

  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status when the panel answered. Absent when nothing got that far. */
    readonly status?: number,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export type Locale = "en" | "fr";

const HINTS: Record<string, Record<Locale, string>> = {
  not_configured: {
    en: "Set OPSIFIER_URL to the panel's address and OPSIFIER_API_KEY to an API key from Settings, API keys.",
    fr: "Renseignez OPSIFIER_URL avec l'adresse du panneau et OPSIFIER_API_KEY avec une clé API créée dans Réglages, Clés API.",
  },
  invalid_url: {
    en: "OPSIFIER_URL is the panel's address and nothing else, for example https://panel.example.com.",
    fr: "OPSIFIER_URL contient l'adresse du panneau et rien d'autre, par exemple https://panel.example.com.",
  },
  invalid_token: {
    en: "The API key is revoked, expired, or belongs to another panel. Check OPSIFIER_API_KEY and OPSIFIER_URL.",
    fr: "La clé API est révoquée, expirée, ou celle d'un autre panneau. Vérifiez OPSIFIER_API_KEY et OPSIFIER_URL.",
  },
  unauthenticated: {
    en: "The panel did not accept this request as authenticated. Check OPSIFIER_API_KEY.",
    fr: "Le panneau n'a pas reconnu cette requête comme authentifiée. Vérifiez OPSIFIER_API_KEY.",
  },
  read_only_key: {
    en: "This key is limited to reading. Create a key with the write level in Settings, API keys.",
    fr: "Cette clé est limitée à la lecture. Créez une clé de niveau écriture dans Réglages, Clés API.",
  },
  session_required: {
    en: "This takes a person signed in at the panel. No API key can do it, whoever owns the key.",
    fr: "Cela demande une personne connectée au panneau. Aucune clé API ne peut le faire, quel que soit son propriétaire.",
  },
  admin_required: {
    en: "This takes an administrator whose key is not limited to some projects.",
    fr: "Cela demande un administrateur dont la clé n'est pas limitée à certains projets.",
  },
  forbidden: {
    en: "The account behind this key does not have the role this needs in the project.",
    fr: "Le compte derrière cette clé n'a pas le rôle nécessaire dans ce projet.",
  },
  not_found: {
    en: "It does not exist, or this key cannot reach it: anything out of reach answers as if it were missing.",
    fr: "Cela n'existe pas, ou cette clé n'y a pas accès : ce qui est hors de portée répond comme si cela n'existait pas.",
  },
  confirmation_mismatch: {
    en: "Give the exact name of what you are removing.",
    fr: "Indiquez le nom exact de ce que vous supprimez.",
  },
  validation_failed: {
    en: "The panel refused the values given: see the fields named above.",
    fr: "Le panneau a refusé les valeurs indiquées : voir les champs ci-dessus.",
  },
  unreachable: {
    en: "Check OPSIFIER_URL, and that this machine can reach the panel.",
    fr: "Vérifiez OPSIFIER_URL, et que cette machine peut joindre le panneau.",
  },
  timeout: {
    en: "The panel took too long to answer. Try again, and check its state.",
    fr: "Le panneau a mis trop de temps à répondre. Réessayez, et vérifiez son état.",
  },
  redirect_refused: {
    en: "Redirects are never followed, so that an API key cannot end up somewhere else. If that address really is your panel, set OPSIFIER_URL to it.",
    fr: "Les redirections ne sont jamais suivies, pour qu'une clé API ne parte pas ailleurs. Si cette adresse est bien celle de votre panneau, mettez-la dans OPSIFIER_URL.",
  },
  not_json: {
    en: "Something other than the panel answered. Check that OPSIFIER_URL is the panel's address.",
    fr: "Autre chose que le panneau a répondu. Vérifiez qu'OPSIFIER_URL est bien l'adresse du panneau.",
  },
  invalid_path: {
    en: "Give a path under /api/v1, with every placeholder replaced by its value.",
    fr: "Indiquez un chemin sous /api/v1, en remplaçant chaque paramètre par sa valeur.",
  },
};

/** What to do about an error, for people and agents alike. Undefined when there is nothing to add. */
export function hintFor(error: ClientError, locale: Locale = "en"): string | undefined {
  return HINTS[error.code]?.[locale];
}

/** How a client reports an error when it speaks JSON: the API's own shape, plus what to do about it. */
export function errorDocument(error: ClientError, locale: Locale = "en"): { error: Record<string, unknown> } {
  const hint = hintFor(error, locale);
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fields === undefined ? {} : { fields: error.fields }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(hint === undefined ? {} : { hint }),
    },
  };
}
