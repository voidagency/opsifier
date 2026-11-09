import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreateProjectRequest,
  type EnvSummary,
  MAX_PROJECTS,
  type ProjectList,
  type ProjectSchemaDocument,
  type ProjectSummary,
  parseEnvText,
} from "@opsifier/contract";
import type { ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { conflict } from "../../core/errors";
import { listDomainRows } from "../service-tabs/domains/service";
import { toPublicSource } from "../service-tabs/source/public";
import { envNames, openEnv, sealEnv, sealRetired, valuesGone } from "../services/env-store";
import { listServiceRecords } from "../services/repo";
import { dockerFailure, requireProject } from "../services/service";
import { indexActiveActions, type LiveState, readLiveState, summarize } from "../services/status";
import {
  ensureProjectNetwork,
  ensureProxyNetwork,
  joinProxyToNetworks,
  removeProjectNetwork,
} from "./network";
import {
  deleteProject,
  findProject,
  insertProject,
  listProjects,
  type ProjectRow,
  updateProjectEnv,
} from "./repo";

function toSummary(deps: AppDeps, project: ProjectRow, live: LiveState): ProjectSummary {
  const active = indexActiveActions(deps);
  return {
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    services: listServiceRecords(deps.db, project.name).map((record) =>
      summarize(deps, record, live, active),
    ),
  };
}

export async function listProjectSummaries(deps: AppDeps): Promise<ProjectList> {
  const live = await readLiveState(deps);
  return { projects: listProjects(deps.db).map((project) => toSummary(deps, project, live)) };
}

export async function getProjectSummary(deps: AppDeps, name: string): Promise<ProjectSummary> {
  const project = requireProject(deps, name);
  return toSummary(deps, project, await readLiveState(deps));
}

const nameTaken = () =>
  conflict("project_exists", "A project with this name already exists.", { name: "This name is taken" });

/** Two requests can pass the existence check together. Only one can win the insert. */
function isConstraintViolation(error: unknown): boolean {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  return (code ?? cause?.code ?? "").startsWith("SQLITE_CONSTRAINT");
}

/** Creates the network first, so a Docker failure leaves no project behind. */
export async function createProject(
  deps: AppDeps,
  request: CreateProjectRequest,
  actorEmail: string | undefined,
): Promise<ProjectSummary> {
  if (findProject(deps.db, request.name) !== undefined) {
    throw nameTaken();
  }
  if (listProjects(deps.db).length >= MAX_PROJECTS) {
    throw conflict("too_many_projects", "This server holds as many projects as it can.");
  }

  try {
    await ensureProjectNetwork(deps.docker, request.name);
    const proxyNetwork = await ensureProxyNetwork(deps.docker, request.name);
    await joinProxyToNetworks(deps.docker, [proxyNetwork], (line) => deps.logger.info(line)).catch(
      (error: unknown) => {
        // The next deploy tries again. A proxy hiccup should not stand in the way of a project.
        deps.logger.warn(
          { err: error, project: request.name },
          "Could not connect the proxy to the new network",
        );
      },
    );
  } catch (error) {
    throw error instanceof DockerDriverError ? dockerFailure(error) : error;
  }

  let project: ProjectRow;
  try {
    project = insertProject(deps.db, request.name, new Date(deps.now()));
  } catch (error) {
    if (isConstraintViolation(error)) {
      throw nameTaken();
    }
    throw error;
  }
  deps.actions.record({
    type: "project.create",
    title: `Create project ${request.name}`,
    projectName: request.name,
    actorEmail,
  });
  return toSummary(deps, project, await readLiveState(deps));
}

/** Names only. A page load is not someone asking to see a value. */
export function getProjectEnv(deps: AppDeps, name: string): EnvSummary {
  return { names: envNames(openEnv(deps, requireProject(deps, name).sealedEnv)) };
}

/** The values, for the person who asked. Every reveal lands in the activity log. */
export function revealProjectEnv(
  deps: AppDeps,
  name: string,
  actorEmail: string | undefined,
): { env: string } {
  const env = openEnv(deps, requireProject(deps, name).sealedEnv);
  deps.actions.record({
    type: "project.env-reveal",
    title: `Reveal the environment of ${name}`,
    projectName: name,
    actorEmail,
  });
  return { env };
}

/** Whatever a save replaces stays hidden from output: a running container still has the old value. */
export function saveProjectEnv(
  deps: AppDeps,
  name: string,
  env: string,
  actorEmail: string | undefined,
): EnvSummary {
  const project = requireProject(deps, name);
  const gone = valuesGone(parseEnvText(openEnv(deps, project.sealedEnv)), parseEnvText(env));
  updateProjectEnv(
    deps.db,
    name,
    sealEnv(deps, env),
    sealRetired(deps, project.sealedRetired, gone),
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "project.env",
    title: `Update the environment of ${name}`,
    projectName: name,
    actorEmail,
  });
  return { names: envNames(env) };
}

/** Domains and settings, as a portable document. Credentials are never part of it. */
export function exportProjectSchema(deps: AppDeps, name: string): ProjectSchemaDocument {
  requireProject(deps, name);
  return {
    services: listServiceRecords(deps.db, name).map((record) => ({
      type: record.type,
      data: {
        projectName: name,
        serviceName: record.name,
        source:
          record.spec.source?.type === "image"
            ? {
                type: "image" as const,
                image: record.spec.source.image,
                username: record.spec.source.username,
              }
            : record.spec.source === null
              ? null
              : toPublicSource(record.spec.source),
        deploy: {
          command: record.spec.deploy.command,
          replicas: record.spec.deploy.replicas,
          zeroDowntime: record.spec.deploy.zeroDowntime,
        },
        domains: listDomainRows(deps.db, { projectName: name, serviceName: record.name }).map((domain) => ({
          host: domain.host,
          https: domain.https,
          path: domain.path,
          port: domain.port,
          internalProtocol: "http",
          middlewares: [],
          certificateResolver: "",
          wildcard: false,
        })),
      },
    })),
  };
}

/** A project holding anything is refused, so that deleting one can never take a service with it. */
function assertEmpty(deps: Pick<AppDeps, "db">, name: string): void {
  const held = listServiceRecords(deps.db, name).length;
  if (held > 0) {
    throw conflict(
      "project_not_empty",
      `This project still holds ${held} service${held === 1 ? "" : "s"}. Delete ${held === 1 ? "it" : "them"} first.`,
    );
  }
}

export function enqueueProjectDestroy(
  deps: AppDeps,
  name: string,
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  requireProject(deps, name);
  assertEmpty(deps, name);
  if (confirm !== name) {
    throw conflict("confirmation_mismatch", "Type the project's exact name to confirm.", {
      confirm: "Does not match the project's name",
    });
  }
  const busy = indexActiveActionsFor(deps, name);
  if (busy) {
    throw conflict("project_busy", "Work is still running in this project. Wait for it to finish.");
  }

  return deps.actions.enqueue({
    type: "project.destroy",
    title: `Destroy project ${name}`,
    projectName: name,
    actorEmail,
    run: async (ctx) => {
      assertEmpty(deps, name);
      ctx.log(`Removing the network of ${name}`);
      await removeProjectNetwork(deps, name, ctx.log, ctx.signal);
      // Nothing awaits between this check and the delete, so a service created meanwhile can't go with it.
      assertEmpty(deps, name);
      deleteProject(deps.db, name);
      // Only an empty folder can go, so the kept volumes of its former services stay where they are.
      await rmdir(join(deps.config.dataDir, "projects", name)).catch(() => undefined);
      ctx.log("Destroyed");
    },
  });
}

function indexActiveActionsFor(deps: AppDeps, project: string): boolean {
  return [...indexActiveActions(deps).keys()].some((key) => key.startsWith(`${project}/`));
}
