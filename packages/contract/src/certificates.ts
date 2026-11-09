import { z } from "zod";

export const certificateState = z.enum(["valid", "expiring", "expired", "unreadable"]);
export type CertificateState = z.infer<typeof certificateState>;

export const certificate = z.object({
  id: z.string(),
  domain: z.string(),
  sans: z.array(z.string()),
  resolver: z.string(),
  issuer: z.string().nullable(),
  notBefore: z.iso.datetime().nullable(),
  notAfter: z.iso.datetime().nullable(),
  state: certificateState,
});
export type Certificate = z.infer<typeof certificate>;

/** GET /api/v1/certificates */
export const certificateList = z.object({ certificates: z.array(certificate) });
export type CertificateList = z.infer<typeof certificateList>;

export const certificatePath = z.object({ id: z.string().regex(/^[0-9a-f]{16,64}$/, "Invalid id") });

/** DELETE /api/v1/certificates/{id}: the certificate's main domain, typed again. */
export const deleteCertificateRequest = z.strictObject({ confirm: z.string().min(1, "Required") });
export type DeleteCertificateRequest = z.infer<typeof deleteCertificateRequest>;
