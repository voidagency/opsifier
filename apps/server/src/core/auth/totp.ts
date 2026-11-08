import { Secret, TOTP } from "otpauth";

const ISSUER = "Opsifier";
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** One step either way tolerates a clock that is up to half a minute off. */
const WINDOW = 1;

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function buildOtpauthUri(email: string, secret: string): string {
  return new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  }).toString();
}

/**
 * Returns the time step `code` belongs to, or null when it is wrong or was already used.
 * `afterStep` is the last step accepted: anything at or before it is a replay.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  options: { now: number; afterStep: number | null },
): number | null {
  const timestamp = options.now;
  const delta = TOTP.validate({
    token: code,
    secret: Secret.fromBase32(secret),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
    timestamp,
    window: WINDOW,
    afterCounter: options.afterStep,
  });
  return delta === null ? null : TOTP.counter({ period: PERIOD_SECONDS, timestamp }) + delta;
}
