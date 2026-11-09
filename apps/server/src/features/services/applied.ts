import { createHash } from "node:crypto";
import type { PendingChanges } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { stackEnvPairs } from "../compose/deploy";
import { compileDatabaseRecord, isDatabaseRecord } from "../databases/service";
import { diffEffective } from "../releases/changes";
import { listDomainRows, toCompileDomains } from "../service-tabs/domains/service";
import { resolveReferences } from "../templates/references";
import {
  type CompiledService,
  compileService,
  projectNetworkName,
  projectProxyNetworkName,
  qualifiedName,
} from "./compile";
import { BUILD_SECRET_CONTEXT, openEnv, openEnvironment } from "./env-store";
import { type ServiceRecord, saveApplied } from "./repo";
import { requireProject, type ServiceTarget } from "./service";
import type { AppServiceSpec } from "./spec";

/**
 * Sealed, because it holds what a container really got: `$(secret.x)` references filled in with the
 * values they stand for.
 */
const APPLIED_CONTEXT = "applied-configuration";

type CompileDeps = Pick<AppDeps, "db" | "secrets" | "config">;

/** What a deployment of this record would put in place. */
export function compileDesired(
  deps: CompileDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  forceUpdate: number,
  gitSha: string | null = null,
): CompiledService {
  if (isDatabaseRecord(record)) {
    return compileDatabaseRecord(deps, target, record, forceUpdate, { stopped: false });
  }
  const project = requireProject(deps, target.projectName);
  return compileService({
    project,
    service: { id: record.id, name: target.serviceName, spec: { ...record.spec, stopped: false } },
    env: openEnvironment(deps, project, record.spec),
    domains: toCompileDomains(listDomainRows(deps.db, target)),
    dataDir: deps.config.dataDir,
    forceUpdate,
    gitSha,
    references: resolveReferences(deps, target, record.spec),
  });
}

/** What a build starts from, without the credentials it uses to get there. A secret is known by its fingerprint. */
function buildInputs(deps: Pick<AppDeps, "secrets">, { source, build }: AppServiceSpec): unknown {
  if (source === null || source.type === "image") {
    return null;
  }
  return {
    source: source.type === "github" ? { ...source, webhookId: null } : source,
    config: build.config,
    envFilePath: build.envFilePath,
    envFileInImage: build.envFileInImage,
    inheritsRuntime: build.inheritsRuntime,
    variables: openEnv(deps, build.sealedVariables),
    secrets: Object.entries(build.secrets).map(([name, secret]) => [
      name,
      deps.secrets.fingerprint(deps.secrets.unseal(secret.sealed, BUILD_SECRET_CONTEXT), "build-secret"),
    ]),
  };
}

/**
 * What this record makes of a container, and nothing that differs from one deploy of the same
 * settings to the next: Docker's update counter, and the commit a build happened to come from.
 */
export function effectiveOf(deps: CompileDeps, target: ServiceTarget, record: ServiceRecord): unknown {
  const { compose } = record.spec;
  if (compose !== null) {
    return {
      source: compose.source,
      envFile: compose.envFile,
      env: stackEnvPairs(deps, target, record).pairs,
      networks: [projectNetworkName(target.projectName), projectProxyNetworkName(target.projectName)],
    };
  }
  const compiled = compileDesired(deps, target, record, 0);
  return {
    swarm: compiled.swarmSpec,
    files: compiled.files.map(({ path, content }) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
    build: buildInputs(deps, record.spec),
  };
}

export function recordApplied(
  deps: { db: DbHandle; secrets: AppDeps["secrets"] },
  target: ServiceTarget,
  effective: unknown,
  answering: boolean | null = null,
): void {
  saveApplied(deps.db, target.projectName, target.serviceName, {
    sealed: deps.secrets.seal(JSON.stringify(effective), APPLIED_CONTEXT),
    answering,
  });
}

/** What the applied record says, or undefined when there is none or it can no longer be read. */
export function readApplied(
  deps: Pick<AppDeps, "secrets" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
): unknown {
  if (record.applied === null) {
    return undefined;
  }
  try {
    return JSON.parse(deps.secrets.unseal(record.applied, APPLIED_CONTEXT));
  } catch (error) {
    deps.logger.warn({ err: error, ...target }, "Could not read what is applied to a service");
    return undefined;
  }
}

/** What a deployment fetches anew whatever was saved, since a tag or a branch may have moved. */
function refetchedBy({ spec }: ServiceRecord): PendingChanges["refetches"] {
  if (spec.compose !== null) {
    return "stack";
  }
  if (spec.source === null) {
    return null;
  }
  return spec.source.type === "image" ? "image" : "code";
}

/**
 * What saved settings would change about what is running. A service with no record has never been
 * deployed, or was last deployed before records existed: nothing can be said about either.
 */
export function pendingChangesOf(
  deps: Pick<AppDeps, "db" | "secrets" | "config" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
): PendingChanges {
  const refetches = refetchedBy(record);
  const applied = readApplied(deps, target, record);
  if (applied === undefined) {
    return { known: false, changes: [], refetches };
  }
  try {
    return {
      known: true,
      changes: diffEffective(applied, JSON.parse(JSON.stringify(effectiveOf(deps, target, record)))),
      refetches,
    };
  } catch (error) {
    deps.logger.warn({ err: error, ...target }, "Could not compare saved settings with what is applied");
    return { known: false, changes: [], refetches };
  }
}

export function hasPendingChanges(
  deps: Pick<AppDeps, "db" | "secrets" | "config" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
): boolean {
  return pendingChangesOf(deps, target, record).changes.length > 0;
}

/**
 * The names of the volumes the deployed version mounts, or null when nobody recorded what was
 * deployed. Saved mounts that were never deployed do not exist yet, and mounts removed from the
 * settings are still there until the next deployment.
 */
export function deployedVolumes(
  deps: Pick<AppDeps, "secrets" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
): string[] | null {
  const applied = readApplied(deps, target, record) as
    | {
        swarm?: { TaskTemplate?: { ContainerSpec?: { Mounts?: Array<{ Type?: string; Source?: string }> } } };
      }
    | undefined;
  if (applied === undefined) {
    return null;
  }
  const prefix = `${qualifiedName(target.projectName, target.serviceName)}_`;
  return (applied.swarm?.TaskTemplate?.ContainerSpec?.Mounts ?? []).flatMap((mount) =>
    mount.Type === "volume" && mount.Source?.startsWith(prefix) === true
      ? [mount.Source.slice(prefix.length)]
      : [],
  );
}
