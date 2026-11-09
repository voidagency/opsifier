import { type ComposeIssue, type ComposeIssueCode, isRoutableComposeChild } from "@opsifier/contract";
import { parseDocument } from "yaml";
import { projectNetworkName, projectProxyNetworkName } from "../services/compile";
import { bindMountRisk } from "../services/compile/mounts";

export interface ComposeInspection {
  /** The services the file defines, in file order. */
  services: string[];
  issues: ComposeIssue[];
  /** What the YAML parser said, in its own words. Null for a file it could read. */
  parseError: string | null;
}

/** Whose networks a file may name: its own project's, and the ones Compose makes for the stack. */
export interface NetworkScope {
  project: string;
  /** The stack's Compose project, which is what Compose prefixes the networks it creates with. */
  stack: string;
}

export interface InspectOptions extends NetworkScope {
  /** The panel's data directory, which a mount must not expose. */
  dataDir: string;
  /** Host ports other services and the panel already hold, and by whom. Empty when that can't be said. */
  takenPorts?: ReadonlyMap<number, string>;
}

type YamlRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is YamlRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

const SEVERITY_ORDER = { error: 0, host: 1, warning: 2 } as const;

const SEVERITY: Record<ComposeIssueCode, ComposeIssue["severity"]> = {
  no_services: "error",
  unknown_dependency: "error",
  escapes_stack: "error",
  foreign_network: "error",
  privileged: "host",
  docker_socket: "host",
  data_directory: "host",
  host_path: "host",
  host_namespace: "host",
  capabilities: "host",
  devices: "host",
  security_options: "host",
  container_name: "warning",
  published_port: "warning",
  port_taken: "warning",
  no_restart_policy: "warning",
  external_resource: "host",
  profiles: "warning",
  network_mode: "warning",
  unroutable_name: "warning",
};

class IssueList {
  readonly issues: ComposeIssue[] = [];

  add(code: ComposeIssueCode, service: string | null, detail: string | null = null): void {
    this.issues.push({ severity: SEVERITY[code], code, service, detail });
  }
}

const HOST_NAMESPACE_KEYS = ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const;
const RELATIVE_PATH = /^\.\.?(?:\/|$)/;

/** Filled in by Compose from the stack's variables, which whoever edits the stack can set to anything. */
const isInterpolated = (value: unknown): boolean => typeof value === "string" && value.includes("$");

/** A value Compose reads as "share this namespace", now or once it is interpolated. */
const leavesContainer = (value: unknown): boolean =>
  value === "host" || isInterpolated(value) || (typeof value === "string" && value.startsWith("container:"));

/** Staying off every network, or sharing another child's. Anything else is somebody else's network. */
const keepsNetworkToStack = (mode: string): boolean =>
  mode === "none" || (mode.startsWith("service:") && !isInterpolated(mode));

/** The Docker network a top-level entry attaches to. Null when Compose creates it for the stack. */
function attachedNetworkName(key: string, value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const legacy = isRecord(value.external) ? value.external.name : undefined;
  const named = typeof legacy === "string" ? legacy : typeof value.name === "string" ? value.name : null;
  const external = value.external !== undefined && value.external !== false;
  return named ?? (external ? key : null);
}

/**
 * Every place a Compose file reaches a network its project doesn't own: a network it attaches to by
 * name, a network mode that shares someone else's, a build that joins one. Takes the file as written
 * or as Compose resolved it, whose `name` is always there and is the stack's own for what it creates.
 */
export function foreignNetworks(
  file: Record<string, unknown>,
  { project, stack }: NetworkScope,
): Array<{ service: string | null; detail: string }> {
  const owned = [projectNetworkName(project), projectProxyNetworkName(project)];
  const found: Array<{ service: string | null; detail: string }> = [];
  if (isRecord(file.networks)) {
    for (const [key, value] of Object.entries(file.networks)) {
      const name = attachedNetworkName(key, value);
      if (name !== null && !owned.includes(name) && name !== `${stack}_${key}`) {
        found.push({ service: null, detail: name });
      }
    }
  }
  if (isRecord(file.services)) {
    for (const [service, child] of Object.entries(file.services)) {
      if (!isRecord(child)) {
        continue;
      }
      if (typeof child.network_mode === "string" && child.network_mode !== "host") {
        if (!keepsNetworkToStack(child.network_mode)) {
          found.push({ service, detail: `network_mode: ${child.network_mode}` });
        }
      }
      const buildNetwork = isRecord(child.build) ? child.build.network : undefined;
      if (typeof buildNetwork === "string" && !["default", "none", "host"].includes(buildNetwork)) {
        found.push({ service, detail: `build.network: ${buildNetwork}` });
      }
    }
  }
  return found;
}

/** Whether a relative path stays inside the stack once `..` has been followed. */
function staysInside(path: string): boolean {
  let depth = 0;
  for (const part of path.split("/")) {
    if (part === "..") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    } else if (part !== "." && part !== "") {
      depth += 1;
    }
  }
  return true;
}

/** Sorts one path a stack points at: fine, off limits, or on the host. */
function checkPath(path: string, list: IssueList, service: string | null, options: InspectOptions): void {
  // Interpolated by Compose at deploy time: it could say anything, so it counts as the host.
  if (path.includes("$")) {
    list.add("host_path", service, path);
    return;
  }
  if (RELATIVE_PATH.test(path)) {
    if (!staysInside(path)) {
      list.add("escapes_stack", service, path);
    }
    return;
  }
  if (path.startsWith("/")) {
    const risk = bindMountRisk(path.replace(/\/+$/, "") || "/", options.dataDir);
    list.add(
      risk === "docker-socket" ? "docker_socket" : risk === "data-directory" ? "data_directory" : "host_path",
      service,
      path,
    );
    return;
  }
  if (path.startsWith("~")) {
    list.add("host_path", service, path);
  }
}

/** The host side of a `volumes` entry, when it is a bind mount. */
function bindSource(entry: unknown): string | null {
  if (typeof entry === "string") {
    if (entry.includes("$")) {
      return entry;
    }
    const separator = entry.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const source = entry.slice(0, separator);
    return source.startsWith("/") || source.startsWith(".") || source.startsWith("~") ? source : null;
  }
  if (
    isRecord(entry) &&
    typeof entry.source === "string" &&
    (entry.type === "bind" || isInterpolated(entry.type))
  ) {
    return entry.source;
  }
  return null;
}

/** The host port a `ports` entry publishes. Null when Docker picks one, or it can't be read yet. */
function publishedPort(entry: unknown): { port: number | null; shown: string } {
  if (isRecord(entry)) {
    const raw = entry.published;
    const shown = `${raw ?? entry.target}`;
    const port = Number(raw);
    return { port: Number.isInteger(port) && port > 0 ? port : null, shown };
  }
  const text = String(entry);
  // The short form: [ip:]host:container[/protocol].
  const parts = text.split("/")[0]?.split(":") ?? [];
  if (parts.length < 2) {
    return { port: null, shown: text };
  }
  const port = Number(parts[parts.length - 2]);
  return { port: Number.isInteger(port) && port > 0 ? port : null, shown: text };
}

function checkFileReference(
  value: unknown,
  list: IssueList,
  service: string | null,
  options: InspectOptions,
): void {
  if (typeof value === "string") {
    checkPath(value, list, service, options);
  }
}

function checkHostAccess(name: string, child: YamlRecord, list: IssueList, options: InspectOptions): void {
  if (child.privileged !== undefined && child.privileged !== false) {
    list.add("privileged", name);
  }
  for (const key of HOST_NAMESPACE_KEYS) {
    if (leavesContainer(child[key])) {
      list.add("host_namespace", name, `${key}: ${String(child[key])}`);
    }
  }
  const capabilities = asList(child.cap_add).map(String);
  if (capabilities.length > 0) {
    list.add("capabilities", name, capabilities.join(", "));
  }
  const devices = asList(child.devices).map((device) =>
    isRecord(device) ? String(device.source ?? "") : String(device).split(":")[0],
  );
  if (devices.length > 0) {
    list.add("devices", name, devices.join(", "));
  }
  const relaxed = asList(child.security_opt)
    .map(String)
    .filter(
      (option) => option.includes("unconfined") || option.includes("label=disable") || option.includes("$"),
    );
  if (relaxed.length > 0) {
    list.add("security_options", name, relaxed.join(", "));
  }
  for (const entry of asList(child.volumes)) {
    const source = bindSource(entry);
    if (source !== null) {
      checkPath(source, list, name, options);
    }
  }
  // Another container's volumes or links: what they hold is not this stack's to reach.
  for (const entry of asList(child.volumes_from).map(String)) {
    if (entry.startsWith("container:") || entry.includes("$")) {
      list.add("external_resource", name, entry);
    }
  }
  for (const entry of asList(child.external_links).map(String)) {
    list.add("external_resource", name, entry);
  }
}

function checkPorts(name: string, child: YamlRecord, list: IssueList, options: InspectOptions): void {
  for (const entry of asList(child.ports)) {
    const { port, shown } = publishedPort(entry);
    const holder = port === null ? undefined : options.takenPorts?.get(port);
    if (holder !== undefined) {
      list.add("port_taken", name, holder === "" ? shown : `${shown} (${holder})`);
    } else {
      list.add("published_port", name, shown);
    }
  }
}

function checkChild(
  name: string,
  child: YamlRecord,
  known: ReadonlySet<string>,
  list: IssueList,
  options: InspectOptions,
): void {
  checkHostAccess(name, child, list, options);
  checkPorts(name, child, list, options);

  if (child.container_name !== undefined) {
    list.add("container_name", name, String(child.container_name));
  }
  if (child.network_mode === "host") {
    list.add("host_namespace", name, "network_mode: host");
  } else if (typeof child.network_mode === "string" && keepsNetworkToStack(child.network_mode)) {
    list.add("network_mode", name, child.network_mode);
  }
  if (isRecord(child.build) && child.build.network === "host") {
    list.add("host_namespace", name, "build.network: host");
  }
  if (child.restart === undefined && child.deploy === undefined) {
    list.add("no_restart_policy", name);
  }
  const profiles = asList(child.profiles);
  if (profiles.length > 0) {
    list.add("profiles", name, profiles.map(String).join(", "));
  }
  if (!isRoutableComposeChild(name)) {
    list.add("unroutable_name", name, name);
  }

  const dependencies = Array.isArray(child.depends_on)
    ? child.depends_on.map(String)
    : isRecord(child.depends_on)
      ? Object.keys(child.depends_on)
      : [];
  for (const dependency of dependencies) {
    if (!known.has(dependency)) {
      list.add("unknown_dependency", name, dependency);
    }
  }

  // Everything else a service can point the Compose CLI at on disk.
  const build = child.build;
  checkFileReference(isRecord(build) ? build.context : build, list, name, options);
  if (isRecord(build)) {
    checkFileReference(build.dockerfile, list, name, options);
  }
  for (const envFile of asList(child.env_file)) {
    checkFileReference(isRecord(envFile) ? envFile.path : envFile, list, name, options);
  }
  if (isRecord(child.extends)) {
    checkFileReference(child.extends.file, list, name, options);
  }
}

function checkTopLevel(file: YamlRecord, list: IssueList, options: InspectOptions): void {
  for (const key of ["networks", "volumes"] as const) {
    const section = file[key];
    if (isRecord(section)) {
      for (const [name, value] of Object.entries(section)) {
        // A fixed name attaches to whatever already has it, so it reaches as far as `external` does.
        const external = isRecord(value) && value.external !== undefined && value.external !== false;
        if (key === "volumes" && (external || (isRecord(value) && typeof value.name === "string"))) {
          list.add("external_resource", null, name);
        }
        const device = isRecord(value) && isRecord(value.driver_opts) ? value.driver_opts.device : undefined;
        if (device !== undefined) {
          list.add("host_path", null, String(device));
        }
      }
    }
  }
  for (const key of ["secrets", "configs"] as const) {
    const section = file[key];
    if (isRecord(section)) {
      for (const value of Object.values(section)) {
        if (isRecord(value)) {
          checkFileReference(value.file, list, null, options);
        }
      }
    }
  }
  for (const entry of asList(file.include)) {
    const path = isRecord(entry) ? entry.path : entry;
    for (const item of asList(path)) {
      checkFileReference(item, list, null, options);
    }
  }
}

/**
 * Reads a Compose file the way the deploy will, without running anything. Invalid YAML is a finding,
 * not a failure: the Source tab shows the parser's own words and a deploy refuses to go ahead.
 */
export function inspectComposeFile(text: string, options: InspectOptions): ComposeInspection {
  const document = parseDocument(text, { merge: true });
  if (document.errors.length > 0) {
    return { services: [], issues: [], parseError: document.errors.map((error) => error.message).join("\n") };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 200 });
  } catch (error) {
    return { services: [], issues: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  const list = new IssueList();
  if (!isRecord(value) || !isRecord(value.services) || Object.keys(value.services).length === 0) {
    list.add("no_services", null);
    return { services: [], issues: list.issues, parseError: null };
  }

  const children = Object.entries(value.services).filter((entry): entry is [string, YamlRecord] =>
    isRecord(entry[1]),
  );
  const known = new Set(children.map(([name]) => name));
  for (const [name, child] of children) {
    checkChild(name, child, known, list, options);
  }
  checkTopLevel(value, list, options);
  for (const { service, detail } of foreignNetworks(value, options)) {
    list.add("foreign_network", service, detail);
  }

  return {
    services: children.map(([name]) => name),
    issues: [...list.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    parseError: null,
  };
}

/** One value of a service's configuration that could name a host. */
export interface Mention {
  /** The variable it is the value of. Null in a command line, where any word could be a host. */
  key: string | null;
  value: string;
}

function environmentMentions(environment: unknown): Mention[] {
  if (isRecord(environment)) {
    return Object.entries(environment).flatMap(([key, value]) =>
      value == null ? [] : [{ key, value: String(value) }],
    );
  }
  return asList(environment).flatMap((entry) => {
    const text = String(entry);
    const separator = text.indexOf("=");
    return separator === -1 ? [] : [{ key: text.slice(0, separator), value: text.slice(separator + 1) }];
  });
}

/** What a file's children are told to connect to, as the file writes it. */
export function stackMentions(text: string): Mention[] {
  return stackChildren(text).flatMap((child) => [
    ...environmentMentions(child.environment),
    ...[...asList(child.command), ...asList(child.entrypoint)].map((value) => ({
      key: null,
      value: String(value),
    })),
  ]);
}

/** What each service of a file asks Docker for. Nothing, for a file that can't be read. */
export function stackChildren(text: string): YamlRecord[] {
  const document = parseDocument(text, { merge: true });
  if (document.errors.length > 0) {
    return [];
  }
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 200 });
  } catch {
    return [];
  }
  const services = isRecord(root) ? root.services : undefined;
  return isRecord(services) ? Object.values(services).filter(isRecord) : [];
}

/** Whether this file reaches outside its containers, and so needs a person to confirm it. */
export const hasHostAccess = (inspection: ComposeInspection): boolean =>
  inspection.issues.some((issue) => issue.severity === "host");

/** Whether something in the file stops it from being deployed at all. */
export const hasBlockingError = (inspection: ComposeInspection): boolean =>
  inspection.parseError !== null || inspection.issues.some((issue) => issue.severity === "error");
