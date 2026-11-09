import { parseEnvText } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { Redactor } from "../../core/tools";
import { unsealSecrets } from "../databases/service";
import { COMPANION_TOKEN_CONTEXT } from "../databases/spec";
import { getGithubToken } from "../github/service";
import { findProject, type ProjectRow } from "../projects/repo";
import { SSH_KEY_CONTEXT, WEBHOOK_SECRET_CONTEXT } from "../service-tabs/source/stored";
import { resolveReferences } from "../templates/references";
import { resolveEnvPairs } from "./compile/env";
import { BUILD_SECRET_CONTEXT, openEnv, openRetired } from "./env-store";
import { findService, type ServiceRecord } from "./repo";
import type { ServiceTarget } from "./service";
import { REGISTRY_PASSWORD_CONTEXT } from "./spec";

type MaskingDeps = Pick<AppDeps, "db" | "secrets" | "logger">;

/** What the panel itself gives a container, and a log may print all it likes. */
const PANEL_SET = new Set(["PORT", "GIT_SHA"]);

/** A value that can't be read can't be hidden, and that must not cost the output it was to be hidden from. */
function attempt(deps: Pick<AppDeps, "logger">, read: () => void): void {
  try {
    read();
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not read a value to hide from output");
  }
}

function addRetired(deps: MaskingDeps, redact: Redactor, sealed: string | null): void {
  attempt(deps, () => {
    for (const { name, value } of openRetired(deps, sealed)) {
      redact.addVariable(name, value);
    }
  });
}

function addProject(deps: MaskingDeps, redact: Redactor, project: ProjectRow): void {
  attempt(deps, () => {
    for (const { key, value } of parseEnvText(openEnv(deps, project.sealedEnv))) {
      redact.addVariable(key, value);
    }
  });
  addRetired(deps, redact, project.sealedRetired);
}

function addDatabase(deps: MaskingDeps, redact: Redactor, record: ServiceRecord): void {
  const { database } = record.spec;
  if (database === null) {
    return;
  }
  const credentials = [
    database,
    ...(database.rotation === null ? [] : [database.rotation.from, database.rotation.to]),
  ];
  for (const sealed of credentials) {
    attempt(deps, () => {
      const { password, rootPassword } = unsealSecrets(deps, sealed);
      redact.addSecret(password);
      if (rootPassword !== null) {
        redact.addSecret(rootPassword);
      }
    });
  }
  for (const companion of Object.values(database.companions)) {
    attempt(deps, () => {
      redact.addSecret(deps.secrets.unseal(companion.sealedToken, COMPANION_TOKEN_CONTEXT));
    });
  }
}

/** What the service was given, through a variable or a sealed reference, and what it used to hold. */
function addEnvironment(
  deps: MaskingDeps,
  redact: Redactor,
  target: ServiceTarget,
  record: ServiceRecord,
  projectEnv: string,
): void {
  const { spec } = record;
  attempt(deps, () => {
    const references = resolveReferences(deps, target, spec);
    for (const value of Object.values(references)) {
      redact.addSecret(value);
    }
    for (const { key, value } of resolveEnvPairs({
      project: target.projectName,
      service: target.serviceName,
      primaryHost: "",
      projectEnv,
      serviceEnv: openEnv(deps, spec.sealedEnv),
      references,
      interpolate: spec.envInterpolation,
    })) {
      redact.addVariable(key, value);
    }
  });
  attempt(deps, () => {
    for (const { key, value } of parseEnvText(openEnv(deps, spec.sealedEnv))) {
      redact.addVariable(key, value);
    }
  });
  addRetired(deps, redact, spec.sealedRetired);
  for (const reference of Object.values(spec.references.databases)) {
    const database = findService(deps.db, target.projectName, reference.service);
    if (database !== undefined) {
      addDatabase(deps, redact, database);
      addRetired(deps, redact, database.spec.sealedRetired);
    }
  }
}

function addBuild(deps: MaskingDeps, redact: Redactor, record: ServiceRecord): void {
  const { source, build } = record.spec;
  attempt(deps, () => {
    for (const { key, value } of parseEnvText(openEnv(deps, build.sealedVariables))) {
      redact.addVariable(key, value);
    }
  });
  for (const secret of Object.values(build.secrets)) {
    attempt(deps, () => {
      redact.addSecret(deps.secrets.unseal(secret.sealed, BUILD_SECRET_CONTEXT));
    });
  }
  if (build.sshKey !== null) {
    const { sealedPrivateKey } = build.sshKey;
    attempt(deps, () => {
      redact.addSecret(deps.secrets.unseal(sealedPrivateKey, SSH_KEY_CONTEXT));
    });
  }
  if (build.webhook?.sealedSecret != null) {
    const { sealedSecret } = build.webhook;
    attempt(deps, () => {
      redact.addSecret(deps.secrets.unseal(sealedSecret, WEBHOOK_SECRET_CONTEXT));
    });
  }
  if (source?.type === "image" && source.sealedPassword !== null) {
    const { sealedPassword } = source;
    attempt(deps, () => {
      redact.addSecret(deps.secrets.unseal(sealedPassword, REGISTRY_PASSWORD_CONTEXT));
    });
  }
  if (source?.type === "github") {
    attempt(deps, () => {
      const token = getGithubToken(deps);
      if (token !== null) {
        redact.addToken(token);
      }
    });
  }
}

/**
 * Everything this service's output could give away: what it is configured with now, what the container
 * that is running holds (`applied`, as Docker reports it), and what it has held before. Nothing here is
 * kept: it is rebuilt from the sealed values every time.
 */
export function serviceRedactor(
  deps: MaskingDeps,
  target: ServiceTarget,
  applied: readonly string[] = [],
): Redactor {
  const redact = new Redactor();
  const project = findProject(deps.db, target.projectName);
  if (project !== undefined) {
    addProject(deps, redact, project);
  }
  const record = findService(deps.db, target.projectName, target.serviceName);
  if (record !== undefined) {
    let projectEnv = "";
    attempt(deps, () => {
      projectEnv = project === undefined ? "" : openEnv(deps, project.sealedEnv);
    });
    addEnvironment(deps, redact, target, record, projectEnv);
    addBuild(deps, redact, record);
    addDatabase(deps, redact, record);
  }
  for (const entry of applied) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (separator !== -1 && !PANEL_SET.has(name)) {
      redact.addVariable(name, entry.slice(separator + 1));
    }
  }
  return redact;
}

/** For an Action or its log: as much as is known about where it ran. */
export function actionRedactor(
  deps: MaskingDeps,
  scope: { projectName: string | null; serviceName: string | null },
): Redactor {
  if (scope.projectName === null) {
    return new Redactor();
  }
  if (scope.serviceName === null) {
    const redact = new Redactor();
    const project = findProject(deps.db, scope.projectName);
    if (project !== undefined) {
      addProject(deps, redact, project);
    }
    return redact;
  }
  return serviceRedactor(deps, { projectName: scope.projectName, serviceName: scope.serviceName });
}
