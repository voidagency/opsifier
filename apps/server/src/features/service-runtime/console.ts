import {
  type ConsoleInfo,
  type ConsoleProgram,
  consoleProgram,
  projectName,
  resourceName,
  type TerminalQuery,
  type TerminalServerFrame,
  terminalClientFrame,
  terminalQuery,
} from "@opsifier/contract";
import { type RawData, WebSocket } from "ws";
import type { Principal } from "../../core/auth";
import type { AppDeps } from "../../core/context";
import type { ExecSession } from "../../core/docker";
import type { SocketAdmission, SocketRoute } from "../../core/realtime";
import { qualifiedName } from "../services/compile";
import { listServiceScripts, type ServiceRef, serviceExists } from "./repo";

const PATH_PREFIX = "/api/v1/terminal/";

/** A paste larger than this is split up by the client. A frame larger than this ends the session. */
export const MAX_TERMINAL_FRAME_BYTES = 64 * 1024;
const MAX_SESSIONS_PER_USER = 4;
export const MAX_SESSIONS = 16;

/** Output held for a slow browser. Above the high mark nothing more is read from the program. */
const HIGH_WATER_BYTES = 512 * 1024;
const LOW_WATER_BYTES = 64 * 1024;
const BUFFER_POLL_MS = 25;
/** Keystrokes sent while the program is still starting, kept until it is ready for them. */
const MAX_EARLY_INPUT_BYTES = 64 * 1024;

const PROGRAM_COMMANDS: Record<ConsoleProgram, string[]> = {
  sh: ["/bin/sh"],
  bash: ["/bin/bash"],
};

export interface ConsoleCommand {
  /** The argument vector handed to Docker. Nothing is ever parsed by a shell on the panel's side. */
  argv: string[];
  label: string;
}

/** A script's text is one argument, and only the container's own shell ever interprets it. */
export function consoleCommand(query: TerminalQuery, scriptBody: string | undefined): ConsoleCommand {
  if (query.program !== undefined) {
    const argv = PROGRAM_COMMANDS[query.program];
    return { argv, label: argv.join(" ") };
  }
  return { argv: ["/bin/sh", "-c", scriptBody ?? ""], label: `script ${query.script ?? ""}` };
}

const refuse = (status: number, code: string, message: string): SocketAdmission => ({
  allowed: false,
  status,
  code,
  message,
});

function parseTerminalPath(path: string): ServiceRef | null {
  const [project, service, ...rest] = path.slice(PATH_PREFIX.length).split("/");
  if (
    rest.length > 0 ||
    !projectName.safeParse(project).success ||
    !resourceName.safeParse(service).success
  ) {
    return null;
  }
  return { projectName: project as string, serviceName: service as string };
}

interface SessionInput {
  deps: AppDeps;
  socket: WebSocket;
  target: ServiceRef;
  query: TerminalQuery;
  command: ConsoleCommand;
  actorEmail: string;
  onClosed: () => void;
}

/** One program in one task, joined to one WebSocket. Whichever side ends first ends the other. */
class TerminalSession {
  private exec: ExecSession | null = null;
  private disposed = false;
  private failure: string | null = null;
  private earlyInput: Buffer[] = [];
  private earlyInputBytes = 0;
  private clientPaused = false;
  private bufferTimer: NodeJS.Timeout | undefined;
  private readonly entryId: string;

  constructor(private readonly input: SessionInput) {
    const { deps, target, command, actorEmail, query } = input;
    // Written before anything runs, so a session is on record even if the panel dies during it.
    this.entryId = deps.actions.record({
      type: "service.console",
      title: `Console on ${target.projectName}/${target.serviceName}: ${command.label} in task ${query.task.slice(0, 12)}`,
      projectName: target.projectName,
      serviceName: target.serviceName,
      actorEmail,
    }).id;
  }

  start(): void {
    const { socket } = this.input;
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", () => this.dispose());
    void this.attach();
  }

  private async attach(): Promise<void> {
    const { deps, target, query, command } = this.input;
    try {
      const exec = await deps.docker.execAttach({
        service: qualifiedName(target.projectName, target.serviceName),
        taskId: query.task,
        command: command.argv,
        tty: true,
        env: ["TERM=xterm-256color"],
        consoleSize: { columns: query.cols, rows: query.rows },
      });
      if (this.disposed) {
        this.terminate(exec);
        return;
      }
      this.exec = exec;
      this.pipe(exec);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "The session could not start.");
    }
  }

  private pipe(exec: ExecSession): void {
    const { socket } = this.input;
    const { stream } = exec;
    stream.on("data", (chunk: Buffer) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(chunk, { binary: true });
        if (socket.bufferedAmount > HIGH_WATER_BYTES) {
          this.waitForBuffer(exec);
        }
      }
    });
    stream.once("close", () => void this.finish(exec));
    stream.once("end", () => void this.finish(exec));
    stream.on("error", (error: Error) => {
      this.input.deps.logger.debug({ err: error }, "Exec stream error");
    });

    this.send({ t: "ready" });
    for (const chunk of this.earlyInput) {
      stream.write(chunk);
    }
    this.earlyInput = [];
    this.earlyInputBytes = 0;
  }

  /** The browser is behind: stop reading the program until what is queued has left. */
  private waitForBuffer(exec: ExecSession): void {
    if (this.bufferTimer !== undefined) {
      return;
    }
    exec.stream.pause();
    this.bufferTimer = setInterval(() => {
      if (this.input.socket.bufferedAmount <= LOW_WATER_BYTES) {
        clearInterval(this.bufferTimer);
        this.bufferTimer = undefined;
        if (!this.clientPaused) {
          exec.stream.resume();
        }
      }
    }, BUFFER_POLL_MS);
  }

  private receive(data: RawData, isBinary: boolean): void {
    const bytes = data as Buffer;
    if (!isBinary) {
      this.control(bytes);
      return;
    }
    if (this.exec === null) {
      this.keepEarlyInput(bytes);
      return;
    }
    if (!this.exec.stream.write(bytes)) {
      const { socket } = this.input;
      socket.pause();
      this.exec.stream.once("drain", () => socket.resume());
    }
  }

  private keepEarlyInput(bytes: Buffer): void {
    this.earlyInputBytes += bytes.length;
    if (this.earlyInputBytes > MAX_EARLY_INPUT_BYTES) {
      this.input.socket.close(1009, "Too much input before the session started");
      return;
    }
    this.earlyInput.push(bytes);
  }

  private control(bytes: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      return;
    }
    const frame = terminalClientFrame.safeParse(value);
    const exec = this.exec;
    if (!frame.success || exec === null) {
      return;
    }
    switch (frame.data.t) {
      case "resize":
        // The process may be gone already, in which case there is nothing left to resize.
        exec.resize(frame.data.cols, frame.data.rows).catch(() => {});
        break;
      case "pause":
        this.clientPaused = true;
        exec.stream.pause();
        break;
      case "resume":
        this.clientPaused = false;
        if (this.bufferTimer === undefined) {
          exec.stream.resume();
        }
        break;
    }
  }

  /** The program ended by itself. */
  private async finish(exec: ExecSession): Promise<void> {
    if (this.disposed || this.exec === null) {
      return;
    }
    this.exec = null;
    const code = await exec.exited().catch(() => null);
    this.send({ t: "exit", code });
    this.input.socket.close(1000, "Session ended");
  }

  /** The session could not start: the reason goes to the terminal, where the person is looking. */
  private fail(message: string): void {
    this.failure = message;
    this.send({ t: "error", message });
    this.input.socket.close(1011, "Session failed");
  }

  private send(frame: TerminalServerFrame): void {
    const { socket } = this.input;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  /** Not waited for: a container that went away, or never answers, must not hold the session up. */
  private terminate(exec: ExecSession): void {
    const ending = exec.terminate?.() ?? Promise.resolve(exec.stream.destroy()).then(() => {});
    ending.catch((error: unknown) => {
      this.input.deps.logger.debug({ err: error }, "Could not end an exec session");
    });
  }

  /** Runs once for every session, however it ended. */
  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.bufferTimer);
    this.bufferTimer = undefined;
    this.earlyInput = [];
    if (this.exec !== null) {
      this.terminate(this.exec);
      this.exec = null;
    }
    this.input.onClosed();
    const { deps } = this.input;
    try {
      deps.actions.conclude(this.entryId, {
        status: this.failure === null ? "succeeded" : "failed",
        error: this.failure ?? undefined,
      });
    } catch (error) {
      // During shutdown the database may already be closed. The entry itself is on record.
      deps.logger.debug({ err: error }, "Could not conclude a console entry");
    }
  }
}

export interface TerminalRoute extends SocketRoute {
  /** How many sessions are open right now. */
  openSessions(): number;
}

/** `/api/v1/terminal/<project>/<service>`: authenticated by the hub, then restricted to administrators. */
export function createTerminalRoute(deps: AppDeps): TerminalRoute {
  const perUser = new Map<string, number>();
  let total = 0;

  const opened = (userId: string) => {
    total += 1;
    perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
  };
  const closed = (userId: string) => {
    total -= 1;
    const remaining = (perUser.get(userId) ?? 1) - 1;
    if (remaining > 0) {
      perUser.set(userId, remaining);
    } else {
      perUser.delete(userId);
    }
  };

  return {
    matches: (path) => path.startsWith(PATH_PREFIX),
    maxPayload: MAX_TERMINAL_FRAME_BYTES,
    openSessions: () => total,

    admit({
      url,
      principal,
    }: {
      url: URL;
      principal: Extract<Principal, { kind: "session" }>;
    }): SocketAdmission {
      const { user } = principal;
      if (user.role !== "admin") {
        return refuse(403, "admin_required", "Only an administrator can open a console.");
      }
      const target = parseTerminalPath(url.pathname);
      if (target === null) {
        return refuse(404, "not_found", "Not found.");
      }
      const query = terminalQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) {
        return refuse(400, "bad_request", "Choose a task and a program.");
      }
      if (!serviceExists(deps.db, target)) {
        return refuse(404, "not_found", "This service does not exist.");
      }
      let scriptBody: string | undefined;
      if (query.data.script !== undefined) {
        const script = listServiceScripts(deps.db, target).find(({ name }) => name === query.data.script);
        if (script === undefined) {
          return refuse(404, "not_found", "This script does not exist.");
        }
        scriptBody = script.script;
      }
      if (total >= MAX_SESSIONS || (perUser.get(user.id) ?? 0) >= MAX_SESSIONS_PER_USER) {
        return refuse(429, "too_many_sessions", "Too many consoles are open. Close one first.");
      }

      const command = consoleCommand(query.data, scriptBody);
      return {
        allowed: true,
        connect: (socket) => {
          opened(user.id);
          new TerminalSession({
            deps,
            socket,
            target,
            query: query.data,
            command,
            actorEmail: user.email,
            onClosed: () => closed(user.id),
          }).start();
        },
      };
    },
  };
}

const CONSOLE_PROGRAMS = consoleProgram.options;

/** What the console dialog offers: the tasks running right now, and the saved scripts. */
export async function getConsoleInfo(deps: AppDeps, target: ServiceRef): Promise<ConsoleInfo> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const tasks = await deps.docker.listTasks({ service: name });
  return {
    tasks: tasks
      .filter((task) => task.state === "running" && task.desiredState === "running")
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
      .map((task) => ({
        id: task.id,
        slot: task.slot,
        name: `${name}.${task.slot ?? task.nodeId ?? ""}.${task.id}`,
      })),
    programs: [...CONSOLE_PROGRAMS],
    scripts: listServiceScripts(deps.db, target).map((script) => script.name),
  };
}
