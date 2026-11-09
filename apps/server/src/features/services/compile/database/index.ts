import { databaseEngineInfo, deploySettings } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../../core/docker";
import type { AppServiceSpec, StoredDatabase } from "../../spec";
import { compileDeploy } from "../deploy";
import type { CompiledService } from "../index";
import { idLabel, qualifiedName } from "../names";
import { compileResources } from "../resources";
import { compileDatabaseEndpoint } from "./endpoint";
import { engineRuntime } from "./engines";
import { compileDatabaseEnv } from "./env";
import { compileDatabaseHealth } from "./health";
import { compileDatabaseMounts, DATA_NODE_CONSTRAINT } from "./mounts";
import { compileDatabaseNetworks } from "./network";

export { type ConnectionTarget, connectionUrl, enginePort, MASK, maskedConnectionUrl } from "./connection";
export { MYSQL_CONFIG_PATH, supportsConfigFile } from "./engines";
export { managedEnvKeys } from "./env";
export { DATA_NODE_CONSTRAINT } from "./mounts";

/** Plaintext only here, for the few moments a deploy needs it. The compiler keeps none of it. */
export interface DatabaseSecrets {
  password: string;
  rootPassword: string | null;
}

export interface CompileDatabaseInput {
  project: { name: string };
  service: { name: string; spec: AppServiceSpec & { database: StoredDatabase }; id?: string | null };
  /** The unsealed variables of the project and the service. */
  env?: { project: string; service: string };
  secrets: DatabaseSecrets;
  dataDir: string;
  forceUpdate: number;
}

const RESTART_DELAY_NANOS = 5_000_000_000;

/**
 * A database runs exactly one task, always under an init process, and never overlaps with its
 * predecessor. Nothing in the stored spec can ask for anything else.
 */
const databaseDeploySettings = () =>
  deploySettings.parse({ replicas: 1, zeroDowntime: false, tiniInit: true, command: null });

/** One database as a Swarm spec. Pure: no I/O. It adds no routes, and no volume has to exist first. */
export function compileDatabaseService(input: CompileDatabaseInput): CompiledService {
  const { project, service, secrets, forceUpdate } = input;
  const { spec } = service;
  const { database } = spec;
  const name = qualifiedName(project.name, service.name);

  const runtime = engineRuntime[database.engine];
  const env = compileDatabaseEnv({
    engine: database.engine,
    databaseName: database.databaseName,
    user: database.user,
    password: secrets.password,
    rootPassword: secrets.rootPassword,
    projectEnv: input.env?.project ?? "",
    serviceEnv: input.env?.service ?? "",
  });
  const mounts = compileDatabaseMounts({
    engine: database.engine,
    volume: database.volume,
    configFile: database.configFile,
    project: project.name,
    service: service.name,
    dataDir: input.dataDir,
    id: service.id,
  });
  const deploy = compileDeploy({
    settings: databaseDeploySettings(),
    stopped: spec.stopped,
    forceUpdate,
  });
  const startCommand = spec.deploy.command ?? runtime.startCommand;

  const swarmSpec: SwarmServiceSpec = {
    Name: name,
    Labels: {
      "opsifier.project": project.name,
      "opsifier.service": service.name,
      "opsifier.type": database.engine,
      ...idLabel(service.id),
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: requireImage(spec),
        ...(startCommand === null ? {} : { Command: ["/bin/sh", "-c", startCommand] }),
        Env: env,
        ...deploy.container,
        Mounts: mounts.mounts,
        Healthcheck: compileDatabaseHealth(database.engine, {
          user: database.user,
          databaseName: database.databaseName,
        }),
      },
      Resources: compileResources(spec.resources),
      Placement: { Constraints: [DATA_NODE_CONSTRAINT] },
      Networks: compileDatabaseNetworks(project.name, service.name),
      ...deploy.task,
      RestartPolicy: { Condition: "any", Delay: RESTART_DELAY_NANOS, MaxAttempts: 0 },
    },
    Mode: deploy.Mode,
    UpdateConfig: deploy.UpdateConfig,
    RollbackConfig: deploy.RollbackConfig,
    EndpointSpec: compileDatabaseEndpoint(database.engine, database.exposedPort),
  };

  return {
    swarmSpec,
    proxyConfig: { http: { routers: {}, services: {} } },
    files: mounts.files,
    volumes: [],
  };
}

function requireImage(spec: AppServiceSpec): string {
  if (spec.source === null || spec.source.type !== "image") {
    throw new Error("A database always runs a stored image.");
  }
  return spec.source.image;
}

export const databasePort = (engine: StoredDatabase["engine"]): number => databaseEngineInfo[engine].port;
