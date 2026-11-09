import { z } from "zod";

export const opsifierAddressStatuses = ["active", "unreachable", "lost", "disabled", "off"] as const;
export const opsifierAddressStatus = z.enum(opsifierAddressStatuses);
export type OpsifierAddressStatus = z.infer<typeof opsifierAddressStatus>;

export const opsifierAddressCertificateStates = ["issued", "expiring", "expired", "pending"] as const;
export const opsifierAddressCertificateState = z.enum(opsifierAddressCertificateStates);
export type OpsifierAddressCertificateState = z.infer<typeof opsifierAddressCertificateState>;

/** GET /api/v1/server/opsifier-address */
export const opsifierAddressState = z.object({
  status: opsifierAddressStatus,
  /** False when this server was told never to call the service, so there is nothing to register. */
  available: z.boolean(),
  /** `<id>.<suffix>`, as the service gave it. Null while there is no address. */
  domain: z.string().nullable(),
  /** The one certificate that covers every name under the address. */
  wildcard: z.string().nullable(),
  certificate: opsifierAddressCertificateState.nullable(),
  /** Where the panel answers on a generated name: under the address, or on sslip.io without one. */
  panelUrl: z.string().nullable(),
  /** Where the service last saw this server. */
  ip: z.string().nullable(),
  registeredAt: z.iso.datetime().nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
});
export type OpsifierAddressState = z.infer<typeof opsifierAddressState>;

/** DELETE /api/v1/server/opsifier-address: confirmed by typing the address. */
export const releaseOpsifierAddressRequest = z.strictObject({
  confirm: z.string().min(1, "Required"),
});
export type ReleaseOpsifierAddressRequest = z.infer<typeof releaseOpsifierAddressRequest>;
