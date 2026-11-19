import { posix } from "node:path";
import { type ComposeIssue, type ComposeIssueCode, isRoutableComposeChild } from "@opsifier/contract";
import { parseDocument } from "yaml";
import { projectNetworkName, projectProxyNetworkName } from "../services/compile";
import { bindMountRisk } from "../services/compile/mounts";
import { contextImage, isForeignImage, isStackImageName } from "./images";
import { isReservedName, isStackContainerName } from "./network-names";
import { type BuildInput, ownFolderIssues, type StackMount, stackRelative } from "./own-folder";
import { attestationRequests, bindsAFolder } from "./resolved";
import { describeSsh, sshPaths } from "./ssh";

export interface ComposeInspection {
  /** The services the file defines, in file order. */
  services: string[];
  issues: ComposeIssue[];
  /** What the YAML parser said, in its own words. Null for a file it could read. */
  parseError: string | null;
  /** What the file mounts from the stack's own folder, from that folder. */
  mounts: StackMount[];
  /** What its builds read or write in the stack's own folder, from that folder. */
  inputs: BuildInput[];
  /** The files it has Compose read, `.env` among them, from the stack's folder. */
  files: string[];
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
  /**
   * Where this file sits in the stack's folder, for a file another one includes or extends. Its
   * relative paths start from there, and still have to stay inside the stack.
   */
  base?: string;
  /** Where the file the stack starts from sits in its folder, when this is that file. */
  file?: string;
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
  runs_program: "error",
  foreign_image: "error",
  foreign_name: "error",
  mounts_stack: "error",
  bind_volume: "error",
  build_attestation: "error",
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
  port_taken: "error",
  no_restart_policy: "warning",
  external_resource: "host",
  profiles: "warning",
  network_mode: "warning",
  unroutable_name: "warning",
};

/** A path on the panel's side that Compose takes from the stack's folder, as written. */
const isLocalPath = (path: string): boolean =>
  !path.includes("$") && !REMOTE.test(path) && !path.startsWith("/") && !path.startsWith("~");

class IssueList {
  readonly issues: ComposeIssue[] = [];
  readonly mounts: StackMount[] = [];
  readonly inputs: BuildInput[] = [];
  readonly files = new Set<string>();

  add(code: ComposeIssueCode, service: string | null, detail: string | null = null): void {
    this.issues.push({ severity: SEVERITY[code], code, service, detail });
  }

  /** A folder or file of the stack a child mounts. One that leaves the stack is refused elsewhere. */
  mount(service: string | null, path: string, options: InspectOptions): void {
    const inside = isLocalPath(path) ? stackRelative(path, options.base) : null;
    if (inside !== null) {
      this.mounts.push({ service, path: inside });
    }
  }

  /** Something a build reads or writes, other than a stage, a service or an image it names. */
  input(service: string, path: string, field: string, written: boolean, options: InspectOptions): void {
    const inside =
      isLocalPath(path) && !/^(?:service|target):/i.test(path) ? stackRelative(path, options.base) : null;
    if (inside !== null) {
      this.inputs.push({ service, path: inside, field, written });
    }
  }

  /** A file Compose reads to know what the stack is. */
  file(path: string, options: InspectOptions): void {
    const inside = isLocalPath(path) ? stackRelative(path, options.base) : null;
    if (inside !== null) {
      this.files.add(inside);
    }
  }
}

const HOST_NAMESPACE_KEYS = ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const;

/** An address Compose or BuildKit would fetch from elsewhere: a URL, or Git's `user@host:path`. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/:@]+@[^\s/:]+:)/i;

/** A layout of images BuildKit reads from wherever it names on the panel's disk. */
const OCI_LAYOUT = /^oci-layout:\/\//i;

/** The one security option that only ever tightens a container. */
const TIGHTENING_OPTION = /^no-new-privileges(?:[:=](?:true|false))?$/;

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

/**
 * Whether a relative path stays inside the stack once `..` has been followed, read from the folder of
 * the file that names it. Compose takes any path that doesn't start with `/` or `~` from there, so
 * `x/../..` and `.x/../..` count as much as `../..`.
 */
function staysInside(path: string, base = "."): boolean {
  const normal = posix.normalize(posix.join(base, path));
  return normal !== ".." && !normal.startsWith("../");
}

/**
 * What a path is for. A build context may be a repository or an image, which BuildKit fetches for
 * itself. Any other file Compose would fetch onto the panel's disk before anything here could read it.
 */
type PathUse = "file" | "context";

/** Sorts one path a stack points at: fine, off limits, or on the host. */
function checkPath(
  path: string,
  list: IssueList,
  service: string | null,
  options: InspectOptions,
  use: PathUse = "file",
): void {
  // Interpolated by Compose at deploy time: it could say anything, so it counts as the host.
  if (path.includes("$")) {
    list.add("host_path", service, path);
    return;
  }
  if (REMOTE.test(path)) {
    if (use === "file") {
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
    return;
  }
  if (!staysInside(path, options.base)) {
    list.add("escapes_stack", service, path);
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

/** A path, a list of them, or entries that carry one under `key`, as Compose lets most fields say. */
function filePaths(value: unknown, key = "path"): string[] {
  return asList(value).flatMap((entry) => {
    const path = isRecord(entry) ? entry[key] : entry;
    return typeof path === "string" ? [path] : [];
  });
}

function checkFileReference(
  value: unknown,
  list: IssueList,
  service: string | null,
  options: InspectOptions,
  key = "path",
): void {
  for (const path of filePaths(value, key)) {
    checkPath(path, list, service, options);
  }
}

/**
 * A file Compose brings in, or the folder it reads it from, named through a variable: Compose fills it
 * in, then reads or fetches what it says while it loads the stack, before anything here could look at
 * it or follow it. Refused, whatever the variable says now.
 */
function refuseInterpolated(value: unknown, list: IssueList, service: string | null, what: string): boolean {
  const named = filePaths(value).filter((path) => path.includes("$"));
  for (const path of named) {
    list.add("escapes_stack", service, `${what}: ${path}`);
  }
  return named.length > 0;
}

/**
 * The folder an included file's paths start from. Compose takes an absolute one, or one under `~`, as
 * it is, and only a relative one from the folder of the file that includes it: a folder outside the
 * stack is refused, whatever confirms what, since the files read from there are the stack's too.
 */
function checkProjectDirectory(value: unknown, list: IssueList, options: InspectOptions): void {
  for (const path of filePaths(value)) {
    if (/^[/~]/.test(path) || REMOTE.test(path) || !staysInside(path, options.base)) {
      list.add("escapes_stack", null, `include project_directory: ${path}`);
    }
  }
}

/** A file Compose reads to know what the stack is: checked like any path, and kept out of every mount. */
function checkStackFile(
  value: unknown,
  list: IssueList,
  service: string | null,
  options: InspectOptions,
): void {
  checkFileReference(value, list, service, options);
  for (const path of filePaths(value)) {
    list.file(path, options);
  }
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

function checkHostAccess(name: string, child: YamlRecord, list: IssueList, options: InspectOptions): void {
  if (isSet(child.privileged)) {
    list.add("privileged", name);
  }
  for (const hook of ["post_start", "pre_stop"] as const) {
    if (asList(child[hook]).some((entry) => isRecord(entry) && isSet(entry.privileged))) {
      list.add("privileged", name, hook);
    }
  }
  for (const key of HOST_NAMESPACE_KEYS) {
    if (leavesContainer(child[key])) {
      list.add("host_namespace", name, `${key}: ${String(child[key])}`);
    }
  }
  if (isSet(child.cgroup_parent)) {
    list.add("host_namespace", name, `cgroup_parent: ${String(child.cgroup_parent)}`);
  }
  if (isSet(child.use_api_socket)) {
    list.add("docker_socket", name, "use_api_socket");
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
  const cgroupRules = asList(child.device_cgroup_rules).map(String);
  if (cgroupRules.length > 0) {
    list.add("devices", name, `device_cgroup_rules: ${cgroupRules.join(", ")}`);
  }
  if (isSet(child.gpus)) {
    list.add("devices", name, "gpus");
  }
  const resources = isRecord(child.deploy) && isRecord(child.deploy.resources) ? child.deploy.resources : {};
  const reservations = isRecord(resources.reservations) ? resources.reservations : {};
  if (asList(reservations.devices).length > 0) {
    list.add("devices", name, "deploy.resources.reservations.devices");
  }
  // Anything but the one option that tightens: a profile or a label can loosen as much as `unconfined`.
  const relaxed = asList(child.security_opt)
    .map(String)
    .filter((option) => !TIGHTENING_OPTION.test(option.trim()));
  if (relaxed.length > 0) {
    list.add("security_options", name, relaxed.join(", "));
  }
  if (isSet(child.runtime)) {
    list.add("security_options", name, `runtime: ${String(child.runtime)}`);
  }
  checkStackFile(child.label_file, list, name, options);
  checkFileReference(child.credential_spec, list, name, options, "file");
  for (const entry of asList(child.volumes)) {
    const source = bindSource(entry);
    if (source !== null) {
      checkPath(source, list, name, options);
      list.mount(name, source, options);
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

/** What a file says about the networks its children join, for the names they answer to there. */
interface FileNetworks {
  /** The keys that stand for the project's proxy network, which the proxy reaches every upstream on. */
  proxy: ReadonlySet<string>;
}

/** The generated override's key for the proxy network. A file can name it too. */
const OVERRIDE_PROXY_KEY = "opsifier_proxy_network";

function fileNetworks(file: YamlRecord, { project }: NetworkScope): FileNetworks {
  const proxy = new Set([OVERRIDE_PROXY_KEY]);
  if (isRecord(file.networks)) {
    for (const [key, value] of Object.entries(file.networks)) {
      if (attachedNetworkName(key, value) === projectProxyNetworkName(project)) {
        proxy.add(key);
      }
    }
  }
  return { proxy };
}

/**
 * The names a child takes besides the address the panel gives it: its own, its container's, and the
 * aliases it asks for. None may be one the proxy could be looking for elsewhere. A value Compose fills
 * in from a variable is judged once it has, before the deploy.
 */
function checkNames(
  name: string,
  child: YamlRecord,
  list: IssueList,
  options: InspectOptions,
  networks: FileNetworks,
): void {
  if (isReservedName(name)) {
    list.add("foreign_name", name, name);
  } else if (!isRoutableComposeChild(name)) {
    list.add("unroutable_name", name, name);
  }
  if (child.container_name !== undefined) {
    const value = String(child.container_name);
    if (isInterpolated(value) || isStackContainerName(value, options.stack)) {
      list.add("container_name", name, value);
    } else {
      list.add("foreign_name", name, `container_name: ${value}`);
    }
  }
  // Docker answers for a container's hostname on every network it joins, as for an alias.
  if (
    typeof child.hostname === "string" &&
    !isInterpolated(child.hostname) &&
    isReservedName(child.hostname)
  ) {
    list.add("foreign_name", name, `hostname: ${child.hostname}`);
  }
  if (!isRecord(child.networks)) {
    return;
  }
  for (const [key, attachment] of Object.entries(child.networks)) {
    for (const alias of isRecord(attachment) ? asList(attachment.aliases).map(String) : []) {
      // The proxy's network takes no alias at all: the panel gives each child the one it needs there.
      if (networks.proxy.has(key) || (!isInterpolated(alias) && isReservedName(alias))) {
        list.add("foreign_name", name, `aliases: ${alias}`);
      }
    }
  }
}

function checkChild(
  name: string,
  child: YamlRecord,
  known: ReadonlySet<string>,
  list: IssueList,
  options: InspectOptions,
  networks: FileNetworks,
): void {
  checkHostAccess(name, child, list, options);
  checkPorts(name, child, list, options);
  checkNames(name, child, list, options, networks);

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

  checkImages(name, child, list, options);

  // Everything else a service can point the Compose CLI at on disk.
  checkBuild(name, child.build, list, options);
  checkStackFile(child.env_file, list, name, options);
  if (isRecord(child.extends) && !refuseInterpolated(child.extends.file, list, name, "extends file")) {
    checkStackFile(child.extends.file, list, name, options);
  }

  // Compose hands these to a program of its own, run where the panel runs rather than in a container.
  if (child.provider !== undefined) {
    const type = isRecord(child.provider) ? child.provider.type : child.provider;
    list.add("runs_program", name, `provider: ${String(type)}`);
  }
  if (child.models !== undefined) {
    list.add("runs_program", name, "models");
  }
}

/**
 * The names a service builds under, and the images it runs that only exist on this server. A value
 * Compose fills in from a variable is judged once it has, before the deploy.
 */
function checkImages(name: string, child: YamlRecord, list: IssueList, options: InspectOptions): void {
  const known = (value: unknown): value is string => typeof value === "string" && !value.includes("$");
  if (child.build !== undefined && child.build !== null) {
    const names = [child.image, ...(isRecord(child.build) ? asList(child.build.tags) : [])];
    for (const image of names.filter(known)) {
      if (!isStackImageName(image, options.stack)) {
        list.add("foreign_image", name, image);
      }
    }
  } else if (known(child.image) && isForeignImage(child.image, options.project)) {
    list.add("foreign_image", name, child.image);
  }
  for (const entry of asList(child.volumes)) {
    if (isRecord(entry) && entry.type === "image" && known(entry.source)) {
      if (isForeignImage(entry.source, options.project)) {
        list.add("foreign_image", name, entry.source);
      }
    }
  }
  for (const value of isRecord(child.build) ? namedValues(child.build.additional_contexts) : []) {
    const image = known(value) ? contextImage(value) : null;
    if (image !== null && isForeignImage(image, options.project)) {
      list.add("foreign_image", name, image);
    }
  }
}

/** The values of a build field that is either a mapping or a list of `name=value` entries. */
function namedValues(value: unknown): unknown[] {
  if (isRecord(value)) {
    return Object.values(value);
  }
  return asList(value).map((entry) => {
    const text = String(entry);
    const separator = text.indexOf("=");
    return separator === -1 ? text : text.slice(separator + 1);
  });
}

/** What a build reads from the panel's side, and what it is allowed to do while it runs. */
function checkBuild(name: string, build: unknown, list: IssueList, options: InspectOptions): void {
  if (build === undefined || build === null) {
    return;
  }
  // A build written as a mapping without a context builds from the stack's folder.
  const context = isRecord(build) ? (build.context ?? ".") : build;
  if (typeof context === "string") {
    checkPath(context, list, name, options, "context");
    list.input(name, context, "context", false, options);
  }
  if (!isRecord(build)) {
    return;
  }
  if (typeof build.dockerfile === "string") {
    const { dockerfile } = build;
    const fromContext =
      typeof context !== "string" || (!REMOTE.test(context) && !context.includes("$"))
        ? posix.join(typeof context === "string" ? context : ".", dockerfile)
        : null;
    // Read from inside the context: a context fetched from elsewhere brings its own.
    if (dockerfile.startsWith("/") || dockerfile.startsWith("~") || dockerfile.includes("$")) {
      checkPath(dockerfile, list, name, options);
    } else if (fromContext !== null) {
      checkPath(fromContext, list, name, options);
      list.input(name, fromContext, "dockerfile", false, options);
    }
  }
  for (const value of namedValues(build.additional_contexts)) {
    if (typeof value === "string") {
      checkPath(value, list, name, options, "context");
      list.input(name, value, "additional_contexts", false, options);
      if (OCI_LAYOUT.test(value)) {
        list.add("host_path", name, `additional_contexts: ${value}`);
      }
    }
  }
  // `default` forwards an agent the panel doesn't run. `id=path` reads a key from the panel's disk.
  const keys = sshPaths(build.ssh);
  if (keys === null) {
    list.add("escapes_stack", name, `build.ssh: ${describeSsh(build.ssh)}`);
  }
  for (const path of keys ?? []) {
    checkPath(path, list, name, options);
    list.input(name, path, "ssh", false, options);
  }
  // A local cache is read from, or written to, the panel's own disk.
  for (const [field, entries] of [
    ["cache_from", build.cache_from],
    ["cache_to", build.cache_to],
  ] as const) {
    for (const entry of asList(entries).map(String)) {
      const fields = entry.split(",").map((part) => part.split("="));
      if (fields.some(([key, value]) => key === "type" && value === "local")) {
        for (const [key, value] of fields) {
          if ((key === "src" || key === "dest") && value !== undefined) {
            checkPath(value, list, name, options);
            list.input(name, value, field, key === "dest", options);
          }
        }
      }
    }
  }
  if (isSet(build.privileged)) {
    list.add("privileged", name, "build.privileged");
  }
  const entitlements = asList(build.entitlements).map(String);
  if (entitlements.length > 0) {
    list.add("privileged", name, `build.entitlements: ${entitlements.join(", ")}`);
  }
  for (const request of attestationRequests(build)) {
    list.add("build_attestation", name, request);
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
        if (key === "volumes" && isRecord(value) && bindsAFolder(value)) {
          list.add("bind_volume", null, name);
        } else if (device !== undefined) {
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
          // Compose mounts the file into the children that use it, as it mounts a volume's source.
          for (const path of filePaths(value.file)) {
            list.mount(null, path, options);
          }
        }
      }
    }
  }
  // Read, or fetched, as the file is loaded: before anything else here sees what they bring.
  for (const entry of asList(file.include)) {
    const record = isRecord(entry) ? entry : { path: entry };
    const interpolated = [
      refuseInterpolated(record.path, list, null, "include"),
      refuseInterpolated(record.env_file, list, null, "include env_file"),
      refuseInterpolated(record.project_directory, list, null, "include project_directory"),
    ].some(Boolean);
    if (interpolated) {
      continue;
    }
    checkStackFile(record.path, list, null, options);
    checkStackFile(record.env_file, list, null, options);
    checkProjectDirectory(record.project_directory, list, options);
    // An included file takes its variables from the `.env` of its own folder unless it names others.
    const folders =
      typeof record.project_directory === "string"
        ? [record.project_directory]
        : filePaths(record.path).map((path) => posix.dirname(path));
    if (record.env_file === undefined) {
      for (const folder of folders) {
        list.file(posix.join(folder, ".env"), options);
      }
    }
  }
  if (isRecord(file.models)) {
    for (const model of Object.keys(file.models)) {
      list.add("runs_program", null, `models: ${model}`);
    }
  }
}

/**
 * Reads a Compose file the way the deploy will, without running anything. Invalid YAML is a finding,
 * not a failure: the Source tab shows the parser's own words and a deploy refuses to go ahead.
 */
export function inspectComposeFile(text: string, options: InspectOptions): ComposeInspection {
  const unread = (parseError: string | null, issues: ComposeIssue[] = []): ComposeInspection => ({
    services: [],
    issues,
    parseError,
    mounts: [],
    inputs: [],
    files: [],
  });
  const document = parseDocument(text, { merge: true });
  if (document.errors.length > 0) {
    return unread(document.errors.map((error) => error.message).join("\n"));
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 200 });
  } catch (error) {
    return unread(error instanceof Error ? error.message : String(error));
  }

  const list = new IssueList();
  if (!isRecord(value) || !isRecord(value.services) || Object.keys(value.services).length === 0) {
    list.add("no_services", null);
    return unread(null, list.issues);
  }

  const children = Object.entries(value.services).filter((entry): entry is [string, YamlRecord] =>
    isRecord(entry[1]),
  );
  const known = new Set(children.map(([name]) => name));
  const networks = fileNetworks(value, options);
  for (const [name, child] of children) {
    checkChild(name, child, known, list, options, networks);
  }
  checkTopLevel(value, list, options);
  for (const { service, detail } of foreignNetworks(value, options)) {
    list.add("foreign_network", service, detail);
  }
  // Compose reads the `.env` of the stack's folder for its variables, and the file it starts from.
  list.files.add(".env");
  if (options.file !== undefined) {
    list.file(options.file, { ...options, base: "." });
  }
  const files = [...list.files];
  list.issues.push(...ownFolderIssues(list.mounts, files, list.inputs));

  return {
    services: children.map(([name]) => name),
    issues: [...list.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    parseError: null,
    mounts: list.mounts,
    inputs: list.inputs,
    files,
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
