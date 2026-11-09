import { isSshRemote } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../../../core/context";
import { services } from "../../../core/db/schema";
import type { AppServiceSpec } from "../../services/spec";
import { gitSourceOf, repositoryKey } from "../source/identity";
import { newHookId } from "./webhook";

interface RawToken {
  hash: string;
  sealed?: string;
}

interface RawKey {
  boundTo?: string | null;
}

interface RawBuild {
  deployToken?: RawToken | null;
  webhook?: unknown;
  sshKey?: RawKey | null;
}

interface RawGithubSource {
  type: "github";
  repository: string;
  tokenRepository?: string | null;
}

/** A spec as it was written, which is the only way to see that a newer field was never set. */
interface RawSpec {
  build?: RawBuild;
  source?: { type: string; repository?: string; tokenRepository?: string | null } | null;
  compose?: unknown;
}

const isGithubSource = (source: RawSpec["source"]): source is RawGithubSource =>
  source?.type === "github" && typeof source.repository === "string";

/** One stored spec, brought up to rules it had no way of following before. Null if there is nothing to do. */
function upgradeSpec(spec: RawSpec): RawSpec | null {
  let changed = false;
  const build: RawBuild = { ...(spec.build ?? {}) };
  let source = spec.source ?? null;
  const git = gitSourceOf(spec as Pick<AppServiceSpec, "source" | "compose">);

  const token = build.deployToken;
  if (token !== null && token !== undefined && token.sealed !== undefined) {
    // It keeps working, in its URL too, until someone replaces it. It just can't be read any more.
    build.deployToken = { hash: token.hash, createdBy: null, createdAt: null, legacyUrl: true } as RawToken;
    if (git !== null && (build.webhook ?? null) === null) {
      // A hook made from it, by the panel or by hand, keeps being accepted, signed with that token.
      build.webhook = {
        id: newHookId(),
        sealedSecret: null,
        repository: git.repository,
        ref: git.ref,
        paused: false,
        createdBy: null,
        createdAt: null,
      };
    }
    changed = true;
  }

  // Using the panel's token was already allowed for whatever a service was saved with: it keeps that.
  if (isGithubSource(source) && source.tokenRepository === undefined) {
    source = { ...source, tokenRepository: source.repository };
    changed = true;
  }

  // A key already in use belongs to the repository it was being used for.
  const key = build.sshKey;
  if (key !== null && key !== undefined && key.boundTo === undefined) {
    const bound = git !== null && !git.github && isSshRemote(git.display) ? repositoryKey(git.display) : null;
    build.sshKey = { ...key, boundTo: bound };
    changed = true;
  }

  return changed ? { ...spec, source, build } : null;
}

/**
 * Runs at every boot and does nothing once there is nothing left to do. A trigger token's readable
 * copy is removed here rather than at the next save, so an upgrade takes it out of every row.
 */
export function upgradeDeploymentAuthority(deps: Pick<AppDeps, "db" | "now">): void {
  for (const row of deps.db.select().from(services).all()) {
    const upgraded = upgradeSpec(row.spec as RawSpec);
    if (upgraded !== null) {
      deps.db
        .update(services)
        .set({ spec: upgraded, updatedAt: new Date(deps.now()) })
        .where(and(eq(services.projectName, row.projectName), eq(services.name, row.name)))
        .run();
    }
  }
}
