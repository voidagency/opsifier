import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";
import type { ComposeIssue, ComposeIssueCode } from "@opsifier/contract";
import { composeChildAddress, projectProxyNetworkName } from "../services/compile";
import { bindMountRisk } from "../services/compile/mounts";
import { contextImage, isForeignImage, isStackImageName } from "./images";
import { isReservedName, isStackContainerName } from "./network-names";
import { fromStackFolder, ownFolderIssues } from "./own-folder";
import { describeSsh, sshPaths } from "./ssh";

/**
 * What a stack reaches, read from the configuration Compose itself resolved (`docker compose config`):
 * every included and extended file merged in, every variable filled in, every relative path made
 * absolute. The file on the page can't show any of that, and it is what the containers really get.
 */
export interface ResolvedScope {
  /** The project the stack belongs to. */
  project: string;
  /** The stack's Compose project. */
  stack: string;
  /** The panel's data directory, which a mount must not expose. */
  dataDir: string;
  /** The folder Compose read the stack from. A path inside it is the stack's own. */
  projectDirectory: string;
  /**
   * The files Compose reads to know what the stack is, as the check of its files found them: those
   * an `include` or an `extends` brought in leave no trace in what Compose resolved.
   */
  stackFiles?: readonly string[];
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

const SEVERITY: Partial<Record<ComposeIssueCode, ComposeIssue["severity"]>> = {
  runs_program: "error",
  foreign_image: "error",
  foreign_name: "error",
  mounts_stack: "error",
  bind_volume: "error",
  build_attestation: "error",
  // A build's keys written in a form nothing here reads.
  escapes_stack: "error",
};

const issue = (code: ComposeIssueCode, service: string | null, detail: string | null): ComposeIssue => ({
  severity: SEVERITY[code] ?? "host",
  code,
  service,
  detail,
});

/** The one security option that only ever tightens a container. */
const TIGHTENING_OPTION = /^no-new-privileges(?:[:=](?:true|false))?$/;

/** A context or an additional context that BuildKit fetches for itself, rather than a local folder. */
const FETCHED = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/:@]+@[^\s/:]+:|service:|target:)/i;

/** Every path the resolved configuration names on the panel's side, with whom it belongs to. */
export interface LocalPath {
  service: string | null;
  path: string;
}

export interface ResolvedInspection {
  issues: ComposeIssue[];
  /** Paths the stack keeps inside its own folder, which a link inside that folder could still lead out of. */
  insidePaths: LocalPath[];
  /** What the children mount from the stack's own folder, where Docker will look for it. */
  mounts: StackBind[];
  /** The env files Compose reads from the stack's own folder, by absolute path. */
  files: string[];
  /** What the builds read or write in the stack's own folder, where the build will look for it. */
  inputs: ResolvedInput[];
}

/** A folder or file of the stack a child mounts, by absolute path, and whether it may write there. */
export interface StackBind extends LocalPath {
  writable: boolean;
}

/** Something a build reads or writes in the stack's own folder, by absolute path. */
export interface ResolvedInput extends LocalPath {
  /** Which part of the build names it, as Compose calls it. */
  field: string;
  /** Whether the build writes there: a local cache it exports. */
  written: boolean;
}

class Collector {
  readonly issues: ComposeIssue[] = [];
  readonly insidePaths: LocalPath[] = [];
  readonly mounts: StackBind[] = [];
  readonly inputs: ResolvedInput[] = [];
  /** The files Compose reads to know what the stack is, by absolute path. */
  readonly files: string[] = [];

  constructor(private readonly scope: ResolvedScope) {}

  /**
   * A path Docker mounts into a child. Inside the stack, the rules of its own folder hold for it. What
   * Compose resolved is what Docker gets, a `$` included: such a path is taken as it is, and, in case
   * Compose wrote a `$` as `$$`, as it would be read back too.
   */
  mount(service: string | null, raw: string, writable = true): void {
    const before = this.insidePaths.length;
    const spellings = raw.includes("$$") ? [raw, raw.replaceAll("$$", "$")] : [raw];
    for (const spelling of spellings) {
      this.path(service, spelling, this.scope.projectDirectory, true);
    }
    for (const inside of this.insidePaths.slice(before)) {
      this.mounts.push({ ...inside, writable });
    }
  }

  /** Something a build reads, or writes, on the panel's side. Inside the stack, it keeps clear of mounts. */
  input(service: string, raw: string, field: string, written: boolean, from?: string): void {
    const before = this.insidePaths.length;
    this.path(service, raw, from);
    for (const inside of this.insidePaths.slice(before)) {
      this.inputs.push({ ...inside, field, written });
    }
  }

  /** A file Compose reads to know what the stack is, which no mount may hold. */
  file(service: string | null, raw: string): void {
    const before = this.insidePaths.length;
    this.path(service, raw);
    for (const inside of this.insidePaths.slice(before)) {
      this.files.push(inside.path);
    }
  }

  /** Everything the children mount, held against the rest and against the stack's files. */
  ownFolder(): void {
    const root = posix.normalize(this.scope.projectDirectory).replace(/\/+$/, "") || "/";
    const inside = (path: string) => fromStackFolder(root, path);
    const mounts = this.mounts.flatMap(({ service, path }) => {
      const relative = inside(path);
      return relative === null ? [] : [{ service, path: relative }];
    });
    const files = [...this.files, ...(this.scope.stackFiles ?? [])].flatMap((path) => {
      const relative = inside(posix.normalize(path));
      return relative === null ? [] : [relative];
    });
    const inputs = this.inputs.flatMap(({ service, path, field, written }) => {
      const relative = inside(path);
      return relative === null ? [] : [{ service, path: relative, field, written }];
    });
    this.issues.push(...ownFolderIssues(mounts, files, inputs));
  }

  get directory(): string {
    return this.scope.projectDirectory;
  }

  get project(): string {
    return this.scope.project;
  }

  add(code: ComposeIssueCode, service: string | null, detail: string | null = null): void {
    this.issues.push(issue(code, service, detail));
  }

  /** A path on the panel's side: the stack's own when it is inside its folder, the server's otherwise. */
  path(service: string | null, raw: string, from = this.scope.projectDirectory, literal = false): void {
    if (!literal && raw.includes("$")) {
      // Compose leaves nothing to interpolate, so this is a value it was told to keep as it is.
      this.add("host_path", service, raw);
      return;
    }
    const path = isAbsolute(raw) ? posix.normalize(raw) : posix.normalize(join(from, raw));
    const root = posix.normalize(this.scope.projectDirectory).replace(/\/+$/, "");
    if (path === root || path.startsWith(`${root}/`)) {
      this.insidePaths.push({ service, path });
      return;
    }
    const risk = bindMountRisk(path.replace(/\/+$/, "") || "/", this.scope.dataDir);
    this.add(
      risk === "docker-socket" ? "docker_socket" : risk === "data-directory" ? "data_directory" : "host_path",
      service,
      path,
    );
  }
}

/** The host side of a mount, in the long form Compose resolves to, or the short form a test may give. */
function mountOf(entry: unknown): { type: string; source: string | null; readOnly: boolean } {
  if (isRecord(entry)) {
    return {
      type: String(entry.type ?? "volume"),
      source: typeof entry.source === "string" ? entry.source : null,
      readOnly: entry.read_only === true,
    };
  }
  const text = String(entry);
  const [source = "", , mode = ""] = text.split(":");
  if (!text.includes(":")) {
    return { type: "volume", source: null, readOnly: false };
  }
  return {
    type: source.startsWith("/") || source.startsWith(".") || source.startsWith("~") ? "bind" : "volume",
    source,
    readOnly: mode.split(",").includes("ro"),
  };
}

/** A namespace setting that shares the server's, or a container's outside the stack. */
const sharesOutside = (value: unknown): boolean =>
  typeof value === "string" && (value === "host" || value.startsWith("container:"));

function inspectBuild(name: string, build: unknown, found: Collector): void {
  if (!isRecord(build)) {
    return;
  }
  const context = typeof build.context === "string" ? build.context : ".";
  const local = !FETCHED.test(context);
  if (local) {
    found.input(name, context, "context", false);
    // BuildKit reads `Dockerfile` from the context when nothing else is named, and its ignore file beside it.
    if (typeof build.dockerfile_inline !== "string") {
      const from = isAbsolute(context) ? context : join(found.directory, context);
      found.input(
        name,
        typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile",
        "dockerfile",
        false,
        from,
      );
    }
  }
  const extra = isRecord(build.additional_contexts) ? Object.values(build.additional_contexts) : [];
  for (const value of extra) {
    if (typeof value === "string" && !FETCHED.test(value)) {
      found.input(name, value, "additional_contexts", false);
    }
    // A layout of images BuildKit reads from wherever it names on the panel's disk.
    if (typeof value === "string" && /^oci-layout:\/\//i.test(value)) {
      found.add("host_path", name, `additional_contexts: ${value}`);
    }
    const image = typeof value === "string" ? contextImage(value) : null;
    if (image !== null && isForeignImage(image, found.project)) {
      found.add("foreign_image", name, image);
    }
  }
  // Whatever form Compose gives the keys back in, every path they may name is read; none is guessed at.
  const keys = sshPaths(build.ssh);
  if (keys === null) {
    found.add("escapes_stack", name, `build.ssh: ${describeSsh(build.ssh)}`);
  }
  for (const path of keys ?? []) {
    found.input(name, path, "ssh", false);
  }
  for (const [field, entries] of [
    ["cache_from", build.cache_from],
    ["cache_to", build.cache_to],
  ] as const) {
    for (const entry of asList(entries).map(String)) {
      const fields = entry.split(",").map((part) => part.split("="));
      if (fields.some(([key, value]) => key === "type" && value === "local")) {
        for (const [key, value] of fields) {
          if ((key === "src" || key === "dest") && value !== undefined) {
            found.input(name, value, field, key === "dest");
          }
        }
      }
    }
  }
  if (build.network === "host") {
    found.add("host_namespace", name, "build.network: host");
  }
  if (isSet(build.privileged)) {
    found.add("privileged", name, "build.privileged");
  }
  const entitlements = asList(build.entitlements).map(String);
  if (entitlements.length > 0) {
    found.add("privileged", name, `build.entitlements: ${entitlements.join(", ")}`);
  }
  for (const request of attestationRequests(build)) {
    found.add("build_attestation", name, request);
  }
}

/** A build names its image within the stack, and nothing runs what only another project has. */
function inspectImages(name: string, service: Record_, found: Collector, stack: string): void {
  const image = typeof service.image === "string" ? service.image : null;
  if (isRecord(service.build)) {
    for (const ref of [image, ...asList(service.build.tags).map(String)]) {
      if (ref !== null && !isStackImageName(ref, stack)) {
        found.add("foreign_image", name, ref);
      }
    }
  } else if (image !== null && isForeignImage(image, found.project)) {
    found.add("foreign_image", name, image);
  }
}

function inspectService(
  name: string,
  service: Record_,
  config: Record_,
  found: Collector,
  stack: string,
): void {
  inspectImages(name, service, found, stack);
  inspectNames(name, service, config, found, stack);
  if (isSet(service.privileged)) {
    found.add("privileged", name);
  }
  for (const hook of ["post_start", "pre_stop"] as const) {
    if (asList(service[hook]).some((entry) => isRecord(entry) && isSet(entry.privileged))) {
      found.add("privileged", name, hook);
    }
  }
  for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const) {
    if (sharesOutside(service[key])) {
      found.add("host_namespace", name, `${key}: ${String(service[key])}`);
    }
  }
  if (service.network_mode === "host") {
    found.add("host_namespace", name, "network_mode: host");
  }
  if (isSet(service.cgroup_parent)) {
    found.add("host_namespace", name, `cgroup_parent: ${String(service.cgroup_parent)}`);
  }
  if (isSet(service.use_api_socket)) {
    found.add("docker_socket", name, "use_api_socket");
  }
  const capabilities = asList(service.cap_add).map(String).sort();
  if (capabilities.length > 0) {
    found.add("capabilities", name, capabilities.join(", "));
  }
  const devices = asList(service.devices).map((device) =>
    isRecord(device) ? String(device.source ?? "") : String(device).split(":")[0],
  );
  if (devices.length > 0) {
    found.add("devices", name, devices.join(", "));
  }
  const cgroupRules = asList(service.device_cgroup_rules).map(String);
  if (cgroupRules.length > 0) {
    found.add("devices", name, `device_cgroup_rules: ${cgroupRules.join(", ")}`);
  }
  if (isSet(service.gpus)) {
    found.add("devices", name, "gpus");
  }
  const resources =
    isRecord(service.deploy) && isRecord(service.deploy.resources) ? service.deploy.resources : {};
  const reservations = isRecord(resources.reservations) ? resources.reservations : {};
  if (asList(reservations.devices).length > 0) {
    found.add("devices", name, "deploy.resources.reservations.devices");
  }
  const relaxed = asList(service.security_opt)
    .map(String)
    .filter((option) => !TIGHTENING_OPTION.test(option.trim()));
  if (relaxed.length > 0) {
    found.add("security_options", name, relaxed.join(", "));
  }
  if (isSet(service.runtime)) {
    found.add("security_options", name, `runtime: ${String(service.runtime)}`);
  }

  const volumes = isRecord(config.volumes) ? config.volumes : {};
  for (const entry of asList(service.volumes)) {
    const { type, source, readOnly } = mountOf(entry);
    if (type === "bind" && source !== null) {
      // A read-only bind stays so in every container: `volumes_from` can narrow a mode, never widen it.
      found.mount(name, source, !readOnly);
    } else if (type === "volume" && source !== null && !ownVolume(source, volumes, stack)) {
      found.add("external_resource", name, source);
    } else if (type === "image") {
      if (source !== null && isForeignImage(source, found.project)) {
        found.add("foreign_image", name, source);
      }
    } else if (type !== "bind" && type !== "volume" && type !== "tmpfs") {
      found.add("external_resource", name, `${type}: ${source ?? ""}`);
    }
  }
  for (const entry of asList(service.volumes_from).map(String)) {
    if (entry.startsWith("container:")) {
      found.add("external_resource", name, entry);
    }
  }
  for (const entry of asList(service.external_links).map(String)) {
    found.add("external_resource", name, entry);
  }
  for (const entry of asList(service.env_file)) {
    const path = isRecord(entry) ? entry.path : entry;
    if (typeof path === "string") {
      found.file(name, path);
    }
  }
  if (isRecord(service.credential_spec) && typeof service.credential_spec.file === "string") {
    found.path(name, service.credential_spec.file);
  }
  inspectBuild(name, service.build, found);

  if (service.provider !== undefined) {
    const type = isRecord(service.provider) ? service.provider.type : service.provider;
    found.add("runs_program", name, `provider: ${String(type)}`);
  }
  if (service.models !== undefined) {
    found.add("runs_program", name, "models");
  }
}

/**
 * Every name a child answers to on its networks, besides the address the panel gives it: its own,
 * its container's, and its aliases, from whichever file they came. On the proxy's network a child
 * takes no alias but the panel's.
 */
function inspectNames(
  name: string,
  service: Record_,
  config: Record_,
  found: Collector,
  stack: string,
): void {
  if (isReservedName(name)) {
    found.add("foreign_name", name, name);
  }
  if (typeof service.container_name === "string" && !isStackContainerName(service.container_name, stack)) {
    found.add("foreign_name", name, `container_name: ${service.container_name}`);
  }
  // Docker answers for a container's hostname on every network it joins, as for an alias.
  if (typeof service.hostname === "string" && isReservedName(service.hostname)) {
    found.add("foreign_name", name, `hostname: ${service.hostname}`);
  }
  if (!isRecord(service.networks)) {
    return;
  }
  const declared = isRecord(config.networks) ? config.networks : {};
  const own = composeChildAddress(stack, name);
  for (const [key, attachment] of Object.entries(service.networks)) {
    const network = declared[key];
    const proxy =
      (isRecord(network) && typeof network.name === "string" ? network.name : key) ===
      projectProxyNetworkName(found.project);
    for (const alias of isRecord(attachment) ? asList(attachment.aliases).map(String) : []) {
      if (alias !== own && (proxy || isReservedName(alias))) {
        found.add("foreign_name", name, `aliases: ${alias}`);
      }
    }
  }
}

/**
 * The attestations a build asks for. BuildKit makes one by running an image of its own, the generator
 * an `sbom` names or its default one, which none of the checks on the build's images ever see; and
 * Compose hands a `provenance` value over as written, so that one can name a generator too. Only
 * `false` asks for nothing.
 */
export function attestationRequests(build: Record_): string[] {
  return (["sbom", "provenance"] as const).flatMap((key) => {
    const value = build[key];
    return value === undefined || value === false || value === "false"
      ? []
      : [`build.${key}: ${String(value)}`];
  });
}

/** Options that make Docker's local driver mount folders of the server: a bind, an overlay's layers. */
const HOST_FOLDER_OPTIONS = new Set(["bind", "rbind", "lowerdir", "upperdir", "workdir"]);
/** Network shares, whose device names the remote side: `:/export` with `addr=`, or `//server/share`. */
const NETWORK_TYPES = new Set(["nfs", "nfs4", "cifs"]);

/**
 * A local volume whose options reach the server's own folders or disks: a bind of its device, an
 * overlay of host folders, a disk or any other local filesystem. Compose keeps such a volume as it was
 * made when the file changes, and Docker reports it in a container's mounts by the volume's own folder,
 * so what it reaches can't be told from either: refused. Only a tmpfs and a network share are taken.
 */
export function bindsAFolder(volume: Record_): boolean {
  const local = volume.driver === undefined || volume.driver === null || volume.driver === "local";
  if (!local || !isRecord(volume.driver_opts) || Object.keys(volume.driver_opts).length === 0) {
    return false;
  }
  const options = volume.driver_opts;
  const keys = String(options.o ?? "")
    .split(",")
    .map((option) => (option.split("=", 1)[0] ?? "").trim().toLowerCase());
  if (keys.some((key) => HOST_FOLDER_OPTIONS.has(key))) {
    return true;
  }
  const type = String(options.type ?? "")
    .trim()
    .toLowerCase();
  const device = String(options.device ?? "").trim();
  if (type === "tmpfs") {
    return false;
  }
  if (NETWORK_TYPES.has(type)) {
    return !(device.startsWith(":") || device.startsWith("//"));
  }
  return true;
}

/** A named volume Compose made for this stack, rather than one it attaches to by name. */
function ownVolume(source: string, volumes: Record_, stack: string): boolean {
  const declared = volumes[source];
  if (!isRecord(declared)) {
    return declared === undefined || declared === null;
  }
  const external = declared.external !== undefined && declared.external !== false;
  const name = typeof declared.name === "string" ? declared.name : `${stack}_${source}`;
  return !external && name === `${stack}_${source}`;
}

/**
 * Reads what Compose resolved for a stack. Host access comes out in the same codes as the file's own
 * check, so that a person confirms them alike. Paths are judged where they really lead.
 */
export function inspectResolved(config: Record_, scope: ResolvedScope): ResolvedInspection {
  const found = new Collector(scope);
  const services = isRecord(config.services) ? config.services : {};
  for (const [name, service] of Object.entries(services)) {
    if (isRecord(service)) {
      inspectService(name, service, config, found, scope.stack);
    }
  }
  if (isRecord(config.volumes)) {
    for (const [key, value] of Object.entries(config.volumes)) {
      if (!isRecord(value)) {
        continue;
      }
      if (!ownVolume(key, config.volumes, scope.stack)) {
        found.add("external_resource", null, key);
      }
      const device = isRecord(value.driver_opts) ? value.driver_opts.device : undefined;
      if (bindsAFolder(value)) {
        found.add("bind_volume", null, key);
      } else if (device !== undefined) {
        found.add("host_path", null, String(device));
      }
    }
  }
  for (const key of ["secrets", "configs"] as const) {
    const section = config[key];
    if (!isRecord(section)) {
      continue;
    }
    for (const [name, value] of Object.entries(section)) {
      if (!isRecord(value)) {
        continue;
      }
      if (typeof value.file === "string") {
        // Compose mounts the file into the children that use it, as it mounts a volume's source.
        found.mount(null, value.file, false);
      }
      if (value.external !== undefined && value.external !== false) {
        found.add("external_resource", null, `${key}: ${name}`);
      }
    }
  }
  if (isRecord(config.models)) {
    for (const model of Object.keys(config.models)) {
      found.add("runs_program", null, `models: ${model}`);
    }
  }
  found.ownFolder();
  return {
    issues: found.issues,
    insidePaths: found.insidePaths,
    mounts: found.mounts,
    files: found.files,
    inputs: found.inputs,
  };
}

/** One line per thing a person confirms, the same however the configuration was ordered. */
export function accessFacts(issues: readonly ComposeIssue[]): string[] {
  return [
    ...new Set(
      issues
        .filter((entry) => entry.severity === "host")
        .map((entry) => `${entry.code}|${entry.service ?? ""}|${entry.detail ?? ""}`),
    ),
  ].sort();
}

/**
 * What decides what runs in a child: its image or what builds it, the program it starts, and what it
 * tells that program. Each of them, changed, runs something else with the same access.
 */
const WHAT_RUNS = [
  "image",
  "build",
  "command",
  "entrypoint",
  "environment",
  "env_file",
  "working_dir",
  "user",
  "healthcheck",
  "post_start",
  "pre_stop",
] as const;

/** The same value for the same configuration, whatever order its keys came in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** A file the stack is read from, by its path from the stack's folder, and a digest of what it holds. */
export type FileDigest = readonly [path: string, digest: string];

/**
 * What an administrator's confirmation is bound to: every way the stack reaches the server, what runs
 * in each child that reaches it (all of them, for what the stack reaches as a whole, such as a secret
 * read from the server), and every file the stack is read from. An image, a command, a variable or a
 * file that changes any of it asks again, though what the stack reaches stays the same.
 */
export function confirmationFingerprint(
  access: readonly ComposeIssue[],
  config: Record_,
  files: readonly FileDigest[],
): string {
  const reaching = access.filter((entry) => entry.severity === "host");
  const everyChild = reaching.some((entry) => entry.service === null);
  const holders = new Set(reaching.map((entry) => entry.service));
  const services = isRecord(config.services) ? config.services : {};
  const children = Object.keys(services)
    .filter((name) => everyChild || holders.has(name))
    .sort()
    .map((name) => {
      const child = isRecord(services[name]) ? services[name] : {};
      return [name, Object.fromEntries(WHAT_RUNS.map((key) => [key, child[key] ?? null]))];
    });
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify(canonical({ facts: accessFacts(access), children, files: sorted })))
    .digest("hex");
}
