import { z } from "zod";
import { servicePath } from "../services";

/** A bcrypt input longer than this is silently cut short, so such a password is refused instead. */
const MAX_PASSWORD_BYTES = 72;
const USERNAME = /^[^\s:\p{Cc}]+$/u;

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const username = z
  .string()
  .trim()
  .min(1, "Required")
  .max(128, "This is too long")
  .regex(USERNAME, "No spaces, colons or control characters");

const password = z
  .string()
  .min(1, "Required")
  .refine((value) => value.trim() !== "", "Required")
  .refine(
    (value) => utf8Length(value) <= MAX_PASSWORD_BYTES,
    `Must be at most ${MAX_PASSWORD_BYTES} bytes long`,
  );

/** POST .../basic-auth */
export const createBasicAuthRequest = z.object({ username, password });
export type CreateBasicAuthRequest = z.infer<typeof createBasicAuthRequest>;

/** PUT .../basic-auth/{entry}: leaving the password out keeps the stored one. */
export const updateBasicAuthRequest = z.object({ username, password: password.optional() });
export type UpdateBasicAuthRequest = z.infer<typeof updateBasicAuthRequest>;

/**
 * What is kept. Traefik gets the hash. The password itself is sealed with the panel's key, so that
 * the people who manage the service can read it again: the hash never leaves the server, and the
 * password only through `POST .../basic-auth/{entry}/reveal`. An entry saved before the panel kept
 * passwords has none sealed, and becomes readable once it gets a new password.
 */
export const storedBasicAuthEntry = z.object({
  id: z.string(),
  username: z.string(),
  passwordHash: z.string(),
  sealedPassword: z.string().nullable().default(null),
});
export type StoredBasicAuthEntry = z.infer<typeof storedBasicAuthEntry>;

/**
 * One entry as the panel shows it: never with its password or hash. `revealable` says whether the
 * panel kept the password, so that it can be shown.
 */
export const basicAuthEntry = z.object({ id: z.string(), username: z.string(), revealable: z.boolean() });
export type BasicAuthEntry = z.infer<typeof basicAuthEntry>;

/** GET .../basic-auth */
export const basicAuthList = z.object({ entries: z.array(basicAuthEntry) });
export type BasicAuthList = z.infer<typeof basicAuthList>;

export const basicAuthPath = servicePath.extend({ entry: z.string().min(1).max(64) });

/** DELETE on one entry. */
export const deletedBasicAuth = z.object({ id: z.string() });
export type DeletedBasicAuth = z.infer<typeof deletedBasicAuth>;
