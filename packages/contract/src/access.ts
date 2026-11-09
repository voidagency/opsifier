import { z } from "zod";
import { passwordMaxLength, userRole } from "./auth";
import { projectName } from "./common";

/** What someone may do inside one project they were given access to. */
export const projectRole = z.enum(["viewer", "operator"]);
export type ProjectRole = z.infer<typeof projectRole>;

export const projectGrant = z.strictObject({ project: projectName, role: projectRole });
export type ProjectGrant = z.infer<typeof projectGrant>;

const accountEmail = z.email("Enter a valid email address").max(254, "Must be at most 254 characters");
const accountPassword = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(passwordMaxLength, `Must be at most ${passwordMaxLength} characters`)
  .refine((value) => value.trim() !== "", "Must not be blank");

const projectGrants = z
  .array(projectGrant)
  .max(256, "At most 256 projects")
  .refine(
    (grants) => new Set(grants.map((grant) => grant.project)).size === grants.length,
    "Each project can only be listed once",
  );

/** One account, as an administrator sees it. */
export const panelUser = z.object({
  id: z.string(),
  email: z.string(),
  /** Empty for an account that was never asked for one. */
  name: z.string(),
  role: userRole,
  /** The account that claimed this panel: it cannot be deleted or demoted. */
  owner: z.boolean(),
  /** May open a shell on the server, list its disk and reboot it. Separate from service consoles. */
  hostAdmin: z.boolean().default(false),
  twoFactorEnabled: z.boolean(),
  /** False while it is deactivated: it can't sign in and holds no sessions or keys. */
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  projects: z.array(projectGrant),
  apiKeyCount: z.number().int().min(0),
});
export type PanelUser = z.infer<typeof panelUser>;

/** GET /api/v1/users */
export const userList = z.object({ users: z.array(panelUser) });
export type UserList = z.infer<typeof userList>;

export const userPath = z.object({ user: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id") });

/** POST /api/v1/users */
export const createUserRequest = z.strictObject({
  email: accountEmail,
  password: accountPassword,
  role: userRole.default("member"),
  projects: projectGrants.default([]),
});
export type CreateUserRequest = z.infer<typeof createUserRequest>;

/** PUT /api/v1/users/{user}. Every field is the new value, except a password left out stays as it is. */
export const updateUserRequest = z.strictObject({
  email: accountEmail,
  role: userRole,
  projects: projectGrants,
  password: accountPassword.optional(),
  /** Administering the server itself, which only the owner can hand out. Left out, it stays as it is. */
  hostAdmin: z.boolean().optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequest>;

/** DELETE /api/v1/users/{user}: the account's exact email, typed again. */
export const deleteUserRequest = z.strictObject({ confirm: z.string().min(1, "Required") });
export type DeleteUserRequest = z.infer<typeof deleteUserRequest>;

/** POST /api/v1/users/{user}/active */
export const setUserActiveRequest = z.strictObject({ active: z.boolean() });
export type SetUserActiveRequest = z.infer<typeof setUserActiveRequest>;

export const apiKeyLevel = z.enum(["read", "write"]);
export type ApiKeyLevel = z.infer<typeof apiKeyLevel>;

export const API_KEY_DEFAULT_DAYS = 90;
export const API_KEY_MAX_DAYS = 365;

/** An API key, without its secret. The secret exists only in the answer that created it. */
export const apiKey = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters of the secret, so people can tell keys apart. */
  prefix: z.string(),
  level: apiKeyLevel,
  /** The only projects it reaches. Null means every project its owner reaches. */
  projects: z.array(z.string()).nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
});
export type ApiKey = z.infer<typeof apiKey>;

/** GET /api/v1/me/api-keys and GET /api/v1/users/{user}/api-keys */
export const apiKeyList = z.object({ keys: z.array(apiKey) });
export type ApiKeyList = z.infer<typeof apiKeyList>;

export const apiKeyPath = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id") });
export const userApiKeyPath = userPath.extend(apiKeyPath.shape);

/** POST /api/v1/me/api-keys */
export const createApiKeyRequest = z.strictObject({
  name: z.string().trim().min(1, "Required").max(64, "Must be at most 64 characters"),
  level: apiKeyLevel.default("read"),
  projects: z.array(projectName).min(1, "Pick at least one project").max(256).nullable().default(null),
  expiresInDays: z
    .number()
    .int("Must be a whole number of days")
    .min(1, "At least one day")
    .max(API_KEY_MAX_DAYS, `At most ${API_KEY_MAX_DAYS} days`)
    .default(API_KEY_DEFAULT_DAYS),
});
export type CreateApiKeyRequest = z.input<typeof createApiKeyRequest>;

/** The answer to creating a key: the only time `token` is ever sent. */
export const createdApiKey = apiKey.extend({ token: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKey>;
