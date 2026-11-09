import { z } from "zod";

export const opsifierAddressStatuses = [
  "active",
  "unreachable",
  "lost",
  "disabled",
  "requested",
  "refused",
  "off",
] as const;
export const opsifierAddressStatus = z.enum(opsifierAddressStatuses);
export type OpsifierAddressStatus = z.infer<typeof opsifierAddressStatus>;

export const opsifierAddressCertificateStates = ["issued", "expiring", "expired", "pending"] as const;
export const opsifierAddressCertificateState = z.enum(opsifierAddressCertificateStates);
export type OpsifierAddressCertificateState = z.infer<typeof opsifierAddressCertificateState>;

/** GET /api/v1/server/opsifier-address */
export const opsifierAddressState = z.object({
  status: opsifierAddressStatus,
  /** False when this server was told never to call the service, so there is nothing to ask for. */
  available: z.boolean(),
  /** `<id>.<suffix>`, as the service gave it: already known while a request waits. Null with neither. */
  domain: z.string().nullable(),
  /** The one certificate that covers every name under the address. */
  wildcard: z.string().nullable(),
  certificate: opsifierAddressCertificateState.nullable(),
  /** Where the panel answers on a generated name: under the address, or on sslip.io without one. */
  panelUrl: z.string().nullable(),
  /** Where the service last saw this server. */
  ip: z.string().nullable(),
  registeredAt: z.iso.datetime().nullable(),
  /** When this server asked, while it is waiting for the answer. */
  requestedAt: z.iso.datetime().nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
});
export type OpsifierAddressState = z.infer<typeof opsifierAddressState>;

/** POST /api/v1/server/opsifier-address/request: read by the person who decides. */
export const requestOpsifierAddressRequest = z.strictObject({
  email: z.email("Enter a valid email address"),
  purpose: z.string().trim().min(1, "Required").max(500, "Keep it under 500 characters"),
});
export type RequestOpsifierAddressRequest = z.infer<typeof requestOpsifierAddressRequest>;

/** DELETE /api/v1/server/opsifier-address: confirmed by typing the address. */
export const releaseOpsifierAddressRequest = z.strictObject({
  confirm: z.string().min(1, "Required"),
});
export type ReleaseOpsifierAddressRequest = z.infer<typeof releaseOpsifierAddressRequest>;
