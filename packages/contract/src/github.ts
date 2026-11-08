import { z } from "zod";

/** GET /api/v1/settings/github. The token itself never leaves the server. */
export const githubStatus = z.object({
  configured: z.boolean(),
  /** The account the token belongs to, as GitHub reported when it was saved. */
  login: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type GithubStatus = z.infer<typeof githubStatus>;

/** PUT /api/v1/settings/github */
export const saveGithubTokenRequest = z.object({
  token: z.string().trim().min(1, "Required").max(1024, "This is too long"),
});
export type SaveGithubTokenRequest = z.infer<typeof saveGithubTokenRequest>;

export const githubRepositoryEntry = z.object({
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
});
export type GithubRepositoryEntry = z.infer<typeof githubRepositoryEntry>;

/** GET /api/v1/github/repositories */
export const githubRepositoryList = z.object({ items: z.array(githubRepositoryEntry) });
export type GithubRepositoryList = z.infer<typeof githubRepositoryList>;

export const githubSearchQuery = z.object({ q: z.string().trim().max(100, "This is too long").default("") });

export const githubRepositoryPath = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "Invalid owner"),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "Invalid repository"),
});

export const githubBranchList = z.object({ items: z.array(z.object({ name: z.string() })) });
export type GithubBranchList = z.infer<typeof githubBranchList>;
