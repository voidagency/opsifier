import { join } from "node:path";
import { COMPOSE_DEFAULT_FILE } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { qualifiedName } from "../services/compile";
import { type ServiceTarget, serviceDir } from "../services/service";

/** The Compose project of a stack. Its own identifier, so stacks cannot reach each other's containers. */
export const composeProject = (target: ServiceTarget): string =>
  qualifiedName(target.projectName, target.serviceName);

/** The directory that holds the stack's files, and anything the stack writes through relative mounts. */
export const composeCodeDir = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "code");

/** Beside the code, so a repository's own files can never collide with it. */
export const composeOverrideFile = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "docker-compose.override.yml");

/** The files the last Git checkout put in `code/`, so a stack's own files outlive a deploy. */
export const composeManifestFile = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "compose-manifest.json");

/** Where the inline file is written, relative to the stack's directory. */
export const COMPOSE_INLINE_FILE = COMPOSE_DEFAULT_FILE;
