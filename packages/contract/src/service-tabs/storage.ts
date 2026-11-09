import { z } from "zod";
import { resourceName, wholeNumber } from "../common";
import { servicePath } from "../services";

const MAX_PATH_CHARS = 4096;
/** Below the API's body limit, so the content of a large file still fits in one request. */
const MAX_FILE_CHARS = 900 * 1024;
export const MAX_MOUNTS = 64;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** `/a/b` and nothing that spells the same place differently: no `.`, `..`, `//` or trailing slash. */
export function isCleanAbsolutePath(path: string): boolean {
  if (!path.startsWith("/") || hasControlCharacter(path)) {
    return false;
  }
  return (
    path === "/" ||
    path
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** The kernel's own filesystems. Docker refuses to cover them, so the mistake is caught at save time. */
const isContainerMountable = (path: string): boolean =>
  !["/", "/proc", "/sys", "/dev"].includes(path) && !path.startsWith("/proc/") && !path.startsWith("/sys/");

const cleanAbsolutePath = z
  .string()
  .min(1, "Required")
  .max(MAX_PATH_CHARS, "This is too long")
  .refine(isCleanAbsolutePath, "Use an absolute path such as /data, with no . or .. in it");

const containerPath = cleanAbsolutePath.refine(isContainerMountable, "Docker can't mount over this path");

export const bindMountSpec = z.object({
  type: z.literal("bind"),
  hostPath: cleanAbsolutePath,
  mountPath: containerPath,
  /**
   * Set once a person has confirmed that this mount exposes the panel's data directory or the Docker
   * socket, which hands the container control of the server.
   */
  acknowledgeRisk: z.boolean().default(false),
});

export const volumeMountSpec = z.object({
  type: z.literal("volume"),
  name: resourceName,
  mountPath: containerPath,
});

export const fileMountSpec = z.object({
  type: z.literal("file"),
  mountPath: containerPath,
  content: z.string().max(MAX_FILE_CHARS, "This is too long").default(""),
});

/** A host directory, a named Docker volume, or a file whose content the panel keeps. */
export const mountSpec = z.discriminatedUnion("type", [bindMountSpec, volumeMountSpec, fileMountSpec]);
export type MountSpec = z.infer<typeof mountSpec>;

/** One mount of a service, by its position in the list. */
export const mountItemPath = servicePath.extend({ index: wholeNumber(0, 999) });

/** What a bind mount would expose. Null when it is an ordinary host path. */
export const mountRisk = z.enum(["docker-socket", "data-directory"]);
export type MountRisk = z.infer<typeof mountRisk>;

export const mountEntry = z.discriminatedUnion("type", [
  bindMountSpec.extend({ risk: mountRisk.nullable() }),
  volumeMountSpec,
  fileMountSpec,
]);
export type MountEntry = z.infer<typeof mountEntry>;

/** GET /api/v1/projects/{project}/services/{service}/storage, and the answer to every change. */
export const storageDocument = z.object({ mounts: z.array(mountEntry) });
export type StorageDocument = z.infer<typeof storageDocument>;
