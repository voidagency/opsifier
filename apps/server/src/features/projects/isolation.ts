import { parseEnvText } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { type Mention, stackMentions } from "../compose/inspect";
import { currentContent, inspectStackFile } from "../compose/service";
import { isDatabaseRecord } from "../databases/service";
import { qualifiedName, SHARED_NETWORK } from "../services/compile";
import { openEnv } from "../services/env-store";
import { listServiceRecords, type ServiceRecord } from "../services/repo";
import { networkNames, type ServiceTarget } from "../services/service";
import { isOnSharedNetwork, SUPPORTED_WAY } from "./network";
import { findProject } from "./repo";

/** A URL's hosts: `scheme://user:password@host:port,host:port/...`. */
const URL_HOSTS = /[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?([^\s/?#]+)/gi;
/** `host:port`, standing on its own. */
const HOST_AND_PORT = /(?:^|[\s,;="'(])([a-z0-9][a-z0-9._-]*):\d{1,5}(?=$|[\s,;"')/?])/gi;
/** Variables whose whole value is a host, by their name. Anything else can be a coincidence. */
const NAMES_A_HOST = /HOST|ADDR|SERVER|ENDPOINT/i;

function hostsIn({ key, value }: Mention): string[] {
  const inUrls = [...value.matchAll(URL_HOSTS)].flatMap((match) => (match[1] ?? "").split(","));
  const withPorts = [...value.matchAll(HOST_AND_PORT)].map((match) => match[1] ?? "");
  const whole = key === null ? value.split(/[\s=,'"]+/) : NAMES_A_HOST.test(key) ? [value.trim()] : [];
  return [...inUrls, ...withPorts, ...whole].map((host) => host.replace(/:\d+$/, "").toLowerCase());
}

/** What names one of these addresses, unless the address means something in the service's own project. */
function findAddress(
  mentions: readonly Mention[],
  addresses: ReadonlySet<string>,
  ownNames: ReadonlySet<string>,
): string | null {
  const found = mentions.find((mention) =>
    hostsIn(mention).some((host) => addresses.has(host) && !ownNames.has(host)),
  );
  return found === undefined ? null : (found.key ?? "The command");
}

/** The names that mean something inside this project, and so are never a reach into another. */
function namesInProject(deps: Pick<AppDeps, "db">, project: string): Set<string> {
  return new Set(
    listServiceRecords(deps.db, project).flatMap((record) => [
      ...networkNames(project, record.name),
      record.name,
    ]),
  );
}

/** Everything a service is told to connect to, opened only for as long as this check takes. */
async function mentionsOf(
  deps: Pick<AppDeps, "db" | "config" | "secrets">,
  target: ServiceTarget,
  record: ServiceRecord,
): Promise<Mention[]> {
  const { sealedEnv, deploy, database, compose } = record.spec;
  const project = findProject(deps.db, target.projectName);
  const stored: Mention[] = [
    ...parseEnvText(project === undefined ? "" : openEnv(deps, project.sealedEnv)),
    ...parseEnvText(openEnv(deps, sealedEnv)),
    ...(deploy.command === null ? [] : [{ key: null, value: deploy.command }]),
    ...(database == null || database.configFile === "" ? [] : [{ key: null, value: database.configFile }]),
  ];
  const content = compose === null ? null : await currentContent(deps, target, compose);
  return content === null ? stored : [...stored, ...stackMentions(content)];
}

/** Whether this other service could reach a database over the shared network today. */
async function reachesSharedNetwork(
  deps: Pick<AppDeps, "db" | "config" | "docker" | "secrets">,
  target: ServiceTarget,
  record: ServiceRecord,
): Promise<boolean> {
  const { compose } = record.spec;
  if (compose !== null) {
    const content = await currentContent(deps, target, compose);
    return (
      content !== null &&
      inspectStackFile(deps, target, content).issues.some(
        (issue) => issue.code === "foreign_network" && issue.detail === SHARED_NETWORK,
      )
    );
  }
  const service = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  return service !== null && (await isOnSharedNetwork(deps.docker, service));
}

/**
 * A database still on the shared network can be in use from another project, by a stack that joined
 * that network or a database on it, and this deployment is what would cut it off. Refused rather
 * than done quietly, in terms that say nothing about what the other project holds: the panel's own
 * log, which only administrators read, says which service it is.
 */
async function assertNotReliedOn(
  deps: Pick<AppDeps, "db" | "config" | "docker" | "logger" | "secrets">,
  target: ServiceTarget,
): Promise<void> {
  const current = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  if (current === null || !(await isOnSharedNetwork(deps.docker, current))) {
    return;
  }
  const addresses = new Set(networkNames(target.projectName, target.serviceName));
  for (const record of listServiceRecords(deps.db)) {
    const couldReach = record.spec.compose !== null || record.spec.database !== null;
    if (record.projectName === target.projectName || record.spec.stopped || !couldReach) {
      continue;
    }
    const consumer = { projectName: record.projectName, serviceName: record.name };
    const found = findAddress(
      await mentionsOf(deps, consumer, record),
      addresses,
      namesInProject(deps, record.projectName),
    );
    if (found !== null && (await reachesSharedNetwork(deps, consumer, record))) {
      deps.logger.warn(
        { database: target, consumer },
        "A service in another project uses this database over the shared network",
      );
      throw conflict(
        "database_still_in_use",
        `A service in another project connects to this database by name, over the network databases used to share. Deploying would take the database off it and cut that service off, so nothing was changed. Change that service first (saving it is enough), then deploy again. ${SUPPORTED_WAY}`,
      );
    }
  }
}

/**
 * Refuses what names a database of another project. Whoever puts a configuration in service asks,
 * whether it comes from what is saved or from a version being gone back to.
 */
export function assertStaysInProject(
  deps: Pick<AppDeps, "db">,
  target: ServiceTarget,
  mentions: readonly Mention[],
): void {
  const elsewhere = new Set(
    listServiceRecords(deps.db)
      .filter((other) => other.projectName !== target.projectName && isDatabaseRecord(other))
      .flatMap((other) => networkNames(other.projectName, other.name)),
  );
  const found = findAddress(mentions, elsewhere, namesInProject(deps, target.projectName));
  if (found !== null) {
    throw conflict(
      "foreign_database",
      `${found} points at a host this project can't reach: a database answers only inside its own project, so nothing was changed. ${SUPPORTED_WAY}`,
    );
  }
}

/**
 * What a deployment refuses so that one project stays out of another. A service naming a database
 * of another project would only fail later, with a name that doesn't resolve and no reason given.
 */
export async function assertProjectBoundaries(
  deps: Pick<AppDeps, "db" | "config" | "docker" | "logger" | "secrets">,
  target: ServiceTarget,
  record: ServiceRecord,
): Promise<void> {
  assertStaysInProject(deps, target, await mentionsOf(deps, target, record));
  if (isDatabaseRecord(record)) {
    await assertNotReliedOn(deps, target);
  }
}
