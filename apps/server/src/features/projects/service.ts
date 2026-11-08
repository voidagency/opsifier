import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CreateProjectRequest,
  ProjectList,
  ProjectSchemaDocument,
  ProjectSummary,
} from "@opsifier/contract";
import type { ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { conflict } from "../../core/errors";
import { listDomainRows } from "../service-tabs/domains/service";
import { toPublicSource } from "../service-tabs/source/public";
import { removeServiceEverywhere } from "../services/lifecycle";
import { listServiceRecords } from "../services/repo";
import { dockerFailure, requireProject } from "../services/service";
import { indexActiveActions, type LiveState, readLiveState, summarize } from "../services/status";
import { ensureProjectNetwork, joinProxyToNetwork, removeProjectNetwork } from "./network";
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

  try {
    const network = await ensureProjectNetwork(deps.docker, request.name);
    await joinProxyToNetwork(deps.docker, network, (line) => deps.logger.info(line)).catch(
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

export function getProjectEnv(deps: AppDeps, name: string): { env: string } {
  return { env: requireProject(deps, name).env };
}

export function saveProjectEnv(
  deps: AppDeps,
  name: string,
  env: string,
  actorEmail: string | undefined,
): { env: string } {
  requireProject(deps, name);
  updateProjectEnv(deps.db, name, env, new Date(deps.now()));
  deps.actions.record({
    type: "project.env",
    title: `Update the environment of ${name}`,
    projectName: name,
    actorEmail,
  });
  return { env };
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

export function enqueueProjectDestroy(
  deps: AppDeps,
  name: string,
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  requireProject(deps, name);
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
      for (const record of listServiceRecords(deps.db, name)) {
        await removeServiceEverywhere(deps, { projectName: name, serviceName: record.name }, ctx.log);
      }
      ctx.log(`Removing the network of ${name}`);
      await removeProjectNetwork(deps, name, ctx.log, ctx.signal);
      deleteProject(deps.db, name);
      await rm(join(deps.config.dataDir, "projects", name), { recursive: true, force: true });
      ctx.log("Destroyed");
    },
  });
}

function indexActiveActionsFor(deps: AppDeps, project: string): boolean {
  return [...indexActiveActions(deps).keys()].some((key) => key.startsWith(`${project}/`));
}
