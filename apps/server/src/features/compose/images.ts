/**
 * Every image on the server lives in one store, which the panel, its helpers, its builders and every
 * project draw from by name. A stack that builds an image names it, so a build may only use names that
 * nothing else on the server can be looking for, and a stack may only run what a registry or its own
 * project put there.
 */

/** An image reference without its tag or digest. Registry hosts may carry a port, tags never a slash. */
export function imageRepository(ref: string): string {
  const withoutDigest = ref.split("@", 1)[0] ?? ref;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/**
 * Whether a stack's build may give its image this name: the stack's own, which starts with its Compose
 * project as Compose's own default does. Project names have no underscore, so no other project's stack
 * can start with the same words.
 */
export function isStackImageName(ref: string, stack: string): boolean {
  const repository = imageRepository(ref);
  return (
    repository === stack ||
    [`${stack}-`, `${stack}_`, `${stack}/`].some((prefix) => repository.startsWith(prefix))
  );
}

/**
 * Whether a reference names an image the panel built or kept for a service of another project. Those
 * exist only on this server, under `opsifier/`, and hold that project's code.
 */
export function isAnotherProjectsImage(ref: string, project: string): boolean {
  const repository = imageRepository(ref).replace(/^(?:docker\.io|index\.docker\.io)\//, "");
  return repository.startsWith("opsifier/") && !repository.startsWith(`opsifier/${project}/`);
}

/** The image a BuildKit context names, when it is one. */
export const contextImage = (context: string): string | null =>
  context.startsWith("docker-image://") ? context.slice("docker-image://".length) : null;
