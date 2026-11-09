import { storedBuildConfig } from "@opsifier/contract";
import { z } from "zod";

const storedImageSource = z.object({
  type: z.literal("image"),
  image: z.string(),
  username: z.string().nullable(),
  sealedPassword: z.string().nullable(),
});
export type StoredImageSource = z.infer<typeof storedImageSource>;

const storedGithubSource = z.object({
  type: z.literal("github"),
  repository: z.string(),
  ref: z.string(),
  path: z.string(),
  /** The push webhook on the repository, while auto-deploy is on. */
  webhookId: z.number().int().nullable().default(null),
  /**
   * The repository the panel's GitHub token may be used for by this service. An administrator sets it
   * by saving the source, and it does not follow the source anywhere else.
   */
  tokenRepository: z.string().nullable().default(null),
});
export type StoredGithubSource = z.infer<typeof storedGithubSource>;

const storedGitSource = z.object({
  type: z.literal("git"),
  url: z.string(),
  ref: z.string(),
  path: z.string(),
});
export type StoredGitSource = z.infer<typeof storedGitSource>;

const storedDockerfileSource = z.object({
  type: z.literal("dockerfile"),
  dockerfile: z.string(),
});

const storedUploadSource = z.object({
  type: z.literal("upload"),
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
  uploadedAt: z.string(),
  path: z.string(),
});
export type StoredUploadSource = z.infer<typeof storedUploadSource>;

/** What is kept about a source. Secrets are sealed, and the API sees {@link StoredSource} only through `toPublic`. */
export const storedSource = z.discriminatedUnion("type", [
  storedImageSource,
  storedGithubSource,
  storedGitSource,
  storedDockerfileSource,
  storedUploadSource,
]);
export type StoredSource = z.infer<typeof storedSource>;

/** Everything else the Source and Deployments tabs keep about how a service gets built. */
export const storedBuildState = z.object({
  /** Null means: a Dockerfile if there is one, otherwise Nixpacks. */
  config: storedBuildConfig.nullable().default(null),
  /** Exists before the source does: the key has to be installed on the host before the first save. */
  sshKey: z
    .object({
      sealedPrivateKey: z.string(),
      publicKey: z.string(),
      /** The one repository it may be offered to, set when a source first uses it. */
      boundTo: z.string().nullable().default(null),
      createdAt: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Stored hashed: the token itself is only ever seen by whoever generated it, at that moment. */
  deployToken: z
    .object({
      hash: z.string(),
      /** The account that issued it, so a change to that account can revoke it. */
      createdBy: z.string().nullable().default(null),
      createdAt: z.string().nullable().default(null),
      /** Issued before tokens moved to a header: also accepted in the URL until it is replaced. */
      legacyUrl: z.boolean().default(true),
    })
    .nullable()
    .default(null),
  /** A push webhook. Its secret can't be hashed, because every delivery has to be signed again with it. */
  webhook: z
    .object({
      /** Names the webhook in its URL. Stays the same through a rotation, and proves nothing. */
      id: z.string(),
      /** Null for one from before webhooks had a secret: it is signed with the old trigger token. */
      sealedSecret: z.string().nullable(),
      /** What it was issued for: only these deploy, and a change refuses deliveries until rotation. */
      repository: z.string(),
      ref: z.string(),
      paused: z.boolean().default(false),
      createdBy: z.string().nullable().default(null),
      createdAt: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Build arguments, as sealed dotenv text. A build argument can end up in the image, so no secrets here. */
  sealedVariables: z.string().default(""),
  /** Handed to one build step while it runs, and never part of an image. Sealed, and only ever replaced. */
  secrets: z.record(z.string(), z.object({ sealed: z.string(), updatedAt: z.string() })).default({}),
  /**
   * Set on a service that was building before build variables existed: its builds still get the runtime
   * variables they always got, sealed references aside, until someone chooses what they need.
   */
  inheritsRuntime: z.boolean().default(false),
  /** Relative to the build path. Null when no variables are written to a file. */
  envFilePath: z.string().nullable().default(null),
  /** Whether that file goes in the build context, where a COPY puts it in an image layer. */
  envFileInImage: z.boolean().default(false),
});
export type StoredBuildState = z.infer<typeof storedBuildState>;

export const SSH_KEY_CONTEXT = "git-ssh-key";
export const WEBHOOK_SECRET_CONTEXT = "webhook-secret";
