import {
  goRegexError,
  type MaintenanceSettings,
  projectName,
  type RedirectRule,
  resourceName,
  type StoredBasicAuthEntry,
} from "@opsifier/contract";
import {
  BAD_GATEWAY_MIDDLEWARE,
  InvalidProxyInputError,
  maintenancePagePath,
  REDIRECT_HTTPS_MIDDLEWARE,
  STOPPED_MIDDLEWARE,
} from "../../../core/proxy";
import type { DomainInput } from "./domains";

export { REDIRECT_HTTPS_MIDDLEWARE };

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const BASIC_AUTH_USER = /^[^\s:]+$/;

export interface MiddlewaresInput {
  qualifiedName: string;
  project?: string;
  service?: string;
  redirects?: readonly RedirectRule[];
  basicAuth?: readonly StoredBasicAuthEntry[];
  maintenance?: Pick<MaintenanceSettings, "enabled">;
}

/** What one service adds to the proxy, beyond the shared middlewares in `_base.yaml`. */
export interface CompiledMiddlewares {
  /** Traefik middleware definitions owned by this service, by name. */
  definitions: Record<string, unknown>;
  /** Attached to every router of the service, after the per-domain ones. */
  attached: string[];
  /** The middleware that replaces the path with the maintenance page, while that is on. */
  maintenance: string | null;
}

function assertRedirect(rule: RedirectRule): void {
  if (goRegexError(rule.regex) !== null || /\s/.test(rule.regex) || /\s/.test(rule.replacement)) {
    throw new InvalidProxyInputError(`Invalid redirect rule: ${JSON.stringify(rule.regex)}.`);
  }
}

/** Traefik refuses a whole middleware for one bad entry, and a colon would split `user:hash` wrongly. */
function assertBasicAuthEntry(entry: StoredBasicAuthEntry): void {
  if (!BASIC_AUTH_USER.test(entry.username) || !BCRYPT_HASH.test(entry.passwordHash)) {
    throw new InvalidProxyInputError(`Invalid basic auth entry for ${JSON.stringify(entry.username)}.`);
  }
}

function compileRedirects(
  qualifiedName: string,
  redirects: readonly RedirectRule[],
): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  redirects
    .filter((rule) => rule.enabled)
    .forEach((rule, index) => {
      assertRedirect(rule);
      definitions[`opsifier-redirect-${qualifiedName}-${index}`] = {
        redirectRegex: { regex: rule.regex, replacement: rule.replacement, permanent: rule.permanent },
      };
    });
  return definitions;
}

function maintenanceMiddleware(
  input: MiddlewaresInput,
): { name: string; definition: Record<string, unknown> } | null {
  if (input.maintenance?.enabled !== true) {
    return null;
  }
  const project = projectName.safeParse(input.project);
  const service = resourceName.safeParse(input.service);
  if (!project.success || !service.success) {
    throw new InvalidProxyInputError("A maintenance page needs a valid project and service name.");
  }
  return {
    name: `opsifier-maintenance-${input.qualifiedName}`,
    definition: { replacePath: { path: maintenancePagePath(project.data, service.data) } },
  };
}

/** Basic auth, redirect rules and the maintenance page of one service. Pure, and validated here too. */
export function compileMiddlewares(input: MiddlewaresInput): CompiledMiddlewares {
  const { qualifiedName, redirects = [], basicAuth = [] } = input;
  const definitions: Record<string, unknown> = {};
  const attached: string[] = [];

  if (basicAuth.length > 0) {
    basicAuth.forEach(assertBasicAuthEntry);
    const name = `opsifier-auth-${qualifiedName}`;
    definitions[name] = {
      basicAuth: {
        users: basicAuth.map((entry) => `${entry.username}:${entry.passwordHash}`),
        removeHeader: true,
      },
    };
    attached.push(name);
  }

  const redirectDefinitions = compileRedirects(qualifiedName, redirects);
  Object.assign(definitions, redirectDefinitions);
  attached.push(...Object.keys(redirectDefinitions));

  const maintenance = maintenanceMiddleware(input);
  if (maintenance !== null) {
    definitions[maintenance.name] = maintenance.definition;
  }

  return { definitions, attached, maintenance: maintenance?.name ?? null };
}

export interface RouterMiddlewareOptions {
  /** The service runs no tasks: a 503 from the proxy shows the panel's page for that. */
  stopped?: boolean;
  /** Applied closest to the service, skipped while the maintenance page stands in for it. */
  domainSpecific?: readonly string[];
}

/** The middlewares one router of one domain gets, in order. */
export function routerMiddlewares(
  domain: Pick<DomainInput, "https" | "middlewares">,
  entry: "http" | "https",
  middlewares: CompiledMiddlewares,
  options: RouterMiddlewareOptions = {},
): string[] {
  const inMaintenance = middlewares.maintenance !== null;
  return [
    ...(entry === "http" && domain.https ? [REDIRECT_HTTPS_MIDDLEWARE] : []),
    BAD_GATEWAY_MIDDLEWARE,
    ...(options.stopped === true && !inMaintenance ? [STOPPED_MIDDLEWARE] : []),
    ...(domain.middlewares ?? []),
    ...middlewares.attached,
    ...(middlewares.maintenance === null ? (options.domainSpecific ?? []) : [middlewares.maintenance]),
  ];
}
