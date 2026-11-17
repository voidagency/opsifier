/**
 * What the Studio's scripts in the agent server's container share. Nothing here imports the rest of
 * the Studio, so that any of its modules can build a script when it loads.
 */

/** The agent server's secret that holds the GitHub token, as OpenHands names it. */
export const GITHUB_SECRET = "GITHUB_TOKEN";

/**
 * The start of a script the Studio runs in the agent server's container, with its request on standard
 * input. It takes the GitHub token the panel hands it there, a Studio key, or else reads the agent
 * server's key and with it the GitHub token the agent server keeps as a secret, and sets up a
 * credential helper that reads the token from the environment: the token is never written, printed or
 * sent back. A request marked `relay` gets no token at all: its git goes to GitHub through the panel,
 * as the container's own settings say. `done` prints the script's verdict after `prefix`, which the
 * panel looks for.
 */
export const scriptPrelude = (prefix: string): string => `
import json, os, subprocess, sys, urllib.error, urllib.request
request = json.load(sys.stdin)
def done(result):
    print(${JSON.stringify(prefix)} + json.dumps(result))
    sys.exit(0)
key = os.environ.get("SESSION_API_KEY") or os.environ.get("OH_SESSION_API_KEYS_0")
if not key and request.get("keyFile"):
    try:
        with open(request["keyFile"]) as handle:
            key = handle.read().strip()
    except OSError:
        key = None
token = request.get("token") or ""
headers = {"X-Session-API-Key": key} if key else {}
if not token and not request.get("relay"):
    try:
        secret = urllib.request.Request(request["agentUrl"] + "/api/settings/secrets/" + request["secret"], headers=headers)
        with urllib.request.urlopen(secret, timeout=20) as answer:
            token = answer.read().decode().strip()
        if token.startswith('"'):
            token = json.loads(token)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            done({"ok": False, "code": "refused"})
    except Exception:
        done({"ok": False, "code": "unreachable"})
helper = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'
env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GITHUB_TOKEN=token)
def clean(text):
    text = text.strip().splitlines()[-1] if text.strip() else ""
    return text.replace(token, "***")[:300] if token else text[:300]
`;
