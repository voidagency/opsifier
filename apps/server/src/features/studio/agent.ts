import type { StudioAgent } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { AppError, conflict, serviceUnavailable } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { qualifiedName } from "../services/compile";

/**
 * What the script keeps of an answer, inside the container, before it travels: an event page or a
 * conversation can weigh megabytes (whole files the agent read, its system prompt, its settings),
 * when the Studio needs a few fields of each.
 */
export type AgentShape = "events" | "conversation";

export interface AgentCall {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Root-relative, as the agent server's API names it: `/api/conversations`. */
  path: string;
  body?: unknown;
  shape?: AgentShape;
}

export interface AgentReply {
  status: number;
  /** The body as the agent server sent it, or as its shape keeps it, still to be parsed. */
  text: string;
}

/**
 * Stands for the agent server's key in a request body. The script below puts the key in its place
 * inside the container, so the panel never holds it: a conversation needs it to look up the server's
 * own secrets, as the agent server's interface does.
 */
export const AGENT_KEY_PLACEHOLDER = "__OPSIFIER_AGENT_KEY__";

/** Starts each line of the script's answer. */
const ANSWER_PREFIX = "opsifier-studio ";
/** Docker's output is read line by line, and a line longer than 64 KiB is cut: the answer comes in pieces. */
const PIECE_CHARS = 30_000;

/**
 * Runs inside the agent server's container: reads the key there, makes the calls on 127.0.0.1 in
 * order, keeps what each call's shape needs, and prints the answers in base64, in lines short enough
 * to come back whole. The request comes on standard input, never as an argument, so nothing of it
 * shows in a process list.
 */
export const AGENT_SCRIPT = `
import base64, json, os, sys, urllib.error, urllib.request
request = json.load(sys.stdin)
key = os.environ.get("SESSION_API_KEY") or os.environ.get("OH_SESSION_API_KEYS_0")
if not key and request.get("keyFile"):
    try:
        with open(request["keyFile"]) as handle:
            key = handle.read().strip()
    except OSError:
        key = None
QUIET = {"SystemPromptEvent", "ObservationEvent", "SecurityAnalysisEvent", "ConversationStateUpdateEvent"}
BASE = ("id", "kind", "timestamp", "source")
def pick(item, names):
    return {name: item.get(name) for name in names if name in item}
def shaped(shape, text):
    if not shape:
        return text
    try:
        data = json.loads(text)
    except ValueError:
        return text
    if not isinstance(data, dict):
        return text
    if shape == "events":
        items = []
        for item in data.get("items") or []:
            if not isinstance(item, dict):
                continue
            kind = item.get("kind")
            if kind in QUIET:
                items.append(pick(item, BASE))
            elif kind == "ActionEvent":
                kept = pick(item, BASE + ("tool_name", "summary"))
                action = item.get("action") or {}
                kept["action"] = pick(action, ("kind", "command", "path", "url", "message"))
                tasks = action.get("task_list")
                if isinstance(tasks, list):
                    kept["action"]["task_list"] = [pick(task, ("title", "status")) for task in tasks[:30] if isinstance(task, dict)]
                thought = item.get("thought")
                if isinstance(thought, list):
                    thought = " ".join(part.get("text", "") for part in thought if isinstance(part, dict) and part.get("type") == "text")
                if isinstance(thought, str) and thought.strip():
                    kept["thought"] = thought.strip()[:4000]
                items.append(kept)
            elif kind == "MessageEvent":
                items.append(pick(item, BASE + ("llm_message",)))
            else:
                items.append(pick(item, BASE + ("error", "detail")))
        data = {"items": items, "next_page_id": data.get("next_page_id")}
    elif shape == "conversation":
        llm = (data.get("agent") or {}).get("llm") or {}
        data = pick(data, ("id", "title", "execution_status"))
        data["llm"] = pick(llm, ("model", "base_url"))
    return json.dumps(data)
def with_key(body):
    # The key goes only where the panel asked for it, in the headers the agent server looks its own
    # secrets up with. Nothing else in a body, such as what a person wrote, is ever read for it.
    secrets = body.get("secrets") if isinstance(body, dict) else None
    if isinstance(secrets, dict):
        for secret in secrets.values():
            headers = secret.get("headers") if isinstance(secret, dict) else None
            if isinstance(headers, dict) and headers.get("X-Session-API-Key") == request["placeholder"]:
                headers["X-Session-API-Key"] = key or ""
    return body
answers = []
for call in request["calls"]:
    body = call.get("body")
    data = None
    if body is not None:
        data = json.dumps(with_key(body)).encode()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Session-API-Key"] = key
    sent = urllib.request.Request(request["url"] + call["path"], data=data, method=call["method"], headers=headers)
    try:
        with urllib.request.urlopen(sent, timeout=25) as answer:
            status, text = answer.status, answer.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode("utf-8", "replace")
    except Exception as error:
        status, text = 0, str(error)
    if 200 <= status < 300:
        text = shaped(call.get("shape"), text)
    answers.append({"status": status, "text": text})
encoded = base64.b64encode(json.dumps({"keyFound": bool(key), "answers": answers}).encode()).decode()
for start in range(0, len(encoded), ${PIECE_CHARS}):
    print(${JSON.stringify(ANSWER_PREFIX)} + encoded[start:start + ${PIECE_CHARS}])
print("opsifier-ok")
`;

const EXEC_TIMEOUT_MS = 60_000;
/** An event page with pasted screenshots, in base64, stays well under this. */
const MAX_ANSWER_CHARS = 32 * 1024 * 1024;

export interface AgentAnswers {
  keyFound: boolean;
  replies: AgentReply[];
}

/** Puts the script's answer back together from its lines, in order. */
export function readAnswer(output: string): AgentAnswers | null {
  const pieces = output
    .split("\n")
    .filter((line) => line.startsWith(ANSWER_PREFIX))
    .map((line) => line.slice(ANSWER_PREFIX.length).trim());
  if (pieces.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(pieces.join(""), "base64").toString("utf8")) as {
      keyFound: boolean;
      answers: AgentReply[];
    };
    return { keyFound: parsed.keyFound, replies: parsed.answers };
  } catch {
    return null;
  }
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
  const answers = outcome.ok ? readAnswer(outcome.output) : null;
  if (answers === null) {
    throw serviceUnavailable("studio_agent_unavailable", "The agent server could not be reached.");
  }
  return answers;
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
