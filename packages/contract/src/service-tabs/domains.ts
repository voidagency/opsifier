import { z } from "zod";
import { servicePath } from "../services";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_CHARACTERS = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const MIDDLEWARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[a-z0-9-]+)?$/;
const RESOLVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_HOST_LENGTH = 253;
const MAX_PATH_LENGTH = 1024;
const MAX_MIDDLEWARES = 20;

/** Plain DNS names only. Whatever passes this can sit inside a Traefik rule. */
export function isValidHostname(host: string): boolean {
  const labels = host.split(".");
  return (
    host.length <= MAX_HOST_LENGTH &&
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? "")
  );
}

/** A URL path with no room for anything that could end a Traefik rule. */
export function isValidRoutePath(path: string): boolean {
  if (path.length > MAX_PATH_LENGTH || !PATH_CHARACTERS.test(path) || BAD_PERCENT.test(path)) {
    return false;
  }
  return path.split("/").every((segment, index) => {
    const dotSegment = segment === "." || segment === "..";
    const emptyInside = segment === "" && index > 0 && index < path.split("/").length - 1;
    return !dotSegment && !emptyInside;
  });
}

/** A resolver as named in Traefik's static configuration. */
export const isValidResolverName = (name: string): boolean => RESOLVER_NAME.test(name);

/** A Traefik middleware reference, with an optional `@provider`. */
export const isValidMiddlewareName = (name: string): boolean =>
  name.length <= 128 && MIDDLEWARE_NAME.test(name);

const withoutTrailingSlash = (path: string) => (path.length > 1 ? path.replace(/\/$/, "") : path);

export const domainHost = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Required")
  .max(MAX_HOST_LENGTH, "This is too long")
  .refine(isValidHostname, "Enter a full hostname such as app.example.com");

/** A public or internal path. `/api/` and `/api` route the same way, so only one is stored. */
export const routePath = z
  .string()
  .trim()
  .min(1, "Required")
  .max(MAX_PATH_LENGTH, "This is too long")
  .refine((value) => value.startsWith("/"), "Must start with /")
  .refine(isValidRoutePath, "Use only characters valid in a URL path, with no empty or dot segments")
  .overwrite(withoutTrailingSlash);

export const portNumber = z.number().int("Must be a whole number").min(1).max(65535);

export const destinationProtocol = z.enum(["http", "https"]);
export type DestinationProtocol = z.infer<typeof destinationProtocol>;

const certificateResolverName = z
  .string()
  .trim()
  .max(64, "This is too long")
  .refine(
    (value) => value === "" || RESOLVER_NAME.test(value),
    "Use letters, digits, dashes and underscores",
  );

/** Internal names are ours to attach, so a domain can't borrow them by name. */
const proxyMiddlewareName = z
  .string()
  .trim()
  .min(1, "Enter a middleware name, or remove this row")
  .max(128, "This is too long")
  .regex(MIDDLEWARE_NAME, "Use letters, digits, dots, dashes and underscores, then an optional @provider")
  .refine((value) => !value.startsWith("opsifier-"), "Names starting with opsifier- are reserved");

/** A wildcard certificate needs a DNS challenge, which the default resolver cannot do. */
const WILDCARD_NEEDS_RESOLVER = "A wildcard certificate needs a DNS-challenge resolver: name one";

/** POST /api/v1/projects/{project}/services/{service}/domains, and PUT on one domain. */
export const saveDomainRequest = z
  .object({
    host: domainHost,
    path: routePath.default("/"),
    https: z.boolean().default(true),
    port: portNumber.default(80),
    destinationProtocol: destinationProtocol.default("http"),
    destinationPath: routePath.default("/"),
    /** Empty means the default resolver. */
    certificateResolver: certificateResolverName.nullable().default(null),
    wildcard: z.boolean().default(false),
    middlewares: z
      .array(proxyMiddlewareName)
      .max(MAX_MIDDLEWARES, `At most ${MAX_MIDDLEWARES} middlewares`)
      .default([]),
  })
  .superRefine((value, context) => {
    if (value.wildcard && value.https && (value.certificateResolver ?? "") === "") {
      context.addIssue({
        code: "custom",
        path: ["certificateResolver"],
        message: WILDCARD_NEEDS_RESOLVER,
      });
    }
  });
export type SaveDomainRequest = z.input<typeof saveDomainRequest>;
export type SaveDomainFields = z.output<typeof saveDomainRequest>;

/** One place a service can be reached. */
export const domainEntry = z.object({
  id: z.string(),
  host: z.string(),
  path: z.string(),
  port: portNumber,
  https: z.boolean(),
  primary: z.boolean(),
  destinationProtocol,
  destinationPath: z.string(),
  certificateResolver: z.string().nullable(),
  wildcard: z.boolean(),
  middlewares: z.array(z.string()),
  /** What a browser opens. */
  url: z.string(),
  /** Where the proxy sends the traffic. Identical to the upstream in the generated configuration. */
  internalUrl: z.string(),
});
export type DomainEntry = z.infer<typeof domainEntry>;

/** GET /api/v1/projects/{project}/services/{service}/domains */
export const domainList = z.object({ domains: z.array(domainEntry) });
export type DomainList = z.infer<typeof domainList>;

export const domainPath = servicePath.extend({ domain: z.string().min(1).max(64) });

/** DELETE on one domain. */
export const deletedDomain = z.object({ id: z.string() });
export type DeletedDomain = z.infer<typeof deletedDomain>;

/** GET .../domains/exposed-ports: what the service's image declares. Empty until it has been pulled. */
export const exposedPorts = z.object({ ports: z.array(portNumber) });
export type ExposedPorts = z.infer<typeof exposedPorts>;
