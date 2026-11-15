import type { StudioAgent } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { AppError, conflict, serviceUnavailable } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { qualifiedName } from "../services/compile";

export interface AgentCall {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Root-relative, as the agent server's API names it: `/api/conversations`. */
  path: string;
  body?: unknown;
}

export interface AgentReply {
  status: number;
  /** The body as the agent server sent it, still to be parsed. */
  text: string;
}

/**
 * Stands for the agent server's key in a request body. The script below puts the key in its place
 * inside the container, so the panel never holds it: a conversation needs it to look up the server's
 * own secrets, as the agent server's interface does.
 */
export const AGENT_KEY_PLACEHOLDER = "__OPSIFIER_AGENT_KEY__";

/** Where the script's answer starts, on a line of its own. */
const ANSWER_PREFIX = "opsifier-studio ";

/**
 * Runs inside the agent server's container: reads the key there, makes the calls on 127.0.0.1 in
 * order, and prints their answers on one line. The request comes on standard input, never as an
 * argument, so nothing of it shows in a process list.
 */
export const AGENT_SCRIPT = `
import json, os, sys, urllib.error, urllib.request
request = json.load(sys.stdin)
key = os.environ.get("SESSION_API_KEY") or os.environ.get("OH_SESSION_API_KEYS_0")
if not key and request.get("keyFile"):
    try:
        with open(request["keyFile"]) as handle:
            key = handle.read().strip()
    except OSError:
        key = None
answers = []
for call in request["calls"]:
    body = call.get("body")
    data = None
    if body is not None:
        data = json.dumps(body).replace(request["placeholder"], key or "").encode()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Session-API-Key"] = key
    sent = urllib.request.Request(request["url"] + call["path"], data=data, method=call["method"], headers=headers)
    try:
        with urllib.request.urlopen(sent, timeout=25) as answer:
            answers.append({"status": answer.status, "text": answer.read().decode("utf-8", "replace")})
    except urllib.error.HTTPError as error:
        answers.append({"status": error.code, "text": error.read().decode("utf-8", "replace")})
    except Exception as error:
        answers.append({"status": 0, "text": str(error)})
print(${JSON.stringify(ANSWER_PREFIX)} + json.dumps({"keyFound": bool(key), "answers": answers}))
print("opsifier-ok")
`;

const EXEC_TIMEOUT_MS = 60_000;
/** An event page with long terminal output, or a pasted screenshot, stays well under this. */
const MAX_ANSWER_CHARS = 32 * 1024 * 1024;

export interface AgentAnswers {
  keyFound: boolean;
  replies: AgentReply[];
}

/**
 * Makes `calls` against the agent server, from inside its own container. Throws a 409 when its
 * service has no running task, and a 503 when the script could not run or did not answer.
 */
export async function callAgent(
  deps: Pick<AppDeps, "docker">,
  agent: StudioAgent,
  calls: readonly AgentCall[],
): Promise<AgentAnswers> {
  const input = JSON.stringify({
    url: agent.url,
    keyFile: agent.keyFile,
    placeholder: AGENT_KEY_PLACEHOLDER,
    calls,
  });
  let outcome: Awaited<ReturnType<typeof runInDatabase>>;
  try {
    outcome = await runInDatabase(
      deps,
      qualifiedName(agent.project, agent.service),
      { command: ["python3", "-c", AGENT_SCRIPT], stdin: input },
      { timeoutMs: EXEC_TIMEOUT_MS, maxOutputChars: MAX_ANSWER_CHARS },
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${agent.project}/${agent.service} is not running.`,
      );
    }
    throw error;
  }
  const line = outcome.output.split("\n").find((candidate) => candidate.startsWith(ANSWER_PREFIX));
  if (!outcome.ok || line === undefined) {
    throw serviceUnavailable("studio_agent_unavailable", "The agent server could not be reached.");
  }
  const parsed = JSON.parse(line.slice(ANSWER_PREFIX.length)) as {
    keyFound: boolean;
    answers: AgentReply[];
  };
  return { keyFound: parsed.keyFound, replies: parsed.answers };
}

/** The parsed body of a successful answer, or the error the panel should give for a failed one. */
export function expectJson(reply: AgentReply | undefined, keyFound: boolean): unknown {
  if (reply === undefined || reply.status === 0) {
    throw serviceUnavailable("studio_agent_unavailable", "The agent server could not be reached.");
  }
  if (reply.status === 401 || reply.status === 403) {
    throw serviceUnavailable(
      "studio_agent_refused",
      keyFound
        ? "The agent server refused the panel's key."
        : "The panel found no key for the agent server in its container.",
    );
  }
  if (reply.status === 404) {
    throw new AppError(404, "not_found", "The agent server has no such conversation.");
  }
  if (reply.status < 200 || reply.status >= 300) {
    throw serviceUnavailable("studio_agent_error", `The agent server answered ${reply.status}.`);
  }
  try {
    return JSON.parse(reply.text) as unknown;
  } catch {
    throw serviceUnavailable("studio_agent_error", "The agent server's answer could not be read.");
  }
}
