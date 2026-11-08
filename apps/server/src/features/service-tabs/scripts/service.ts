import { MAX_SCRIPTS, type ScriptSpec } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest, conflict, notFound } from "../../../core/errors";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";

function assertNameFree(scripts: readonly ScriptSpec[], name: string, except?: number): void {
  const taken = scripts.some(
    (script, index) => index !== except && script.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw conflict("script_name_taken", "A script with this name already exists.", {
      name: "This name is already used",
    });
  }
}

function save(deps: AppDeps, target: ServiceTarget, scripts: ScriptSpec[]): ScriptSpec[] {
  const record = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, scripts },
    new Date(deps.now()),
  );
  return scripts;
}

export const listScripts = (deps: AppDeps, target: ServiceTarget): ScriptSpec[] =>
  requireService(deps, target).spec.scripts;

export function addScript(deps: AppDeps, target: ServiceTarget, script: ScriptSpec): ScriptSpec[] {
  const { scripts } = requireService(deps, target).spec;
  if (scripts.length >= MAX_SCRIPTS) {
    throw badRequest("too_many_scripts", "This service has as many scripts as it can hold.");
  }
  assertNameFree(scripts, script.name);
  return save(deps, target, [...scripts, script]);
}

export function updateScript(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  script: ScriptSpec,
): ScriptSpec[] {
  const { scripts } = requireService(deps, target).spec;
  if (index >= scripts.length) {
    throw notFound("This script does not exist.");
  }
  assertNameFree(scripts, script.name, index);
  return save(
    deps,
    target,
    scripts.map((existing, position) => (position === index ? script : existing)),
  );
}

export function removeScript(deps: AppDeps, target: ServiceTarget, index: number): ScriptSpec[] {
  const { scripts } = requireService(deps, target).spec;
  if (index >= scripts.length) {
    throw notFound("This script does not exist.");
  }
  return save(
    deps,
    target,
    scripts.filter((_, position) => position !== index),
  );
}
