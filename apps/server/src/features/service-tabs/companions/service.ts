import { randomInt } from "node:crypto";
import { isIP } from "node:net";
import {
  type CompanionState,
  type CompanionTool,
  companionsByEngine,
  databaseActionTypes,
} from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../../core/actions";
import type { AppDeps } from "../../../core/context";
import { waitForRollout } from "../../../core/docker";
import { badRequest, conflict, notFound } from "../../../core/errors";
import {
  type DatabaseRecord,
  isDatabaseRecord,
  requireDatabase,
  unsealSecrets,
} from "../../databases/service";
import { COMPANION_TOKEN_CONTEXT, type StoredCompanion } from "../../databases/spec";
import { ensureProjectNetwork, joinProxyToNetwork } from "../../projects/network";
import {
  type CompiledCompanion,
  companionImage,
  companionServiceName,
  compileCompanion,
} from "../../services/compile/database/companions";
import { findService, saveServiceSpec } from "../../services/repo";
import { assertNameFits, type ServiceTarget } from "../../services/service";
import { getSetting, SERVICE_DOMAIN_KEY } from "../../system/repo";
import { getSystemInfo } from "../../system/service";
import { isHostAvailable } from "../domains/repo";

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 32;
const COMPANION_USERNAME = "opsifier";
const MAX_LABEL = 63;

function generateToken(): string {
  let token = "";
  for (let index = 0; index < TOKEN_LENGTH; index += 1) {
    token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  }
  return token;
}

const routeName = (target: ServiceTarget, tool: CompanionTool): string => `${target.serviceName}-${tool}`;

function sslipSuffix(ip: string): string {
  const dashed = isIP(ip) === 6 ? ip.toLowerCase().replaceAll(":", "-") : ip;
  return `${dashed.startsWith("-") ? `0${dashed}` : dashed}.sslip.io`;
}

/** The same base as a new service's default domain: the `service_domain` setting, or the server's IP. */
function baseDomain(deps: AppDeps): string | null {
  const configured = getSetting(deps.db, SERVICE_DOMAIN_KEY);
  if (typeof configured === "string" && configured !== "") {
    return configured;
  }
  const { serverIp } = getSystemInfo(deps);
  return serverIp === null ? null : sslipSuffix(serverIp);
}

/** Picks the tool's own hostname, or says why there is none to give it. */
function pickCompanionHost(deps: AppDeps, target: ServiceTarget, tool: CompanionTool): string {
  const base = baseDomain(deps);
  if (base === null) {
    throw conflict(
      "server_address_unknown",
      "The server's address is unknown, so this tool cannot get a domain.",
    );
  }
  const label = `${target.projectName}-${target.serviceName}-${tool}`.replaceAll("_", "-");
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const host = `${label.slice(0, MAX_LABEL - suffix.length)}${suffix}.${base}`;
    if (isHostAvailable(deps.db, host, "/")) {
      return host;
    }
  }
  throw conflict("no_domain_left", "No domain is available for this tool.");
}

function toState(tool: CompanionTool, stored: StoredCompanion | undefined): CompanionState {
  return {
    tool,
    enabled: stored !== undefined,
    url: stored === undefined ? null : `https://${stored.host}/`,
    username: stored?.username ?? null,
  };
}

export function listCompanions(deps: AppDeps, target: ServiceTarget): CompanionState[] {
  const { database } = requireDatabase(deps, target).spec;
  return companionsByEngine[database.engine].map((tool) => toState(tool, database.companions[tool]));
}

function assertOffered(database: DatabaseRecord["spec"]["database"], tool: CompanionTool): void {
  if (!companionsByEngine[database.engine].includes(tool)) {
    throw notFound("This engine does not offer this tool.");
  }
}

function compileFor(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  tool: CompanionTool,
  stored: StoredCompanion,
): CompiledCompanion {
  const { database } = record.spec;
  const secrets = unsealSecrets(deps, database);
  return compileCompanion({
    project: target.projectName,
    service: target.serviceName,
    tool,
    engine: database.engine,
    user: database.user,
    databaseName: database.databaseName,
    password: secrets.password,
    rootPassword: secrets.rootPassword,
    host: stored.host,
    username: stored.username,
    token: deps.secrets.unseal(stored.sealedToken, COMPANION_TOKEN_CONTEXT),
  });
}

function saveCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  stored: StoredCompanion | undefined,
): void {
  const record = requireDatabase(deps, target);
  const companions = { ...record.spec.database.companions };
  if (stored === undefined) {
    delete companions[tool];
  } else {
    companions[tool] = stored;
  }
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, database: { ...record.spec.database, companions } },
    new Date(deps.now()),
  );
}

async function deployCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  tool: CompanionTool,
  stored: StoredCompanion,
  ctx: ActionContext,
): Promise<void> {
  const compiled = compileFor(deps, target, record, tool, stored);
  const name = compiled.swarmSpec.Name;
  const network = await ensureProjectNetwork(deps.docker, target.projectName);
  await joinProxyToNetwork(deps.docker, network, ctx.log);

  ctx.log(`Pulling image ${companionImage(tool)}`);
  await deps.docker.pullImage(companionImage(tool), { signal: ctx.signal });

  const existing = await deps.docker.inspectService(name);
  const previous = new Set(
    existing === null ? [] : (await deps.docker.listTasks({ service: name })).map((task) => task.id),
  );
  if (existing === null) {
    ctx.log(`Creating the Swarm service ${name}`);
    await deps.docker.createService(compiled.swarmSpec);
  } else {
    ctx.log(`Updating the Swarm service ${name}`);
    await deps.docker.updateService(name, {
      ...compiled.swarmSpec,
      TaskTemplate: {
        ...compiled.swarmSpec.TaskTemplate,
        ForceUpdate: (existing.spec.TaskTemplate.ForceUpdate ?? 0) + 1,
      },
    });
  }
  await deps.proxy.writeService(target.projectName, compiled.routeName, compiled.proxyConfig);
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired: 1,
    previousTaskIds: previous,
    signal: ctx.signal,
    log: ctx.log,
  });
}

async function removeCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  log: (line: string) => void,
): Promise<void> {
  log(`Removing ${tool}`);
  await deps.docker.removeService(companionServiceName(target.projectName, target.serviceName, tool));
  await deps.proxy.removeService(target.projectName, routeName(target, tool));
}

/** The tool only ever becomes available once it is up. A failed attempt leaves nothing behind. */
async function runEnable(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  ctx: ActionContext,
): Promise<void> {
  const stored: StoredCompanion = {
    sealedToken: deps.secrets.seal(generateToken(), COMPANION_TOKEN_CONTEXT),
    username: COMPANION_USERNAME,
    host: pickCompanionHost(deps, target, tool),
  };
  saveCompanion(deps, target, tool, stored);
  const record = requireDatabase(deps, target);
  try {
    await deployCompanion(deps, target, record, tool, stored, ctx);
  } catch (error) {
    await removeCompanion(deps, target, tool, ctx.log).catch(() => undefined);
    saveCompanion(deps, target, tool, undefined);
    throw error;
  }
  ctx.log(`${tool} is available at https://${stored.host}/`);
}

function assertEnableAllowed(deps: AppDeps, target: ServiceTarget, tool: CompanionTool): void {
  const { database } = requireDatabase(deps, target).spec;
  assertOffered(database, tool);
  if (database.companions[tool] !== undefined) {
    throw conflict("companion_enabled", "This tool is already enabled.");
  }
  const name = routeName(target, tool);
  if (findService(deps.db, target.projectName, name) !== undefined) {
    throw conflict("service_exists", `A service named ${name} already exists in this project.`);
  }
  try {
    assertNameFits(target.projectName, name);
  } catch {
    throw badRequest("validation_failed", "This service's name is too long to add a web tool to it.");
  }
}

function enqueueCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  verb: { type: string; title: string },
  actorEmail: string | undefined,
  run: (ctx: ActionContext) => Promise<void>,
): ActionRow {
  return deps.actions.enqueue({
    type: verb.type,
    title: `${verb.title} ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run,
  });
}

export function enqueueEnableCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  actorEmail: string | undefined,
): ActionRow {
  assertEnableAllowed(deps, target, tool);
  return enqueueCompanion(
    deps,
    target,
    { type: databaseActionTypes.companionEnable, title: `Enable ${tool} on` },
    actorEmail,
    (ctx) => runEnable(deps, target, tool, ctx),
  );
}

export function enqueueDisableCompanion(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  actorEmail: string | undefined,
): ActionRow {
  const { database } = requireDatabase(deps, target).spec;
  assertOffered(database, tool);
  if (database.companions[tool] === undefined) {
    throw conflict("companion_disabled", "This tool is not enabled.");
  }
  return enqueueCompanion(
    deps,
    target,
    { type: databaseActionTypes.companionDisable, title: `Disable ${tool} on` },
    actorEmail,
    async (ctx) => {
      await removeCompanion(deps, target, tool, ctx.log);
      saveCompanion(deps, target, tool, undefined);
      ctx.log(`${tool} is off`);
    },
  );
}

export function revealCompanionToken(
  deps: AppDeps,
  target: ServiceTarget,
  tool: CompanionTool,
  actorEmail: string | undefined,
): { token: string } {
  const stored = requireDatabase(deps, target).spec.database.companions[tool];
  if (stored === undefined) {
    throw conflict("companion_disabled", "This tool is not enabled.");
  }
  const token = deps.secrets.unseal(stored.sealedToken, COMPANION_TOKEN_CONTEXT);
  deps.actions.record({
    type: databaseActionTypes.companionReveal,
    title: `Reveal the ${tool} access token of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return { token };
}

/** A tool keeps the database's password in its own environment, so it follows every change. */
export async function refreshEnabledCompanions(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<void> {
  const record = requireDatabase(deps, target);
  for (const [tool, stored] of Object.entries(record.spec.database.companions)) {
    ctx.log(`Updating ${tool} with the new password`);
    await deployCompanion(deps, target, record, tool as CompanionTool, stored, ctx);
  }
}

export async function removeAllCompanions(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  log: (line: string) => void,
): Promise<void> {
  for (const tool of Object.keys(record.spec.database.companions)) {
    await removeCompanion(deps, target, tool as CompanionTool, log);
  }
}

/** A renamed service gets a new Swarm name, and the tools' addresses and targets would go stale. */
export function assertNoCompanions(deps: Pick<AppDeps, "db">, target: ServiceTarget): void {
  const record = findService(deps.db, target.projectName, target.serviceName);
  if (
    record !== undefined &&
    isDatabaseRecord(record) &&
    Object.keys(record.spec.database.companions).length > 0
  ) {
    throw conflict("companions_enabled", "Disable this database's web tools before renaming it.");
  }
}
