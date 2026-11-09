import type { BuildEnvironment, SaveServiceEnvironment, ServiceEnvironment } from "@opsifier/contract";
import { MAX_BUILD_SECRETS, parseEnvText } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest, conflict, notFound } from "../../../core/errors";
import {
  BUILD_SECRET_CONTEXT,
  envNames,
  openEnv,
  SECRET_VALUE,
  sealEnv,
  sealRetired,
  valuesGone,
} from "../../services/env-store";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { isReservedBuildVariable } from "../source/build/environment";

function audit(
  deps: AppDeps,
  target: ServiceTarget,
  type: string,
  title: string,
  actorEmail: string | undefined,
): void {
  deps.actions.record({
    type,
    title: `${title} ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
}

/** Names only. A page load is not someone asking to see a value. */
export function getEnvironment(deps: AppDeps, target: ServiceTarget): ServiceEnvironment {
  const { spec } = requireService(deps, target);
  return { names: envNames(openEnv(deps, spec.sealedEnv)), interpolation: spec.envInterpolation };
}

/** The values, for the person who asked. Every reveal lands in the activity log. */
export function revealEnvironment(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): { env: string } {
  const env = openEnv(deps, requireService(deps, target).spec.sealedEnv);
  audit(deps, target, "service.env-reveal", "Reveal the environment of", actorEmail);
  return { env };
}

/** Whatever a save replaces stays hidden from output: a running container still has the old value. */
export function saveEnvironment(
  deps: AppDeps,
  target: ServiceTarget,
  changes: SaveServiceEnvironment,
  actorEmail: string | undefined,
): ServiceEnvironment {
  const { spec } = requireService(deps, target);
  const before = openEnv(deps, spec.sealedEnv);
  const env = changes.env ?? before;
  const envInterpolation = changes.interpolation ?? spec.envInterpolation;
  const gone = valuesGone(parseEnvText(before), parseEnvText(env));
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...spec,
      sealedEnv: changes.env === undefined ? spec.sealedEnv : sealEnv(deps, env),
      sealedRetired: sealRetired(deps, spec.sealedRetired, gone),
      envInterpolation,
    },
    new Date(deps.now()),
  );
  audit(deps, target, "service.env", "Update the environment of", actorEmail);
  return { names: envNames(env), interpolation: envInterpolation };
}

const isBuildable = (record: ServiceRecord): boolean =>
  record.spec.source !== null && record.spec.source.type !== "image";

/** A build's inputs only mean something for a service that is built. */
function requireBuildable(deps: AppDeps, target: ServiceTarget): ServiceRecord {
  const record = requireService(deps, target);
  if (!isBuildable(record)) {
    throw badRequest("source_not_buildable", "This service is not built from a source.");
  }
  return record;
}

function toBuildEnvironment(deps: AppDeps, record: ServiceRecord): BuildEnvironment {
  const { build } = record.spec;
  return {
    variables: envNames(openEnv(deps, build.sealedVariables)),
    secrets: Object.entries(build.secrets)
      .map(([name, secret]) => ({ name, updatedAt: secret.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    inheritsRuntime: build.inheritsRuntime,
  };
}

export function getBuildEnvironment(deps: AppDeps, target: ServiceTarget): BuildEnvironment {
  return toBuildEnvironment(deps, requireService(deps, target));
}

export function revealBuildVariables(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): { env: string } {
  const env = openEnv(deps, requireBuildable(deps, target).spec.build.sealedVariables);
  audit(deps, target, "service.env-reveal", "Reveal the build variables of", actorEmail);
  return { env };
}

function refuseName(field: string, message: string): never {
  throw badRequest("validation_failed", "Some fields need attention.", { [field]: message });
}

/** Names that steer the build tools can't be overridden from here. */
function assertNotReserved(names: readonly string[], field: string): void {
  const reserved = names.find(isReservedBuildVariable);
  if (reserved !== undefined) {
    refuseName(field, `${reserved} steers the build tools and can't be set here`);
  }
}

export function saveBuildVariables(
  deps: AppDeps,
  target: ServiceTarget,
  env: string,
  actorEmail: string | undefined,
): BuildEnvironment {
  const record = requireBuildable(deps, target);
  const { build } = record.spec;
  assertNotReserved(envNames(env), "env");
  const held = envNames(env).find((name) => build.secrets[name] !== undefined);
  if (held !== undefined) {
    refuseName("env", `${held} is already a build secret`);
  }
  const gone = valuesGone(parseEnvText(openEnv(deps, build.sealedVariables)), parseEnvText(env));
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      build: { ...build, sealedVariables: sealEnv(deps, env) },
      sealedRetired: sealRetired(deps, record.spec.sealedRetired, gone),
    },
    new Date(deps.now()),
  );
  audit(deps, target, "service.env", "Update the build variables of", actorEmail);
  return toBuildEnvironment(deps, requireService(deps, target));
}

const openBuildSecret = (deps: AppDeps, sealed: string): string =>
  deps.secrets.unseal(sealed, BUILD_SECRET_CONTEXT);

export function saveBuildSecret(
  deps: AppDeps,
  target: ServiceTarget,
  name: string,
  value: string,
  actorEmail: string | undefined,
): BuildEnvironment {
  const record = requireBuildable(deps, target);
  const { build } = record.spec;
  assertNotReserved([name], "name");
  if (envNames(openEnv(deps, build.sealedVariables)).includes(name)) {
    refuseName("name", `${name} is already a build variable`);
  }
  const previous = build.secrets[name];
  if (previous === undefined && Object.keys(build.secrets).length >= MAX_BUILD_SECRETS) {
    throw conflict("too_many_build_secrets", "This service holds as many build secrets as it can.");
  }
  const now = new Date(deps.now());
  const gone =
    previous === undefined ? [] : [{ name: SECRET_VALUE, value: openBuildSecret(deps, previous.sealed) }];
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      build: {
        ...build,
        secrets: {
          ...build.secrets,
          [name]: { sealed: deps.secrets.seal(value, BUILD_SECRET_CONTEXT), updatedAt: now.toISOString() },
        },
      },
      sealedRetired: sealRetired(deps, record.spec.sealedRetired, gone, [value]),
    },
    now,
  );
  audit(deps, target, "service.env", `Set the build secret ${name} of`, actorEmail);
  return toBuildEnvironment(deps, requireService(deps, target));
}

export function deleteBuildSecret(
  deps: AppDeps,
  target: ServiceTarget,
  name: string,
  actorEmail: string | undefined,
): BuildEnvironment {
  const record = requireBuildable(deps, target);
  const { build } = record.spec;
  const secret = build.secrets[name];
  if (secret === undefined) {
    throw notFound("This service has no such build secret.");
  }
  const { [name]: _removed, ...secrets } = build.secrets;
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      build: { ...build, secrets },
      sealedRetired: sealRetired(deps, record.spec.sealedRetired, [
        { name: SECRET_VALUE, value: openBuildSecret(deps, secret.sealed) },
      ]),
    },
    new Date(deps.now()),
  );
  audit(deps, target, "service.env", `Remove the build secret ${name} of`, actorEmail);
  return toBuildEnvironment(deps, requireService(deps, target));
}

/** One way only: after this the service's builds get what is listed for them and nothing else. */
export function stopInheritingRuntime(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): BuildEnvironment {
  const record = requireBuildable(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, build: { ...record.spec.build, inheritsRuntime: false } },
    new Date(deps.now()),
  );
  audit(deps, target, "service.env", "Stop passing runtime variables to the builds of", actorEmail);
  return toBuildEnvironment(deps, requireService(deps, target));
}
