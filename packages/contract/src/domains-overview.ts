import { z } from "zod";
import { domainEntry, domainHost, routePath } from "./service-tabs/domains";

/** How a domain's HTTPS stands, from the certificates the proxy actually holds. */
export const domainTlsState = z.enum([
  "none",
  "issued",
  "expiring",
  "expired",
  "pending",
  /** The proxy holds something for this name that can't be read, so it can't be counted on. */
  "unreadable",
  /** HTTPS on a wildcard: nothing has shown that it works until the proxy holds the certificate. */
  "unverified",
]);
export type DomainTlsState = z.infer<typeof domainTlsState>;

export const customDomainServer = z.strictObject({
  url: z
    .url("Enter a full URL")
    .max(2048, "This is too long")
    .refine((value) => /^https?:\/\//i.test(value), "Must start with http:// or https://"),
  weight: z.number().int("Must be a whole number").min(1).max(1000).default(1),
});
export type CustomDomainServer = z.infer<typeof customDomainServer>;

const middlewareName = z.string().trim().min(1, "Enter a middleware name, or remove this row").max(128);

/** POST and PUT on /api/v1/domains/custom: a hostname that points at something outside the panel. */
export const saveCustomDomainRequest = z
  .strictObject({
    host: domainHost,
    path: routePath.default("/"),
    stripPath: z.boolean().default(false),
    https: z.boolean().default(true),
    servers: z.array(customDomainServer).min(1, "Add at least one server").max(32, "At most 32 servers"),
    certificateResolver: z.string().trim().max(64, "This is too long").nullable().default(null),
    wildcard: z.boolean().default(false),
    middlewares: z.array(middlewareName).max(20, "At most 20 middlewares").default([]),
  })
  .superRefine((value, context) => {
    if (value.wildcard && value.https && (value.certificateResolver ?? "") === "") {
      context.addIssue({
        code: "custom",
        path: ["certificateResolver"],
        message: "A wildcard certificate needs a DNS-challenge resolver: name one",
      });
    }
  });
export type SaveCustomDomainRequest = z.input<typeof saveCustomDomainRequest>;

export const customDomainPath = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id") });

export const deletedCustomDomain = z.object({ id: z.string() });

/** One row of the Domains page: a service's domain, or a custom destination. */
export const overviewDomain = z.discriminatedUnion("destination", [
  domainEntry.extend({
    destination: z.literal("service"),
    projectName: z.string(),
    serviceName: z.string(),
    tls: domainTlsState,
  }),
  z.object({
    destination: z.literal("custom"),
    id: z.string(),
    host: z.string(),
    path: z.string(),
    stripPath: z.boolean(),
    https: z.boolean(),
    url: z.string(),
    servers: z.array(z.object({ url: z.string(), weight: z.number().int() })),
    certificateResolver: z.string().nullable(),
    wildcard: z.boolean(),
    middlewares: z.array(z.string()),
    tls: domainTlsState,
  }),
]);
export type OverviewDomain = z.infer<typeof overviewDomain>;

/** GET /api/v1/domains */
export const domainsOverview = z.object({
  domains: z.array(overviewDomain),
  /** Where DNS records should point. Null when the server's address is unknown. */
  serverIp: z.string().nullable(),
  /** The projects whose domains the caller may change. Null means all of them. */
  managedProjects: z.array(z.string()).nullable().default(null),
});
export type DomainsOverview = z.infer<typeof domainsOverview>;
