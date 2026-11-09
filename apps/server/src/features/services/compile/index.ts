import type { SwarmServiceSpec } from "../../../core/docker";
import type { AppServiceSpec } from "../spec";
import { compileDeploy } from "./deploy";
import { type CompiledDomains, compileDomains, type DomainInput } from "./domains";
import { compileEnv } from "./env";
import { compileMiddlewares } from "./middlewares";
import { compileMounts, type MountFile, type MountVolume } from "./mounts";
import { appNetworks, builtImageName, idLabel, qualifiedName } from "./names";
import { compilePorts } from "./ports";
import { compileResources } from "./resources";

const DEFAULT_PORT = 80;

export interface CompileDomain extends DomainInput {
  primary: boolean;
}

export interface CompileInput {
  project: { name: string };
  service: { name: string; spec: AppServiceSpec; id?: string | null };
  /** The unsealed variables of the project and the service. Only a deploy needs them, so only it passes them. */
  env?: { project: string; service: string };
  domains: readonly CompileDomain[];
  dataDir: string;
  /** Raise it to make Swarm replace the tasks even when nothing else changed. */
  forceUpdate: number;
  /** The commit a build came from, exposed to the container as `GIT_SHA`. */
  gitSha?: string | null;
  /** Unsealed values for the `$(secret.x)` and `$(db.x.y)` references of this service's environment. */
  references?: Readonly<Record<string, string>>;
}

export interface ProxyConfig {
  http: Pick<CompiledDomains, "routers" | "services"> & {
    middlewares?: Record<string, unknown>;
    serversTransports?: Record<string, unknown>;
  };
}

export interface CompiledService {
  /** Null while the service has no source: there is nothing to run yet. */
  swarmSpec: SwarmServiceSpec | null;
  proxyConfig: ProxyConfig;
  /** Content that `file` mounts expect on disk. */
  files: MountFile[];
  /** Named volumes that have to exist before the tasks start. */
  volumes?: MountVolume[];
}

/** The configuration of one service as a Swarm spec and Traefik routes. Pure: no I/O. */
export function compileService(input: CompileInput): CompiledService {
  const { project, service, domains } = input;
  const { spec } = service;
  const name = qualifiedName(project.name, service.name);
  const primary = domains.find((domain) => domain.primary);

  const middlewares = compileMiddlewares({
    qualifiedName: name,
    project: project.name,
    service: service.name,
    redirects: spec.redirects,
    basicAuth: spec.basicAuth,
    maintenance: spec.maintenance,
  });
  const compiledDomains = compileDomains({
    qualifiedName: name,
    domains,
    stopped: spec.stopped,
    middlewares,
  });
  const definitions = { ...middlewares.definitions, ...compiledDomains.middlewares };
  const proxyConfig: ProxyConfig = {
    http: {
      routers: compiledDomains.routers,
      services: compiledDomains.services,
      ...(Object.keys(definitions).length > 0 ? { middlewares: definitions } : {}),
      ...(Object.keys(compiledDomains.transports).length > 0
        ? { serversTransports: compiledDomains.transports }
        : {}),
    },
  };

  if (spec.source === null) {
    return { swarmSpec: null, proxyConfig, files: [], volumes: [] };
  }

  const env = compileEnv({
    project: project.name,
    service: service.name,
    projectEnv: input.env?.project ?? "",
    serviceEnv: input.env?.service ?? "",
    primaryHost: primary?.host ?? "",
    port: primary?.port ?? DEFAULT_PORT,
    gitSha: input.gitSha,
    references: input.references,
    interpolate: spec.envInterpolation,
  });
  const mounts = compileMounts({
    mounts: spec.mounts,
    project: project.name,
    service: service.name,
    dataDir: input.dataDir,
    id: service.id,
  });
  const deploy = compileDeploy({
    settings: spec.deploy,
    stopped: spec.stopped,
    forceUpdate: input.forceUpdate,
    publishesPorts: spec.ports.length > 0,
  });

  const swarmSpec: SwarmServiceSpec = {
    Name: name,
    Labels: {
      "opsifier.project": project.name,
      "opsifier.service": service.name,
      "opsifier.type": spec.box === null ? "app" : "box",
      ...idLabel(service.id),
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: spec.source.type === "image" ? spec.source.image : builtImageName(project.name, service.name),
        Env: env,
        ...deploy.container,
        ...(mounts.mounts.length > 0 ? { Mounts: mounts.mounts } : {}),
      },
      Resources: compileResources(spec.resources),
      Placement: mounts.constraints.length > 0 ? { Constraints: mounts.constraints } : {},
      Networks: appNetworks(project.name, service.name),
      ...deploy.task,
    },
    Mode: deploy.Mode,
    UpdateConfig: deploy.UpdateConfig,
    RollbackConfig: deploy.RollbackConfig,
    EndpointSpec: compilePorts(spec.ports),
  };

  return { swarmSpec, proxyConfig, files: mounts.files, volumes: mounts.volumes };
}

export { internalUrl } from "./domains";
export {
  composeChildAddress,
  projectNetworkName,
  projectProxyNetworkName,
  qualifiedName,
  SHARED_NETWORK,
} from "./names";
