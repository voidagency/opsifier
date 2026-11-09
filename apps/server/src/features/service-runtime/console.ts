import {
  type ConsoleInfo,
  type ConsoleProgram,
  consoleProgram,
  projectName,
  resourceName,
  type ScriptSpec,
  type TerminalQuery,
  type TerminalServerFrame,
  terminalClientFrame,
  terminalQuery,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { type RawData, WebSocket } from "ws";
import type { Principal } from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { actions } from "../../core/db/schema";
import type { ExecOptions, ExecSession } from "../../core/docker";
import type { SocketAdmission, SocketRoute } from "../../core/realtime";
import { composeProject } from "../compose/names";
import { composeConsoleTasks, isComposeTarget } from "../compose/runtime";
import {
  attachConsoleRunExec,
  beginConsoleRun,
  endConsoleRun,
  hasActiveRun,
} from "../service-tabs/scripts/run";
import { qualifiedName } from "../services/compile";
import {
  type ConsoleSessionRow,
  forgetConsoleSession,
  listConsoleSessions,
  listServiceScripts,
  recordConsoleSession,
  type ServiceRef,
  serviceExists,
} from "./repo";

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

type SessionPlace = Pick<ExecOptions, "taskId" | "containerId">;

/**
 * Where a session may run. The driver holds a task to its service. A stack's children have no tasks,
 * and the daemon would exec into any container it is named, so this one is checked against the stack.
 */
async function sessionPlace(deps: AppDeps, target: ServiceRef, task: string): Promise<SessionPlace> {
  if (!isComposeTarget(deps, target)) {
    return { taskId: task };
  }
  const children = await deps.docker.listComposeContainers(composeProject(target));
  if (!children.some((child) => child.id === task && child.state === "running")) {
    throw new Error("This container is not a running part of this stack.");
  }
  return { containerId: task };
}

interface SessionInput {
  deps: AppDeps;
  socket: WebSocket;
  target: ServiceRef;
  query: TerminalQuery;
  command: ConsoleCommand;
  actorEmail: string;
  /** Set when this session runs a saved script, which holds it to the same rules as any run of it. */
  script?: ScriptSpec;
  onClosed: () => void;
}

/** One program in one task, joined to one WebSocket. Whichever side ends first ends the other. */
class TerminalSession {
  private exec: ExecSession | null = null;
  private disposed = false;
  private failure: string | null = null;
  /** The shell opened in place of the one asked for, which this container does not have. */
  private fallback: ConsoleProgram | null = null;
  private earlyInput: Buffer[] = [];
  private earlyInputBytes = 0;
  private clientPaused = false;
  private bufferTimer: NodeJS.Timeout | undefined;
  private limitTimer: NodeJS.Timeout | undefined;
  private timedOut = false;
  private readonly entryId: string;

  constructor(private readonly input: SessionInput) {
    const { deps, target, command, actorEmail } = input;
    // Written before anything runs, so a session is on record even if the panel dies during it.
    this.entryId = deps.actions.record({
      type: "service.console",
      title: this.entryTitle(command),
      projectName: target.projectName,
      serviceName: target.serviceName,
      actorEmail,
    }).id;
    if (input.script !== undefined) {
      beginConsoleRun(deps, target, {
        id: this.entryId,
        script: input.script,
        actorEmail,
        taskId: input.query.task,
      });
    }
  }

  private entryTitle(command: ConsoleCommand): string {
    const { target, query } = this.input;
    return `Console on ${target.projectName}/${target.serviceName}: ${command.label} in task ${query.task.slice(0, 12)}`;
  }

  start(): void {
    const { socket } = this.input;
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", () => this.dispose());
    void this.attach();
  }

  private async attach(): Promise<void> {
    const { deps, target, query } = this.input;
    try {
      const service = qualifiedName(target.projectName, target.serviceName);
      const place = await sessionPlace(deps, target, query.task);
      const command = await this.availableCommand(service, place);
      if (this.disposed) {
        return;
      }
      // Before anything runs: from here on, a dead panel leaves the next one a way to find this process.
      recordConsoleSession(deps.db, {
        id: this.entryId,
        projectName: target.projectName,
        serviceName: target.serviceName,
        task: query.task,
        startedAt: new Date(deps.now()),
      });
      const exec = await deps.docker.execAttach({
        service,
        ...place,
        marker: this.entryId,
        command: command.argv,
        tty: true,
        env: ["TERM=xterm-256color"],
        consoleSize: { columns: query.cols, rows: query.rows },
      });
      if (this.input.script !== undefined) {
        attachConsoleRunExec(deps, this.entryId, exec.id);
      }
      if (this.disposed) {
        this.terminate(exec);
        return;
      }
      this.exec = exec;
      this.pipe(exec);
      this.limit(exec);
    } catch (error) {
      this.forget();
      if (this.input.script !== undefined) {
        endConsoleRun(deps, this.entryId, { kind: "closed", exitCode: null });
      }
      this.fail(error instanceof Error ? error.message : "The session could not start.");
    }
  }

  /**
   * Bash is only in some images, and starting one that isn't there ends the session at once. What
   * the dialog offers can be out of date by now, so the shell is checked here, where it starts.
   */
  private async availableCommand(service: string, place: SessionPlace): Promise<ConsoleCommand> {
    const { deps, query, command } = this.input;
    if (query.program !== "bash" || (await shellStarts(deps, service, place, "bash"))) {
      return command;
    }
    const fallback = consoleCommand({ ...query, program: "sh" }, undefined);
    this.fallback = "sh";
    deps.actions.retitle(this.entryId, this.entryTitle(fallback));
    return fallback;
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

    this.send(this.fallback === null ? { t: "ready" } : { t: "ready", fallback: this.fallback });
    for (const chunk of this.earlyInput) {
      stream.write(chunk);
    }
    this.earlyInput = [];
    this.earlyInputBytes = 0;
  }

  /** A saved script is held to its maximum duration here too, however it was started. */
  private limit(exec: ExecSession): void {
    const { script } = this.input;
    if (script === undefined) {
      return;
    }
    this.limitTimer = setTimeout(() => {
      this.timedOut = true;
      this.terminate(exec);
    }, script.maxDurationSeconds * 1000);
    this.limitTimer.unref();
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
    this.forget();
    const code = await exec.exited().catch(() => null);
    this.endRun(code);
    this.send({ t: "exit", code });
    this.input.socket.close(1000, "Session ended");
  }

  /** Writes how a saved script's session ended. Nothing to write for a plain shell. */
  private endRun(exitCode: number | null): void {
    const { script, deps } = this.input;
    if (script === undefined) {
      return;
    }
    clearTimeout(this.limitTimer);
    endConsoleRun(
      deps,
      this.entryId,
      this.timedOut
        ? { kind: "time-limit", exitCode, maxDurationSeconds: script.maxDurationSeconds }
        : { kind: "exited", exitCode },
    );
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
    ending
      .then(() => this.forget())
      .catch((error: unknown) => {
        // Still on record, so the next boot tries again.
        this.input.deps.logger.debug({ err: error }, "Could not end an exec session");
      });
  }

  private forget(): void {
    try {
      forgetConsoleSession(this.input.deps.db, this.entryId);
    } catch (error) {
      // During shutdown the database may already be closed. The next boot then finds nothing to end.
      this.input.deps.logger.debug({ err: error }, "Could not forget a console session");
    }
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
    clearTimeout(this.limitTimer);
    if (this.exec !== null) {
      this.terminate(this.exec);
      this.exec = null;
      if (this.input.script !== undefined && !this.timedOut) {
        endConsoleRun(this.input.deps, this.entryId, { kind: "closed", exitCode: null });
      }
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
      let script: ScriptSpec | undefined;
      if (query.data.script !== undefined) {
        script = listServiceScripts(deps.db, target).find(({ name }) => name === query.data.script);
        if (script === undefined) {
          return refuse(404, "not_found", "This script does not exist.");
        }
        if (hasActiveRun(deps, target, script.name)) {
          return refuse(
            409,
            "script_already_running",
            `"${script.name}" is already running. Wait for it to finish or cancel it, then try again.`,
          );
        }
      }
      if (total >= MAX_SESSIONS || (perUser.get(user.id) ?? 0) >= MAX_SESSIONS_PER_USER) {
        return refuse(429, "too_many_sessions", "Too many consoles are open. Close one first.");
      }

      const command = consoleCommand(query.data, script?.script);
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
            script,
            onClosed: () => closed(user.id),
          }).start();
        },
      };
    },
  };
}

const ABANDONED_CONSOLE =
  "The panel stopped during this session. Its processes were ended when it came back.";

/** One console the last run of the panel left behind. Only its own marker, in its own container, is touched. */
async function endAbandonedConsole(deps: AppDeps, session: ConsoleSessionRow): Promise<void> {
  const target = { projectName: session.projectName, serviceName: session.serviceName };
  await deps.docker.terminateExec({
    service: qualifiedName(target.projectName, target.serviceName),
    ...(isComposeTarget(deps, target) ? { containerId: session.task } : { taskId: session.task }),
    marker: session.id,
  });
  forgetConsoleSession(deps.db, session.id);
  // The entry can have aged out of the activity log by now, which changes nothing about the process.
  if (
    deps.db.select({ id: actions.id }).from(actions).where(eq(actions.id, session.id)).get() !== undefined
  ) {
    deps.actions.conclude(session.id, { status: "failed", error: ABANDONED_CONSOLE });
  }
}

/**
 * Docker keeps a TTY exec running when its client goes away, and a panel that dies takes every session
 * object with it. So whatever is still on record at boot belongs to the run before this one: nothing else
 * can have opened a console yet. Failures stay on record for the next boot.
 */
export async function endAbandonedConsoles(deps: AppDeps): Promise<void> {
  const left = listConsoleSessions(deps.db);
  await Promise.all(
    left.map((session) =>
      endAbandonedConsole(deps, session).catch((error: unknown) => {
        deps.logger.warn({ err: error, session: session.id }, "Could not end an abandoned console");
      }),
    ),
  );
  // Host consoles run in a helper container, and no helper outlives the process that started it on purpose.
  const removed = await deps.docker.removeLeftoverHelpers().catch((error: unknown) => {
    deps.logger.warn({ err: error }, "Could not remove leftover helper containers");
    return 0;
  });
  if (left.length > 0 || removed > 0) {
    deps.logger.info({ consoles: left.length, helpers: removed }, "Ended what the last run left open");
  }
}

const CONSOLE_PROGRAMS = consoleProgram.options;

/** Long enough for a busy container to start a shell. One that can't is not worth waiting for. */
const SHELL_PROBE_TIMEOUT_MS = 3000;

/** A shell that exists starts, runs nothing and exits cleanly. One that does not fails to start. */
async function shellStarts(
  deps: AppDeps,
  service: string,
  place: SessionPlace,
  program: ConsoleProgram,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const exec = await deps.docker.execAttach({
      service,
      ...place,
      command: [...PROGRAM_COMMANDS[program], "-c", "exit 0"],
      tty: false,
    });
    exec.stream.resume();
    exec.stream.end();
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SHELL_PROBE_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([exec.exited(), expired])) === 0;
    } finally {
      exec.stream.destroy();
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Tasks of one image hold the same programs, so each image is only asked once. */
function shellProbe(deps: AppDeps, service: string) {
  const byImage = new Map<string, Promise<ConsoleProgram[]>>();
  return (image: string, place: SessionPlace): Promise<ConsoleProgram[]> => {
    const known = byImage.get(image);
    if (known !== undefined) {
      return known;
    }
    const programs = Promise.all(
      CONSOLE_PROGRAMS.map(async (program) =>
        (await shellStarts(deps, service, place, program)) ? [program] : [],
      ),
    ).then((found) => found.flat());
    byImage.set(image, programs);
    return programs;
  };
}

/** What the console dialog offers: what is running right now, the shells in it and the saved scripts. */
export async function getConsoleInfo(deps: AppDeps, target: ServiceRef): Promise<ConsoleInfo> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const programsOf = shellProbe(deps, name);
  if (isComposeTarget(deps, target)) {
    const containers = await composeConsoleTasks(deps, target);
    return {
      tasks: await Promise.all(
        containers.map(async ({ image, ...task }) => ({
          ...task,
          programs: await programsOf(image, { containerId: task.id }),
        })),
      ),
      scripts: [],
    };
  }
  const tasks = await deps.docker.listTasks({ service: name });
  return {
    tasks: await Promise.all(
      tasks
        .filter((task) => task.state === "running" && task.desiredState === "running")
        .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
        .map(async (task) => ({
          id: task.id,
          slot: task.slot,
          name: `${name}.${task.slot ?? task.nodeId ?? ""}.${task.id}`,
          programs: await programsOf(task.image, { taskId: task.id }),
        })),
    ),
    scripts: listServiceScripts(deps.db, target).map((script) => script.name),
  };
}
