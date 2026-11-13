import { z } from "zod";

export const userRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof userRole>;

export const sessionUser = z.object({
  id: z.string(),
  email: z.email(),
  role: userRole,
  twoFactorEnabled: z.boolean(),
  /** May open a shell on the server, list its disk and reboot it. */
  hostAdmin: z.boolean().default(false),
});
export type SessionUser = z.infer<typeof sessionUser>;

/** GET /api/v1/auth/session */
export const sessionState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("needs-setup") }),
  z.object({ status: z.literal("signed-out") }),
  z.object({
    status: z.literal("signed-in"),
    user: sessionUser,
    /**
     * True while this panel requires two-factor sign-in and this account hasn't turned it on: until it
     * does, turning it on is all it can do.
     */
    twoFactorSetupRequired: z.boolean().default(false),
  }),
]);
export type SessionState = z.infer<typeof sessionState>;

/** No address can be longer (RFC 5321), and these end up in rate-limit keys and audit lines. */
const email = z.email().max(254, "Must be at most 254 characters");

/** What someone is called: free text, on one line, and shown back in the interface. */
export const personName = z
  .string("Required")
  .trim()
  .min(1, "Required")
  .max(100, "Must be at most 100 characters")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Must not contain control characters");

/** Longer than any passphrase or password manager produces, and far too short to burden the hash. */
export const passwordMaxLength = 256;

const tooLongPassword = `Must be at most ${passwordMaxLength} characters`;
const newPassword = z.string().min(12, "Use at least 12 characters").max(passwordMaxLength, tooLongPassword);
const existingPassword = z.string().min(1, "Required").max(passwordMaxLength, tooLongPassword);

const totpCode = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

/** Printed in groups of four, but the dashes and the case do not matter when it is typed back. */
export const recoveryCode = z
  .string()
  .trim()
  .regex(/^[0-9a-z]{4}(?:[- ]?[0-9a-z]{4}){3}$/i, "Enter a recovery code");

/** POST /api/v1/auth/setup: only valid while no user exists. */
export const setupRequest = z.object({
  /** The one-time code printed in the server log at boot. */
  token: z.string().trim().min(1, "Required").max(128, "That setup code is not valid"),
  name: personName,
  email,
  password: newPassword,
});
export type SetupRequest = z.infer<typeof setupRequest>;

/** POST /api/v1/auth/login. Past the password, an account with 2FA needs one of the two codes. */
export const loginRequest = z.object({
  email,
  password: existingPassword,
  code: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof loginRequest>;

/** Returned with 401 when the password is right but a 2FA code is needed. */
export const twoFactorRequiredCode = "two_factor_required";

/** POST /api/v1/auth/credentials */
export const changeCredentialsRequest = z.object({
  email,
  currentPassword: existingPassword,
  newPassword,
});
export type ChangeCredentialsRequest = z.infer<typeof changeCredentialsRequest>;

/** POST /api/v1/auth/two-factor/begin. A stolen session must not be able to enrol its own device. */
export const twoFactorBegin = z.object({
  currentPassword: existingPassword,
});
export type TwoFactorBegin = z.infer<typeof twoFactorBegin>;

export const twoFactorSetup = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TwoFactorSetup = z.infer<typeof twoFactorSetup>;

/** POST /api/v1/auth/two-factor/enable */
export const twoFactorConfirm = z.object({
  code: totpCode,
});
export type TwoFactorConfirm = z.infer<typeof twoFactorConfirm>;

/** The answer to /enable: the new session state plus the recovery codes, returned this once. */
export const twoFactorEnabled = z.object({
  status: z.literal("signed-in"),
  user: sessionUser,
  recoveryCodes: z.array(z.string()),
});
export type TwoFactorEnabled = z.infer<typeof twoFactorEnabled>;

/** POST /api/v1/auth/two-factor/disable. A recovery code is accepted so a lost phone is not a dead end. */
export const twoFactorDisable = z
  .object({
    currentPassword: existingPassword,
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
  })
  .refine((value) => value.code !== undefined || value.recoveryCode !== undefined, {
    path: ["code"],
    message: "Enter the 6-digit code or a recovery code",
  });
export type TwoFactorDisable = z.infer<typeof twoFactorDisable>;

/** PUT /api/v1/settings/two-factor. Only the owner changes it, once their own account has it. */
export const twoFactorPolicy = z.strictObject({
  /** Every account must turn on two-factor sign-in, and can do nothing else until it has. */
  required: z.boolean(),
});
export type TwoFactorPolicy = z.infer<typeof twoFactorPolicy>;

/** GET /api/v1/settings/two-factor */
export const twoFactorPolicyState = z.object({
  required: z.boolean(),
  /** Accounts without two-factor sign-in: while it is required, they can only turn it on. */
  accountsWithout: z.number().int().min(0),
  /** Whether the person asking may change it: only the owner can. */
  canChange: z.boolean(),
});
export type TwoFactorPolicyState = z.infer<typeof twoFactorPolicyState>;
