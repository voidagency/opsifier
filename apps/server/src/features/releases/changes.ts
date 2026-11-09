import type { ConfigChange, ConfigChangeArea } from "@opsifier/contract";

/**
 * What separates two records of an applied configuration, in the words a person would use. Pure, and
 * careful about one thing: a record holds resolved secrets, so variables and file contents are named
 * and never quoted, and a value is only repeated where it is known not to be one.
 */

type Fields = Record<string, unknown>;

const asFields = (value: unknown): Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every leaf under `value` by its path. A list is one leaf: its order can mean something. */
function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      flatten(inner, path === "" ? key : `${path}.${key}`, into);
    }
    return;
  }
  into.set(path, typeof value === "string" ? value : JSON.stringify(value));
}

const flattened = (value: unknown): Map<string, string> => {
  const leaves = new Map<string, string>();
  flatten(value, "", leaves);
  return leaves;
};

function changeOf(
  area: ConfigChangeArea,
  name: string,
  before: string | undefined,
  after: string | undefined,
): ConfigChange {
  return {
    area,
    name,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before: before ?? null,
    after: after ?? null,
  };
}

/** A difference that is only ever said to exist. */
const unquoted = (change: ConfigChange): ConfigChange => ({ ...change, before: null, after: null });

function diffMaps(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  describe: (name: string, was: string | undefined, is: string | undefined) => ConfigChange | null,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(name);
    const is = after.get(name);
    if (was !== is) {
      const change = describe(name, was, is);
      if (change !== null) {
        changes.push(change);
      }
    }
  }
  return changes;
}

/** `KEY=value` lines to a map. The last of a name wins, as it does in the container. */
function variables(env: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of asList(env)) {
    if (typeof entry === "string") {
      const separator = entry.indexOf("=");
      map.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }
  return map;
}

const diffVariables = (before: Map<string, string>, after: Map<string, string>): ConfigChange[] =>
  diffMaps(before, after, (name, was, is) => unquoted(changeOf("environment", name, was, is)));

function commandLine(container: Fields): string | undefined {
  const words = [...asList(container.Command), ...asList(container.Args)];
  return words.length === 0 ? undefined : words.map(String).join(" ");
}

const NANOS_PER_CORE = 1_000_000_000;
const MEBIBYTE = 1024 * 1024;

const RESOURCES: Readonly<Record<string, { name: string; show: (value: number) => string }>> = {
  "Limits.NanoCPUs": { name: "cpu-limit", show: (value) => `${value / NANOS_PER_CORE}` },
  "Limits.MemoryBytes": { name: "memory-limit", show: (value) => `${value / MEBIBYTE} MiB` },
  "Limits.Pids": { name: "process-limit", show: String },
  "Reservations.NanoCPUs": { name: "cpu-reservation", show: (value) => `${value / NANOS_PER_CORE}` },
  "Reservations.MemoryBytes": { name: "memory-reservation", show: (value) => `${value / MEBIBYTE} MiB` },
};

function diffResources(before: unknown, after: unknown): ConfigChange[] {
  return diffMaps(flattened(before), flattened(after), (path, was, is) => {
    const known = RESOURCES[path];
    const show = (value: string | undefined) =>
      value === undefined ? undefined : known?.show(Number(value));
    return known === undefined
      ? changeOf("resources", path, was, is)
      : changeOf("resources", known.name, show(was), show(is));
  });
}

interface Mount {
  type: string;
  source: string;
  target: string;
  readOnly: boolean;
}

function mountsOf(container: Fields): Mount[] {
  return asList(container.Mounts).map((value) => {
    const mount = asFields(value);
    return {
      type: String(mount.Type),
      source: String(mount.Source ?? ""),
      target: String(mount.Target),
      readOnly: mount.ReadOnly === true,
    };
  });
}

/** A record from before file contents were part of it has no opinion on them. */
const fileHashes = (effective: Fields): Map<string, string> | null =>
  effective.files === undefined
    ? null
    : new Map(
        asList(effective.files).map((value) => {
          const file = asFields(value);
          return [String(file.path), String(file.sha256)];
        }),
      );

function describeMount(mount: Mount, volumePrefix: string): string {
  const source =
    mount.type === "volume" && mount.source.startsWith(volumePrefix)
      ? mount.source.slice(volumePrefix.length)
      : mount.source;
  return mount.readOnly ? `${source} (read-only)` : source;
}

/** Mounts by where they appear in the container, since that is what the app sees. */
function diffMounts(
  before: { mounts: Mount[]; hashes: ReadonlyMap<string, string> | null },
  after: { mounts: Mount[]; hashes: ReadonlyMap<string, string> | null },
  volumePrefix: string,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const targets = [...new Set([...before.mounts, ...after.mounts].map((mount) => mount.target))].sort();
  const isFile = (mount: Mount, hashes: ReadonlyMap<string, string> | null) =>
    hashes?.has(mount.source) === true;
  for (const target of targets) {
    const was = before.mounts.find((mount) => mount.target === target);
    const is = after.mounts.find((mount) => mount.target === target);
    const asFile =
      (was !== undefined && isFile(was, before.hashes)) || (is !== undefined && isFile(is, after.hashes));
    if (asFile) {
      const changed =
        was === undefined ||
        is === undefined ||
        (before.hashes !== null &&
          after.hashes !== null &&
          before.hashes.get(was.source) !== after.hashes.get(is.source));
      if (changed) {
        changes.push(unquoted(changeOf("files", target, was?.target, is?.target)));
      }
    } else if (JSON.stringify(was) !== JSON.stringify(is)) {
      const show = (mount: Mount | undefined) =>
        mount === undefined ? undefined : describeMount(mount, volumePrefix);
      changes.push(changeOf("volumes", target, show(was), show(is)));
    }
  }
  return changes;
}

function ports(endpoint: unknown): Map<string, string> {
  return new Map(
    asList(asFields(endpoint).Ports).map((value) => {
      const port = asFields(value);
      return [`${String(port.PublishedPort)}/${String(port.Protocol ?? "tcp")}`, String(port.TargetPort)];
    }),
  );
}

/** Which networks a task joins, readable. */
function networkTargets(networks: unknown): string | undefined {
  const targets = asList(networks).map((network) => String(asFields(network).Target));
  return targets.length === 0 ? undefined : targets.sort().join(", ");
}

/** Compiled from the mounts or the service's own name, so saying those changed says this too. */
const SAID_ELSEWHERE =
  /^(?:Name$|Labels\.|TaskTemplate\.Placement\.|TaskTemplate\.ForceUpdate$|TaskTemplate\.Networks$|TaskTemplate\.Resources\.|TaskTemplate\.ContainerSpec\.(?:Image|Env|Mounts|Command|Args)$|Mode\.Replicated\.Replicas$|EndpointSpec\.Ports$)/;

/** The Swarm settings nothing above speaks for. Anything added to the compiler is caught here. */
function diffAdvanced(before: unknown, after: unknown): ConfigChange[] {
  const remainder = (value: unknown) =>
    new Map([...flattened(value)].filter(([path]) => !SAID_ELSEWHERE.test(path)));
  return diffMaps(remainder(before), remainder(after), (path, was, is) =>
    changeOf("advanced", path.replace(/^TaskTemplate\.(?:ContainerSpec\.)?/, ""), was, is),
  );
}

function diffSwarm(before: Fields, after: Fields): ConfigChange[] {
  const wasSpec = asFields(before.swarm);
  const isSpec = asFields(after.swarm);
  const wasTask = asFields(wasSpec.TaskTemplate);
  const isTask = asFields(isSpec.TaskTemplate);
  const wasContainer = asFields(wasTask.ContainerSpec);
  const isContainer = asFields(isTask.ContainerSpec);
  const changes: ConfigChange[] = [];

  if (wasContainer.Image !== isContainer.Image) {
    changes.push(
      changeOf(
        "image",
        "",
        wasContainer.Image === undefined ? undefined : String(wasContainer.Image),
        isContainer.Image === undefined ? undefined : String(isContainer.Image),
      ),
    );
  }
  changes.push(...diffVariables(variables(wasContainer.Env), variables(isContainer.Env)));

  const wasCommand = commandLine(wasContainer);
  const isCommand = commandLine(isContainer);
  if (wasCommand !== isCommand) {
    changes.push(changeOf("command", "", wasCommand, isCommand));
  }

  const wasReplicas = asFields(asFields(wasSpec.Mode).Replicated).Replicas;
  const isReplicas = asFields(asFields(isSpec.Mode).Replicated).Replicas;
  if (wasReplicas !== isReplicas) {
    changes.push(
      changeOf(
        "replicas",
        "",
        wasReplicas === undefined ? undefined : String(wasReplicas),
        isReplicas === undefined ? undefined : String(isReplicas),
      ),
    );
  }

  const wasNetworks = networkTargets(wasTask.Networks);
  const isNetworks = networkTargets(isTask.Networks);
  if (wasNetworks !== isNetworks) {
    changes.push(changeOf("advanced", "networks", wasNetworks, isNetworks));
  }

  changes.push(...diffResources(wasTask.Resources, isTask.Resources));
  changes.push(
    ...diffMounts(
      { mounts: mountsOf(wasContainer), hashes: fileHashes(before) },
      { mounts: mountsOf(isContainer), hashes: fileHashes(after) },
      `${String(isSpec.Name ?? wasSpec.Name)}_`,
    ),
  );
  changes.push(
    ...diffMaps(ports(wasSpec.EndpointSpec), ports(isSpec.EndpointSpec), (port, was, is) =>
      changeOf("ports", port, was, is),
    ),
  );
  changes.push(...diffAdvanced(wasSpec, isSpec));
  return changes;
}

/** Where a source's fields are harmless to repeat, and what they are called. */
const QUOTABLE_SOURCE: ReadonlyMap<string, string> = new Map([
  ["source.type", "type"],
  ["source.repository", "repository"],
  ["source.url", "repository"],
  ["source.ref", "ref"],
  ["source.path", "path"],
  ["source.fileName", "archive"],
  ["config.type", "builder"],
  ["config.version", "builder-version"],
  ["config.file", "dockerfile-path"],
  ["envFilePath", "env-file"],
]);

/** Sealed credentials never reach a record. These are the fields that merely look like settings. */
const IGNORED_SOURCE = /^source\.(?:sizeBytes|uploadedAt|tokenRepository)$/;

function diffBuildInputs(before: unknown, after: unknown): ConfigChange[] {
  const remainder = (value: unknown) =>
    new Map([...flattened(value)].filter(([path]) => !IGNORED_SOURCE.test(path)));
  return diffMaps(remainder(before), remainder(after), (path, was, is) => {
    const area: ConfigChangeArea = path.startsWith("source.") ? "source" : "build";
    const name = QUOTABLE_SOURCE.get(path);
    return name === undefined
      ? unquoted(changeOf(area, path.replace(/^(?:source|config)\./, ""), was, is))
      : changeOf(area, name, was, is);
  });
}

const stackVariables = (pairs: unknown): Map<string, string> =>
  new Map(
    asList(pairs).map((value) => {
      const pair = asFields(value);
      return [String(pair.key), String(pair.value)];
    }),
  );

function diffStack(before: Fields, after: Fields): ConfigChange[] {
  const changes = diffMaps(flattened(before.source), flattened(after.source), (path, was, is) =>
    path === "content" ? unquoted(changeOf("compose", "file", was, is)) : changeOf("compose", path, was, is),
  );
  if (before.envFile !== after.envFile) {
    changes.push(
      changeOf("compose", "env-file", String(before.envFile ?? false), String(after.envFile ?? false)),
    );
  }
  changes.push(...diffVariables(stackVariables(before.env), stackVariables(after.env)));
  const wasNetworks = asList(before.networks).map(String).sort().join(", ");
  const isNetworks = asList(after.networks).map(String).sort().join(", ");
  if (wasNetworks !== isNetworks) {
    changes.push(changeOf("advanced", "networks", wasNetworks || undefined, isNetworks || undefined));
  }
  return changes;
}

/** What it would take to get from one record to the other. Empty when they would run the same. */
export function diffEffective(before: unknown, after: unknown): ConfigChange[] {
  const was = asFields(before);
  const is = asFields(after);
  return was.swarm === undefined && is.swarm === undefined
    ? diffStack(was, is)
    : [...diffSwarm(was, is), ...diffBuildInputs(was.build, is.build)];
}
