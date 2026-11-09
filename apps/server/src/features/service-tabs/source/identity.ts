import type { AppServiceSpec } from "../../services/spec";

/** `user@host:path`, where the first colon separates the host from the path. */
const SCP_REMOTE = /^[^@/]+@([^:/]+):(.+)$/;

/** A repository's host, port and path, however its address was written. */
function repositoryParts(remote: string): { host: string; port: number | null; path: string } {
  const scp = SCP_REMOTE.exec(remote);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return { host: scp[1].toLowerCase(), port: null, path: scp[2] };
  }
  const url = new URL(remote);
  const port = url.port === "" || (url.protocol === "ssh:" && url.port === "22") ? null : Number(url.port);
  return { host: url.hostname.toLowerCase(), port, path: url.pathname };
}

/**
 * The name of a repository for comparing two addresses: host, port and path without `.git`, whichever
 * way the address is written. Case is ignored, as Git hosts do when they look a repository up.
 */
export function repositoryKey(remote: string): string {
  const { host, port, path } = repositoryParts(remote);
  const name = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  return `${host}${port === null ? "" : `:${port}`}/${name}`;
}

/** {@link repositoryKey} of an address that came from outside. Something unreadable names nothing. */
export function tryRepositoryKey(remote: unknown): string | null {
  if (typeof remote !== "string" || remote === "") {
    return null;
  }
  try {
    return repositoryKey(remote);
  } catch {
    return null;
  }
}

/** The host and port `ssh` connects to for an address. */
export function sshHostOf(remote: string): { host: string; port: number } {
  const { host, port } = repositoryParts(remote);
  return { host, port: port ?? 22 };
}

export const githubRepositoryKey = (repository: string): string => `github.com/${repository.toLowerCase()}`;

/** The Git repository a service deploys from: an App's GitHub or Git source, or a stack's Git file. */
export interface GitIdentity {
  /** The address written the way it was saved, for showing. */
  display: string;
  /** {@link repositoryKey} of it, for comparing. */
  repository: string;
  ref: string;
  github: boolean;
}

/** Null when the service builds from no repository at all. */
export function gitSourceOf(spec: Pick<AppServiceSpec, "source" | "compose">): GitIdentity | null {
  const stack = spec.compose?.source;
  if (stack?.type === "git") {
    return { display: stack.url, repository: repositoryKey(stack.url), ref: stack.ref, github: false };
  }
  const { source } = spec;
  if (source?.type === "github") {
    return {
      display: source.repository,
      repository: githubRepositoryKey(source.repository),
      ref: source.ref,
      github: true,
    };
  }
  if (source?.type === "git") {
    return { display: source.url, repository: repositoryKey(source.url), ref: source.ref, github: false };
  }
  return null;
}

/** An image's registry and repository: everything but its tag or digest. */
export function imageRepositoryOf(image: string): string {
  const reference = image.split("@")[0] ?? image;
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  const name = colon > slash ? reference.slice(0, colon) : reference;
  const [first = "", ...rest] = name.split("/");
  const hasRegistry =
    rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  const named = (hasRegistry ? first : "docker.io").toLowerCase();
  const registry = named === "index.docker.io" || named === "registry-1.docker.io" ? "docker.io" : named;
  const path = (hasRegistry ? rest : [first, ...rest]).join("/");
  return `${registry}/${registry === "docker.io" && !path.includes("/") ? `library/${path}` : path}`;
}

/**
 * What a service is built from, for deciding when a trigger or webhook issued for it stops applying.
 * A tag is not part of it, for an image: a new tag is the same thing at another version.
 * Null only while no source has been saved.
 */
export function sourceIdentity(spec: Pick<AppServiceSpec, "source" | "compose">): string | null {
  const git = gitSourceOf(spec);
  if (git !== null) {
    return `git:${git.repository}#${git.ref}`;
  }
  if (spec.compose !== null && spec.compose !== undefined) {
    return spec.compose.source === null ? null : `compose:${spec.compose.source.type}`;
  }
  const { source } = spec;
  if (source === null) {
    return null;
  }
  return source.type === "image" ? `image:${imageRepositoryOf(source.image)}` : source.type;
}
