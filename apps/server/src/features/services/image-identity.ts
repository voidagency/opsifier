import type { AppDeps } from "../../core/context";
import { OCI_REVISION_LABEL } from "../service-tabs/source/build/builders";

/** What an image really is, once it has been fetched or built. */
export interface ImageIdentity {
  /** The name it was asked for under. */
  ref: string;
  /** `sha256:...`: exactly this image, on this server. */
  id: string;
  /** `repository@sha256:...` when it came from a registry: exactly this image, anywhere. */
  digest: string | null;
  /** The commit the image's own label names. */
  revision: string | null;
  sizeBytes: number;
}

/** What a digest in `RepoDigests` is listed under: Docker Hub's short form, no tag, no digest. */
function repositoryOf(reference: string): string {
  const name = reference.split("@", 1)[0] as string;
  const colon = name.lastIndexOf(":");
  const repository = colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
  return repository.replace(/^(?:docker\.io|index\.docker\.io)\//, "").replace(/^library\//, "");
}

/**
 * Reads what a name means right now. Called once, after the pull or the build and before anything
 * is replaced: from here on the deployment deals in this answer, whatever happens to the name. Only
 * a pulled image has a digest that means anything: Docker's containerd store makes one up for a local
 * build too, under a name no registry has ever heard of.
 */
export async function resolveImage(
  deps: Pick<AppDeps, "docker">,
  ref: string,
  { fromRegistry }: { fromRegistry: boolean },
): Promise<ImageIdentity> {
  const image = await deps.docker.inspectImage(ref);
  if (image === null) {
    throw new Error(
      `Docker does not have ${ref}, right after fetching or building it. Nothing was replaced.`,
    );
  }
  const repository = repositoryOf(ref);
  return {
    ref,
    id: image.id,
    digest: fromRegistry
      ? (image.digests.find((digest) => repositoryOf(digest) === repository) ?? null)
      : null,
    revision: image.labels[OCI_REVISION_LABEL] ?? null,
    sizeBytes: image.sizeBytes,
  };
}

/**
 * The name Swarm is given. A digest also reaches other nodes, an id only ever means this server, and
 * a reference that already carries a digest is pinned as it stands.
 */
export const pinnedReference = (identity: ImageIdentity): string =>
  identity.ref.includes("@") ? identity.ref : (identity.digest ?? identity.id);
