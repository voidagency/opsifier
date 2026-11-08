import { buildConfig } from "@opsifier/contract";
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
  config: buildConfig.nullable().default(null),
  /** Exists before the source does: the key has to be installed on the host before the first save. */
  sshKey: z
    .object({
      sealedPrivateKey: z.string(),
      publicKey: z.string(),
    })
    .nullable()
    .default(null),
  /** Sealed so it can be shown again, hashed so a request can be matched to a service. */
  deployToken: z
    .object({
      hash: z.string(),
      sealed: z.string(),
    })
    .nullable()
    .default(null),
  /** Relative to the build path. Null when the environment is not written to a file. */
  envFilePath: z.string().nullable().default(null),
});
export type StoredBuildState = z.infer<typeof storedBuildState>;

export const SSH_KEY_CONTEXT = "git-ssh-key";
export const DEPLOY_TOKEN_CONTEXT = "deploy-token";
