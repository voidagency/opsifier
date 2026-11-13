import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";
import type { ComposeIssue, ComposeIssueCode } from "@opsifier/contract";
import { bindMountRisk } from "../services/compile/mounts";
import { contextImage, isAnotherProjectsImage, isStackImageName } from "./images";

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
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

const SEVERITY: Partial<Record<ComposeIssueCode, ComposeIssue["severity"]>> = {
  runs_program: "error",
  foreign_image: "error",
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
}

class Collector {
  readonly issues: ComposeIssue[] = [];
  readonly insidePaths: LocalPath[] = [];

  constructor(private readonly scope: ResolvedScope) {}

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
  path(service: string | null, raw: string, from = this.scope.projectDirectory): void {
    if (raw.includes("$")) {
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
function mountOf(entry: unknown): { type: string; source: string | null } {
  if (isRecord(entry)) {
    return {
      type: String(entry.type ?? "volume"),
      source: typeof entry.source === "string" ? entry.source : null,
    };
  }
  const text = String(entry);
  const separator = text.indexOf(":");
  if (separator === -1) {
    return { type: "volume", source: null };
  }
  const source = text.slice(0, separator);
  return {
    type: source.startsWith("/") || source.startsWith(".") || source.startsWith("~") ? "bind" : "volume",
    source,
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
    found.path(name, context);
    if (typeof build.dockerfile === "string") {
      found.path(name, build.dockerfile, isAbsolute(context) ? context : join(found.directory, context));
    }
  }
  const extra = isRecord(build.additional_contexts) ? Object.values(build.additional_contexts) : [];
  for (const value of extra) {
    if (typeof value === "string" && !FETCHED.test(value)) {
      found.path(name, value);
    }
    const image = typeof value === "string" ? contextImage(value) : null;
    if (image !== null && isAnotherProjectsImage(image, found.project)) {
      found.add("foreign_image", name, image);
    }
  }
  for (const entry of asList(build.ssh).map(String)) {
    const separator = entry.indexOf("=");
    if (separator !== -1) {
      for (const path of entry.slice(separator + 1).split(",")) {
        found.path(name, path);
      }
    }
  }
  for (const entry of [...asList(build.cache_from), ...asList(build.cache_to)].map(String)) {
    const fields = entry.split(",").map((field) => field.split("="));
    if (fields.some(([key, value]) => key === "type" && value === "local")) {
      for (const [key, value] of fields) {
        if ((key === "src" || key === "dest") && value !== undefined) {
          found.path(name, value);
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
  } else if (image !== null && isAnotherProjectsImage(image, found.project)) {
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
    const { type, source } = mountOf(entry);
    if (type === "bind" && source !== null) {
      found.path(name, source);
    } else if (type === "volume" && source !== null && !ownVolume(source, volumes, stack)) {
      found.add("external_resource", name, source);
    } else if (type === "image") {
      if (source !== null && isAnotherProjectsImage(source, found.project)) {
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
      found.path(name, path);
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
      if (device !== undefined) {
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
        found.path(null, value.file);
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
  return { issues: found.issues, insidePaths: found.insidePaths };
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

/** What an administrator's confirmation is bound to: every way the stack reaches the server. */
export const accessFingerprint = (issues: readonly ComposeIssue[]): string =>
  createHash("sha256")
    .update(JSON.stringify(accessFacts(issues)))
    .digest("hex");
