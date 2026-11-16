import type { StudioAgent } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { findServiceById } from "../services/repo";
import { callAgent } from "./agent";
import { GIT_RELAY_PREFIX, gitTokenMatches } from "./agents";
import { githubKeyFor, hasGithubKeyFor } from "./github-keys";
import { GITHUB_SECRET } from "./projects";
import * as repo from "./repo";
import { readStudioSettings } from "./settings";

/**
 * The git of each project's own agent server goes through the panel. Its remote reads as
 * `<panel>/api/v1/studio/git/<project>.git`, and it signs in with a token that opens that address and
 * nothing else. The panel passes each request of git's smart HTTP protocol to the project's GitHub
 * repository with the GitHub token kept in the model agent server's secrets: the agent never holds it,
 * and cannot reach any other repository with what it has.
 */

const ACTIONS = new Set(["info/refs", "git-upload-pack", "git-receive-pack"]);
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const RELAY_PATH = /^([A-Za-z0-9_-]{1,64})(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** What goes to GitHub of the request, and comes back of its answer. */
const REQUEST_HEADERS = ["content-type", "content-encoding", "accept", "git-protocol", "user-agent"];
const ANSWER_HEADERS = ["content-type", "cache-control", "expires", "pragma"];
const TOKEN_TTL_MS = 5 * 60_000;

/** The relay's own routes, which check their own credential and stream their own bodies. */
export const isRelayPath = (path: string): boolean => path.startsWith(`${GIT_RELAY_PREFIX}/`);

const plain = (status: number, text: string, headers: Record<string, string> = {}): Response =>
  new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

const askForCredentials = (): Response =>
  plain(401, "Sign in with the project's own token.", {
    "WWW-Authenticate": 'Basic realm="Opsifier Studio"',
  });

/** The password of `Authorization: Basic`, the only part git's credential helper gives that matters. */
export function basicPassword(header: string | undefined): string | null {
  const encoded = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "")?.[1];
  if (encoded === undefined) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** Repositories whose Studio key GitHub refused lately: their git goes with the agent server's token. */
const keyRefusedUntil = new Map<string, number>();
const KEY_REFUSED_MS = 10 * 60 * 1000;

const tokens = new Map<string, { value: string; until: number }>();

/** For tests: the next request reads the token again. */
export function forgetGithubToken(): void {
  tokens.clear();
  keyRefusedUntil.clear();
}

/**
 * The GitHub token in the model agent server's secrets, read in its container. A token read is kept a
 * few minutes; a failed read is not, so that an agent server restarting is asked again at once.
 */
async function githubToken(deps: AppDeps, model: StudioAgent): Promise<string | null> {
  const key = `${model.project}/${model.service}`;
  const kept = tokens.get(key);
  if (kept !== undefined && kept.until > deps.now()) {
    return kept.value;
  }
  const { replies } = await callAgent(deps, model, [
    { method: "GET", path: `/api/settings/secrets/${GITHUB_SECRET}` },
  ]);
  const reply = replies[0];
  if (reply === undefined || reply.status === 0 || reply.status >= 500) {
    throw new Error("The agent server could not be asked for its GitHub token.");
  }
  let value: string | null = null;
  if (reply.status === 200) {
    const text = reply.text.trim();
    try {
      value = text.startsWith('"') ? (JSON.parse(text) as string) : text;
    } catch {
      value = null;
    }
  }
  if (value === null || value === "") {
    return null;
  }
  tokens.set(key, { value, until: deps.now() + TOKEN_TTL_MS });
  return value;
}

/**
 * One request of git's smart HTTP protocol from a project's agent server, passed to its repository on
 * GitHub with the token added, and GitHub's answer passed back as it comes. Anything else is refused.
 */
export async function relayGit(deps: AppDeps, request: Request, path: string): Promise<Response> {
  const match = RELAY_PATH.exec(path.slice(GIT_RELAY_PREFIX.length + 1));
  const appId = match?.[1];
  const action = match?.[2];
  if (appId === undefined || action === undefined || !ACTIONS.has(action)) {
    return plain(404, "Not found.");
  }
  const url = new URL(request.url);
  const service = action === "info/refs" ? url.searchParams.get("service") : action;
  if (service === null || !SERVICES.has(service)) {
    return plain(403, "Only git's smart HTTP protocol goes through the Studio.");
  }
  if (request.method !== (action === "info/refs" ? "GET" : "POST")) {
    return plain(405, "Not allowed.");
  }

  // An unknown project answers as a wrong token does: the address alone says nothing.
  const app = repo.findApp(deps.db, appId);
  const token = basicPassword(request.headers.get("authorization") ?? undefined);
  if (
    app === undefined ||
    app.repository === null ||
    token === null ||
    !gitTokenMatches(token, app.gitTokenHash)
  ) {
    return askForCredentials();
  }
  const settings = readStudioSettings(deps);
  if (!settings.enabled || settings.agent === null) {
    return plain(503, "The Studio is turned off.");
  }
  // The Studio's key for the repository's owner first, unless GitHub refused it lately; the agent
  // server's own token otherwise, or when GitHub refuses the key.
  const repository = app.repository;
  let key = githubKeyFor(deps, repository);
  if (key !== null && (keyRefusedUntil.get(repository.toLowerCase()) ?? 0) > deps.now()) {
    key = null;
  }
  const modelToken = async (): Promise<string | null> => {
    try {
      return await githubToken(deps, settings.agent as StudioAgent);
    } catch {
      return null;
    }
  };
  const first = key ?? (await modelToken());
  if (first === null) {
    return plain(
      502,
      `The Studio has no GitHub key for ${repository.split("/", 1)[0]}, and its agent server no ${GITHUB_SECRET} secret it can give.`,
    );
  }

  const upstream = new URL(`https://github.com/${repository}.git/${action}`);
  if (action === "info/refs") {
    upstream.searchParams.set("service", service);
  }
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const ask = async (github: string): Promise<Response | null> => {
    const sent = new Headers(headers);
    sent.set("authorization", `Basic ${Buffer.from(`x-access-token:${github}`).toString("base64")}`);
    try {
      return await fetch(upstream, {
        method: request.method,
        headers: sent,
        body: request.method === "POST" ? request.body : undefined,
        redirect: "manual",
        // A push streams on as it is sent, never held whole in memory.
        duplex: "half",
      } as RequestInit);
    } catch {
      return null;
    }
  };
  const refusedBy = (answer: Response) =>
    answer.status === 401 || answer.status === 403 || answer.status === 404;

  let answer = await ask(first);
  // A key narrower than the agent server's token must not cut the owner's other repositories off.
  // Only the first request of an exchange is tried again: it sends nothing, so it can be.
  if (answer !== null && key !== null && action === "info/refs" && refusedBy(answer)) {
    const fallback = await modelToken();
    if (fallback !== null && fallback !== key) {
      await answer.body?.cancel();
      keyRefusedUntil.set(repository.toLowerCase(), deps.now() + KEY_REFUSED_MS);
      answer = await ask(fallback);
    }
  }
  if (answer === null) {
    return plain(502, "GitHub could not be reached.");
  }
  if (refusedBy(answer)) {
    // GitHub refused the token for this repository. A 401 would have git ask for a password again.
    await answer.body?.cancel();
    const owner = repository.split("/", 1)[0];
    return plain(
      403,
      hasGithubKeyFor(deps, repository)
        ? `GitHub refused the Studio's tokens for ${repository}: on GitHub, give the Studio's key for ${owner} access to this repository.`
        : `GitHub refused the Studio's token for ${repository}: add a GitHub key for ${owner} in the Studio's settings, with access to this repository.`,
    );
  }
  if (action === "git-receive-pack" && answer.ok) {
    const preview = findServiceById(deps.db, app.serviceId);
    deps.actions.record({
      type: "studio.push",
      title: `Push from the Studio to ${app.repository}`,
      ...(preview === undefined ? {} : { projectName: preview.projectName, serviceName: preview.name }),
    });
  }
  const passed = new Headers();
  for (const name of ANSWER_HEADERS) {
    const value = answer.headers.get(name);
    if (value !== null) {
      passed.set(name, value);
    }
  }
  return new Response(answer.body, { status: answer.status, headers: passed });
}
