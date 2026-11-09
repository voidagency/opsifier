import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a setup run has made so far, written down so that an interrupted one can be finished or undone.
 * Each entry goes in the file before the step that makes it, so a run that dies at any point has
 * recorded at least what it was doing. Exact ownership comes from a label carrying the run's own id,
 * which a service or a network gets in the same call that creates it: there is no moment when something
 * of this run exists without saying so, and nothing else can ever carry that id.
 */
export const SETUP_RUN_LABEL = "opsifier.setup-run";

export const LOCK_FILE = "setup.lock";
export const STATE_FILE = "setup-state.json";
const OWN_FILES = new Set([LOCK_FILE, STATE_FILE, `${STATE_FILE}.tmp`]);

/** Written once the checks have passed: a run that was refused changed nothing and isn't "interrupted". */
export type Phase = "swarm" | "network" | "proxy" | "panel" | "waiting" | "complete";

export type Created =
  | { kind: "swarm"; nodeId: string | null }
  | { kind: "network"; name: string; id: string | null }
  | { kind: "service"; name: string; id: string | null }
  | { kind: "image"; ref: string }
  | { kind: "address" };

export interface SetupRecord {
  runId: string;
  phase: Phase;
  image: string;
  startedAt: string;
  at: string;
  /** The data directory's top-level names when the run began. Anything else in it is the run's doing. */
  dataDirBefore: string[];
  created: Created[];
}

/** What a run finds in its data directory, leaving out its own bookkeeping. */
export function dataDirEntries(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => !OWN_FILES.has(name))
    .sort();
}

/** The record of the last run, or null when there is none. A run from before records has no `runId`. */
export function readRecord(dataDir: string): (Partial<SetupRecord> & Pick<SetupRecord, "phase">) | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8")) as Partial<SetupRecord>;
    return typeof parsed.phase === "string" ? { ...parsed, phase: parsed.phase } : null;
  } catch {
    return null;
  }
}

function sameThing(a: Created, b: Created): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "service" && b.kind === "service") {
    return a.name === b.name;
  }
  if (a.kind === "network" && b.kind === "network") {
    return a.name === b.name;
  }
  return a.kind === "image" && b.kind === "image" ? a.ref === b.ref : true;
}

export class SetupLedger {
  private constructor(
    private readonly file: string,
    readonly record: SetupRecord,
  ) {}

  /** A run that was interrupted carries on under its own id, so what it already made stays its own. */
  static begin(dataDir: string, image: string, now: Date = new Date()): SetupLedger {
    const previous = readRecord(dataDir);
    const resumed = previous?.phase !== "complete" && previous?.runId !== undefined ? previous : null;
    const stamp = now.toISOString();
    return new SetupLedger(join(dataDir, STATE_FILE), {
      runId: resumed?.runId ?? randomBytes(8).toString("hex"),
      phase: resumed?.phase ?? "swarm",
      image,
      startedAt: resumed?.startedAt ?? stamp,
      at: stamp,
      dataDirBefore: resumed?.dataDirBefore ?? dataDirEntries(dataDir),
      created: resumed?.created ?? [],
    });
  }

  get runId(): string {
    return this.record.runId;
  }

  private write(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  /** Says how far the run got, so an interrupted one is reported instead of looking finished. */
  phase(name: Phase): void {
    this.record.phase = name;
    this.record.at = new Date().toISOString();
    this.write();
  }

  /** Records what is about to be made. Returns the entry, to fill in once Docker has answered. */
  intend<T extends Created>(thing: T): T {
    const existing = this.record.created.find((entry) => sameThing(entry, thing));
    if (existing !== undefined) {
      return existing as T;
    }
    this.record.created.push(thing);
    this.write();
    return thing;
  }

  /** Adds what Docker said about something this run made. */
  made(entry: Created, details: { id?: string; nodeId?: string | null }): void {
    Object.assign(entry, details);
    this.write();
  }
}
