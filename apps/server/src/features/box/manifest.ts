import { createHash } from "node:crypto";
import {
  BOX_BASE_IMAGE,
  BOX_MATRIX_REVISION,
  type BoxBuildReason,
  type BoxChange,
  type BoxManifest,
  type BoxModuleId,
  boxChangeKinds,
  boxModule,
} from "@opsifier/contract";
import type { StoredBox } from "./spec";

const RUNTIMES: readonly Exclude<BoxModuleId, "nginx">[] = ["node", "php", "python", "ruby"];

/** Spelled out when a version is missing from the matrix, rather than failing to describe the box. */
const NOT_IN_MATRIX = "not in the matrix";

const pinFor = (id: BoxModuleId, version: string): string =>
  boxModule(id).versions.find((candidate) => candidate.version === version)?.pin ?? NOT_IN_MATRIX;

function configurationFingerprint(box: StoredBox): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        processes: box.processes,
        hooks: box.hooks,
        documentRoot: box.modules.nginx?.documentRoot ?? null,
      }),
    )
    .digest("hex");
}

/** What a build of these settings contains, exactly as the image will. */
export function boxManifestOf(box: StoredBox): BoxManifest {
  const modules: BoxManifest["modules"] = {};
  for (const id of RUNTIMES) {
    const choice = box.modules[id];
    if (choice !== null) {
      modules[id] = {
        version: choice.version,
        pin: pinFor(id, choice.version),
        extensions: [...choice.extensions].sort(),
      };
    }
  }
  if (box.modules.nginx !== null) {
    const { defaultVersion } = boxModule("nginx");
    modules.nginx = { version: defaultVersion, pin: pinFor("nginx", defaultVersion), extensions: [] };
  }
  return {
    matrixRevision: BOX_MATRIX_REVISION,
    base: BOX_BASE_IMAGE,
    modules,
    configuration: configurationFingerprint(box),
  };
}

/** What a build of `desired` would change compared with `built`, the most urgent first. */
export function boxChanges(built: BoxManifest | null, desired: BoxManifest): BoxChange[] {
  if (built === null) {
    return [];
  }
  const changes: BoxChange[] = [];
  if (built.base !== desired.base) {
    changes.push({ kind: "security", subject: "base", from: built.base, to: desired.base });
  }
  for (const id of new Set([...Object.keys(built.modules), ...Object.keys(desired.modules)])) {
    const was = built.modules[id];
    const wanted = desired.modules[id];
    if (was === undefined) {
      changes.push({ kind: "modules", subject: id, from: null, to: wanted?.version ?? null });
    } else if (wanted === undefined) {
      changes.push({ kind: "modules", subject: id, from: was.version, to: null });
    } else {
      if (was.version !== wanted.version) {
        changes.push({ kind: "upgrade", subject: id, from: was.version, to: wanted.version });
      } else if (was.pin !== wanted.pin) {
        changes.push({ kind: "security", subject: id, from: was.pin, to: wanted.pin });
      }
      if (was.extensions.join() !== wanted.extensions.join()) {
        changes.push({
          kind: "modules",
          subject: `${id} extensions`,
          from: was.extensions.join(", ") || null,
          to: wanted.extensions.join(", ") || null,
        });
      }
    }
  }
  if (built.matrixRevision !== desired.matrixRevision) {
    changes.push({
      kind: "security",
      subject: "matrix",
      from: built.matrixRevision,
      to: desired.matrixRevision,
    });
  }
  if (built.configuration !== desired.configuration) {
    changes.push({ kind: "configuration", subject: "config", from: null, to: null });
  }
  return changes.sort((a, b) => boxChangeKinds.indexOf(a.kind) - boxChangeKinds.indexOf(b.kind));
}

/** Filed under the most urgent of its changes, so the history says at a glance what drove a rebuild. */
export function boxBuildReason(
  built: BoxManifest | null,
  changes: readonly BoxChange[],
  force: boolean,
): BoxBuildReason {
  if (built === null) {
    return "first";
  }
  const [first] = changes;
  if (first !== undefined) {
    return first.kind;
  }
  return force ? "forced" : "unchanged";
}
