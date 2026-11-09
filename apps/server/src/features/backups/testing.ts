import { Duplex } from "node:stream";
import { gunzipSync } from "node:zlib";
import { vi } from "vitest";
import type { ExecOptions, ExecSession } from "../../core/docker";
import type { TestContext } from "../../testing/harness";

/** What a simulated database does when asked to dump or to import. */
export interface FakeEngineOptions {
  version?: string;
  databases?: string[];
  sizeBytes?: number;
  /** What a dump writes to stdout. */
  dump?: Buffer | string;
  dumpExit?: number;
  importExit?: number;
  importStderr?: string;
  /** Leaves the completion marker out of the import's output, as a cut-short import would. */
  noMarker?: boolean;
}

export interface FakeEngine {
  options: FakeEngineOptions;
  dumps: ExecOptions[];
  imports: Array<{ options: ExecOptions; stdin: Buffer }>;
  /** Everything run, in order, as the command's first word. */
  commands: string[];
  /** Every script sent on stdin that the engine answered as a query, whole. */
  scripts: string[];
  /** Set to hold every dump back until `release()` is called. */
  holdDumps: boolean;
  /** How many dumps are being held back right now. */
  held: () => number;
  release: () => void;
  terminated: number;
  /** Runs just before an import is answered, so a test can change how that one import ends. */
  beforeImport?: (options: ExecOptions, index: number) => void;
}

function framed(streamType: 1 | 2, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const isDump = (command: string[]): boolean =>
  command[0] === "pg_dump" ||
  command[0] === "pg_dumpall" ||
  command[0] === "mysqldump" ||
  command[0] === "mariadb-dump" ||
  (command[0] === "/bin/sh" &&
    (command[2]?.includes("mongodump") === true || command[2]?.includes("SHOW CREATE USER") === true)) ||
  (command[0] === "mongosh" && command.includes("--eval"));

const isRestore = (command: string[]): boolean =>
  command[0] === "/bin/sh" && command[2]?.includes("mongorestore") === true;

/**
 * Replaces exec with a pretend database. It speaks Docker's framing, so the real demultiplexer is what
 * gets tested, and it keeps every import's bytes so a test can read what the database would have received.
 */
export function fakeEngine(context: TestContext, options: FakeEngineOptions = {}): FakeEngine {
  const waiting: Array<() => void> = [];
  const engine: FakeEngine = {
    options: {
      version: "18.1",
      databases: ["postgres", "app"],
      sizeBytes: 1024,
      dump: "-- dump of the database\nCREATE TABLE items (id int);\n",
      ...options,
    },
    dumps: [],
    imports: [],
    commands: [],
    scripts: [],
    holdDumps: false,
    held: () => waiting.length,
    release: () => {
      const work = waiting.shift();
      work?.();
    },
    terminated: 0,
  };

  vi.spyOn(context.docker, "execAttach").mockImplementation(async (execOptions): Promise<ExecSession> => {
    const command = execOptions.command;
    engine.commands.push(command[0] ?? "");
    const stdin: Buffer[] = [];
    let finish: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      finish = resolve;
    });

    const respond = (stream: Duplex, payload: Buffer, exitCode: number, stderr = "") => {
      if (stderr !== "") {
        stream.push(framed(2, Buffer.from(stderr, "utf8")));
      }
      if (payload.length > 0) {
        stream.push(framed(1, payload));
      }
      stream.push(null);
      finish(exitCode);
    };

    const session: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        stdin.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        callback();
        const work = () => {
          const input = Buffer.concat(stdin);
          const text = input.toString("utf8");
          if (isDump(command)) {
            engine.dumps.push(execOptions);
            respond(
              session,
              Buffer.from(engine.options.dump as Buffer | string),
              engine.options.dumpExit ?? 0,
            );
            return;
          }
          if (isRestore(command) || !text.includes("opsifier-ok")) {
            engine.beforeImport?.(execOptions, engine.imports.length);
            engine.imports.push({ options: execOptions, stdin: input });
            const importExit = engine.options.importExit ?? 0;
            const output = engine.options.noMarker || importExit !== 0 ? "" : "opsifier-restore-complete\n";
            respond(session, Buffer.from(output), importExit, engine.options.importStderr ?? "");
            return;
          }
          engine.scripts.push(text);
          respond(session, Buffer.from(queryAnswer(engine.options, text)), 0);
        };
        if (engine.holdDumps && isDump(command)) {
          waiting.push(work);
        } else {
          work();
        }
      },
    });

    return {
      stream: session,
      resize: async () => {},
      exited: () => exited,
      terminate: async () => {
        engine.terminated += 1;
        if (!session.destroyed) {
          session.destroy();
        }
        finish(143);
      },
    };
  });

  return engine;
}

function queryAnswer(options: FakeEngineOptions, query: string): string {
  const marker = "opsifier-ok\n";
  if (query.includes("server_version") || query.includes("VERSION()")) {
    return `${options.version}\n${marker}`;
  }
  if (
    query.includes("pg_database") ||
    query.includes("SHOW DATABASES") ||
    query.includes("schema_name") ||
    query.includes("listDatabases")
  ) {
    return `${(options.databases ?? []).join("\n")}\n${marker}`;
  }
  if (query.includes("pg_database_size") || query.includes("data_length") || query.includes("stats()")) {
    return `${options.sizeBytes}\n${marker}`;
  }
  if (query.includes("table_type") || query.includes("getCollectionNames")) {
    return `BASE TABLE\torders\n${marker}`;
  }
  return marker;
}

export const unzip = (data: Buffer): string => gunzipSync(data).toString("utf8");
