import { type EnvPair, parseEnvText } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import { projects, services } from "../../core/db/schema";

/** Sealing contexts: a value sealed for one purpose cannot be opened for another. */
export const ENV_CONTEXT = "environment";
export const BUILD_SECRET_CONTEXT = "build-secret";
const RETIRED_CONTEXT = "retired-values";

type Sealing = Pick<AppDeps, "secrets">;

export const sealEnv = (deps: Sealing, text: string): string =>
  text === "" ? "" : deps.secrets.seal(text, ENV_CONTEXT);

export const openEnv = (deps: Sealing, sealed: string): string =>
  sealed === "" ? "" : deps.secrets.unseal(sealed, ENV_CONTEXT);

/** The unsealed variables of one service and its project, for the length of one deploy. */
export function openEnvironment(
  deps: Sealing,
  project: { sealedEnv: string },
  spec: { sealedEnv: string },
): { project: string; service: string } {
  return { project: openEnv(deps, project.sealedEnv), service: openEnv(deps, spec.sealedEnv) };
}

/** What a page may know about a set of variables without anyone having asked to see them. */
export const envNames = (text: string): string[] => [...new Set(parseEnvText(text).map(({ key }) => key))];

export interface RetiredValue {
  name: string;
  value: string;
}

/** Enough for years of rotation, and a limit on what a row can grow to. */
const MAX_RETIRED_VALUES = 256;
const MAX_RETIRED_CHARS = 128 * 1024;
/** Shorter than this can't be told from ordinary output, so there is nothing to remember. */
const MIN_RETIRED_CHARS = 6;

export function openRetired(deps: Sealing, sealed: string | null): RetiredValue[] {
  return sealed === null ? [] : (JSON.parse(deps.secrets.unseal(sealed, RETIRED_CONTEXT)) as RetiredValue[]);
}

/**
 * Adds what just stopped being in use to what is remembered, newest last. Output of a value is no less
 * of a leak for the value having changed since: a running container still holds the old one.
 */
export function sealRetired(
  deps: Sealing,
  sealed: string | null,
  gone: readonly RetiredValue[],
  inUse: readonly string[] = [],
): string | null {
  const known = openRetired(deps, sealed);
  const fresh = gone.filter(
    ({ value }, index) =>
      value.length >= MIN_RETIRED_CHARS &&
      !inUse.includes(value) &&
      !known.some((entry) => entry.value === value) &&
      gone.findIndex((entry) => entry.value === value) === index,
  );
  if (fresh.length === 0) {
    return sealed;
  }
  const kept: RetiredValue[] = [];
  let chars = 0;
  for (const entry of [...known, ...fresh].reverse()) {
    chars += entry.value.length;
    if (kept.length < MAX_RETIRED_VALUES && chars <= MAX_RETIRED_CHARS) {
      kept.unshift(entry);
    }
  }
  return deps.secrets.seal(JSON.stringify(kept), RETIRED_CONTEXT);
}

/** The values of `before` that `after` no longer has, by value: a rename of a variable hides nothing new. */
export function valuesGone(before: readonly EnvPair[], after: readonly EnvPair[]): RetiredValue[] {
  const remaining = new Set(after.map(({ value }) => value));
  return before.filter(({ value }) => !remaining.has(value)).map(({ key, value }) => ({ name: key, value }));
}

/** Stands in for a variable's name on a value that is a secret whatever it was called. */
export const SECRET_VALUE = "secret";

const SEALED_SHAPE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;
const BUILDABLE_SOURCES = new Set(["git", "github", "dockerfile", "upload"]);

interface LegacySpec {
  env?: unknown;
  source?: { type?: string } | null;
  build?: { envFilePath?: string | null };
}

/**
 * Finishes the move to sealed variables and to separate build and runtime scopes. Runs at every boot and
 * only finds work once, on rows written by a version that kept these in clear and passed every variable
 * to every build. A row like that that builds is marked as still inheriting its variables, so that it
 * goes on building: what it hands to the build changes only when someone says so.
 */
export function sealStoredVariables(deps: Pick<AppDeps, "db" | "secrets" | "logger">): void {
  let sealedProjects = 0;
  let sealedServices = 0;
  deps.db.transaction((tx) => {
    for (const project of tx.select().from(projects).all()) {
      if (project.sealedEnv !== "" && !SEALED_SHAPE.test(project.sealedEnv)) {
        tx.update(projects)
          .set({ sealedEnv: sealEnv(deps, project.sealedEnv) })
          .where(eq(projects.name, project.name))
          .run();
        sealedProjects += 1;
      }
    }
    for (const row of tx.select().from(services).all()) {
      const { env, build, ...rest } = row.spec as LegacySpec & Record<string, unknown>;
      if (typeof env !== "string") {
        continue;
      }
      const buildable = BUILDABLE_SOURCES.has(rest.source?.type ?? "");
      tx.update(services)
        .set({
          spec: {
            ...rest,
            sealedEnv: sealEnv(deps, env),
            build: {
              ...build,
              inheritsRuntime: buildable,
              // A file like this was always written into the context, so it goes on being.
              envFileInImage: build?.envFilePath != null,
            },
          },
        })
        .where(and(eq(services.projectName, row.projectName), eq(services.name, row.name)))
        .run();
      sealedServices += 1;
    }
  });
  if (sealedProjects + sealedServices > 0) {
    deps.logger.info({ projects: sealedProjects, services: sealedServices }, "Sealed stored variables");
  }
}
