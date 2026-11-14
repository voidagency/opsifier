import { hostname } from "node:os";
import { ClientError, type Connection, connectionFromEnv, type PanelApi } from "@opsifier/client";
import type { PanelUser } from "@opsifier/contract";
import { readCredentials, writeCredentials } from "./credentials";
import { renderTable } from "./format";
import type { CommandContext, CommandResult } from "./shared";
import { noMoreArguments, usage } from "./shared";
import { sleep } from "./wait";

/** A connection that sends a person's session the way an API key is sent, but as `Session`. */
export function sessionConnection(panel: string, token: string): Connection {
  return { ...connectionFromEnv({ OPSIFIER_URL: panel, OPSIFIER_API_KEY: token }), scheme: "Session" };
}

export const sessionIsLive = (session: { expiresAt: string } | undefined, now = Date.now()): boolean =>
  session !== undefined && Date.parse(session.expiresAt) > now;

/**
 * `opsifier login --web`: the panel gives a code, a person approves it in a signed-in browser, and the
 * command line keeps the session it then hands over. Nothing secret is typed in the terminal.
 */
export async function loginWithBrowser(context: CommandContext, panel: string): Promise<CommandResult> {
  const { t } = context;
  const anonymous = context.connect({
    ...connectionFromEnv({ OPSIFIER_URL: panel, OPSIFIER_API_KEY: "-" }),
    apiKey: "",
  });
  const started = await anonymous.api.startCliLogin(hostname().slice(0, 120) || "opsifier");
  const link = new URL(started.verificationPath, panel).toString();
  context.warn(t("login.web.open", { code: started.userCode, link: context.styles.link(link) }));

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000, context.signal);
    let answer: Awaited<ReturnType<PanelApi["collectCliLogin"]>>;
    try {
      answer = await anonymous.api.collectCliLogin(started.deviceCode);
    } catch (error) {
      if (error instanceof ClientError && error.status === 410) {
        throw new ClientError("forbidden", error.message);
      }
      throw error;
    }
    if (answer.status === "pending") {
      continue;
    }
    const { credentials } = await readCredentials(context.credentialsFile);
    credentials.panels[panel] = {
      ...credentials.panels[panel],
      session: { token: answer.token, expiresAt: answer.expiresAt, email: answer.user.email },
    };
    credentials.current = panel;
    await writeCredentials(context.credentialsFile, credentials);
    return {
      data: { panel, user: answer.user.email, expiresAt: answer.expiresAt, file: context.credentialsFile },
      text: () =>
        [
          t("login.web.done", {
            panel,
            user: answer.user.email,
            until: new Date(answer.expiresAt).toLocaleString(),
          }),
          context.styles.dim(t("login.web.kept", { file: context.credentialsFile })),
        ].join("\n"),
    };
  }
  throw new ClientError("forbidden", t("login.web.expired"));
}

/** Accounts are a person's business: the session from `login --web`, never an API key. */
async function personApi(context: CommandContext): Promise<PanelApi> {
  const panel = context.client.panelOrigin;
  const { credentials } = await readCredentials(context.credentialsFile);
  const session = credentials.panels[panel]?.session;
  if (session === undefined || !sessionIsLive(session)) {
    throw new ClientError("not_configured", context.t("users.sessionNeeded", { panel }));
  }
  return context.connect(sessionConnection(panel, session.token)).api;
}

const ALL_PROJECTS = ["viewer", "operator", "none"] as const;

function allProjectsFlag(context: CommandContext): "viewer" | "operator" | null | undefined {
  const value = context.flags["all-projects"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !(ALL_PROJECTS as readonly string[]).includes(value)) {
    throw usage(context.t("usage.allProjects"));
  }
  return value === "none" ? null : (value as "viewer" | "operator");
}

function roleFlag(context: CommandContext): "admin" | "member" | undefined {
  const value = context.flags.role;
  if (value === undefined) {
    return undefined;
  }
  if (value !== "admin" && value !== "member") {
    throw usage(context.t("usage.role"));
  }
  return value;
}

async function findUser(context: CommandContext, api: PanelApi, email: string): Promise<PanelUser> {
  const user = (await api.users()).users.find(
    (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
  );
  if (user === undefined) {
    throw new ClientError("not_found", context.t("users.unknown", { email }));
  }
  return user;
}

function describe(context: CommandContext, user: PanelUser): string[] {
  const { t } = context;
  return [
    user.email,
    user.owner ? t("users.owner") : user.role === "admin" ? t("users.admin") : t("users.member"),
    user.allProjects ?? "-",
    user.twoFactorEnabled ? t("users.yes") : t("users.no"),
    user.active ? t("users.yes") : t("users.no"),
  ];
}

/** `opsifier users [invite | set | deactivate | activate]`. */
export async function usersCommand(context: CommandContext): Promise<CommandResult> {
  const { t } = context;
  const [verb, ...rest] = context.positionals;
  const api = await personApi(context);

  if (verb === undefined) {
    const { users } = await api.users();
    return {
      data: users,
      text: () =>
        renderTable(
          [
            t("users.email"),
            t("users.role"),
            t("users.allProjects"),
            t("users.twoFactor"),
            t("users.active"),
          ],
          users.map((user) => describe(context, user)),
        ),
    };
  }

  if (verb === "invite") {
    if (rest.length === 0) {
      throw usage(t("usage.inviteEmails"));
    }
    const channel = typeof context.flags.channel === "string" ? context.flags.channel : null;
    const allProjects = allProjectsFlag(context);
    const result = await api.inviteUsers({
      emails: rest,
      role: context.flags.admin === true ? "admin" : "member",
      ...(allProjects === undefined ? {} : { allProjects }),
      channel,
    });
    return {
      data: result,
      text: () =>
        result.results
          .map((entry) =>
            entry.outcome === "invited"
              ? entry.link === null
                ? t("users.invitedSent", { email: entry.email })
                : t("users.invitedLink", { email: entry.email, link: context.styles.link(entry.link) })
              : t(`users.outcome.${entry.outcome}`, { email: entry.email }),
          )
          .join("\n"),
    };
  }

  if (verb === "set") {
    const email = rest[0];
    if (email === undefined) {
      throw usage(t("usage.usersEmail", { verb }));
    }
    noMoreArguments(context, 2);
    const role = roleFlag(context);
    const allProjects = allProjectsFlag(context);
    if (role === undefined && allProjects === undefined) {
      throw usage(t("usage.usersSetNothing"));
    }
    const user = await findUser(context, api, email);
    const updated = await api.updateUser(user.id, {
      email: user.email,
      role: role ?? user.role,
      projects: user.projects,
      ...(allProjects === undefined ? {} : { allProjects }),
    });
    return {
      data: updated,
      text: () =>
        renderTable(
          [
            t("users.email"),
            t("users.role"),
            t("users.allProjects"),
            t("users.twoFactor"),
            t("users.active"),
          ],
          [describe(context, updated)],
        ),
    };
  }

  if (verb === "deactivate" || verb === "activate") {
    const email = rest[0];
    if (email === undefined) {
      throw usage(t("usage.usersEmail", { verb }));
    }
    noMoreArguments(context, 2);
    const user = await findUser(context, api, email);
    const updated = await api.setUserActive(user.id, verb === "activate");
    return {
      data: updated,
      text: () => t(verb === "activate" ? "users.activated" : "users.deactivated", { email: updated.email }),
    };
  }

  throw usage(t("usage.usersVerb"));
}

/** Ends the panel's side of a kept session, when there is one. A panel out of reach changes nothing here. */
export async function endKeptSession(context: CommandContext, panel: string): Promise<boolean> {
  const { credentials } = await readCredentials(context.credentialsFile);
  const session = credentials.panels[panel]?.session;
  if (session === undefined || !sessionIsLive(session)) {
    return false;
  }
  try {
    await context.connect(sessionConnection(panel, session.token)).api.logout();
    return true;
  } catch {
    return false;
  }
}
