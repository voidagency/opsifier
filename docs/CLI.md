# The Opsifier command line

`opsifier` lets people and scripts work with a panel from a terminal. It is an ordinary client of the panel's public API under `/api/v1`: it signs every request with an API key and has no other way in. It never touches the panel's database or Docker, so whatever it can do, the same key can do with `curl`, and nothing more.

## Install

The command line needs Node 22.13 or later, and is one file with no dependencies.

```sh
git clone <your fork or the project repository> opsifier
cd opsifier
bun install
bun run --filter '@opsifier/cli' build

# Try it from where it is
node packages/cli/dist/opsifier.mjs --help

# Or put it on your PATH
ln -s "$PWD/packages/cli/dist/opsifier.mjs" /usr/local/bin/opsifier
```

The built file can be copied to any other machine that has Node.

## Connect it to a panel

Create an API key under **Settings, API keys**, then set two environment variables:

```sh
export OPSIFIER_URL=https://panel.example.com
export OPSIFIER_API_KEY=opsifier_...
opsifier whoami
```

The key is read only from the environment, never from an argument, because a process's arguments can be seen by others on the same machine. Use HTTPS whenever the panel is on another machine: over plain HTTP the key can be read on the way, and `opsifier` says so each time it runs at a terminal.

Give a key the smallest reach that will do: a read-only key for looking around, a key narrowed to one project for deploying it. A key can never do more than its owner can at that moment, and revoking it stops it at once.

## Everyday use

| Task                                   | Command                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| Who am I, and what can I reach         | `opsifier whoami`                                         |
| Everything at a glance, problems first | `opsifier status`                                         |
| One project's services                 | `opsifier services shop`                                  |
| One service in detail                  | `opsifier status shop/web`                                |
| Recent logs                            | `opsifier logs shop/web`                                  |
| Logs of the last hour, only errors     | `opsifier logs shop/web --since 1h --level error`         |
| Search logs                            | `opsifier logs shop/web --grep timeout -n 50`             |
| Keep watching new lines                | `opsifier logs shop/web --follow`                         |
| Deploy                                 | `opsifier deploy shop/web`                                |
| Deploy without any build cache         | `opsifier deploy shop/web --force`                        |
| Restart                                | `opsifier restart shop/web`                               |
| Stop or start                          | `opsifier stop shop/web --yes`, `opsifier start shop/web` |
| Recent activity                        | `opsifier actions --project shop -n 20`                   |
| How did that deploy go                 | `opsifier action <id>`                                    |
| Deployment history                     | `opsifier deployments shop/web`                           |
| Cancel what is running                 | `opsifier cancel <id>`                                    |

A deployment, a restart and anything else slow is an Action on the panel: the command returns as soon as the panel has taken it on, with the Action's id. Read it with `opsifier action <id>` to see how it is going and how it ended, including its output.

`logs --follow` is a client of the same search the Logs tab offers: every two seconds it asks for the last few seconds and prints what it has not printed yet.

## Output for scripts and agents

When standard output is not a terminal, every command prints JSON: exactly what the API answered, so a script written against the API works unchanged, and `opsifier projects | jq .` does what you expect. At a terminal it prints tables, and `--json` or `--text` choose one or the other. Following logs as JSON prints one log line per line.

Errors go to standard error, in the API's own shape, plus a hint when there is one:

```json
{
  "error": {
    "code": "read_only_key",
    "message": "This API key can only read.",
    "status": 403,
    "hint": "This key is limited to reading. Create a key with the write level in Settings, API keys."
  }
}
```

The exit code says what happened without any parsing:

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Done                                                                    |
| 1    | The panel failed in some other way                                      |
| 2    | Invalid use: a mistyped command, a missing confirmation, invalid values |
| 3    | Not authenticated: no key, or a key that is revoked or expired          |
| 4    | Forbidden                                                               |
| 5    | Not found, or out of this key's reach                                   |
| 6    | Conflict with the current state                                         |
| 7    | The panel could not be reached, or answered with a redirect             |

## Destructive commands

Commands that remove something or take something offline do nothing without an explicit confirmation:

```sh
opsifier stop shop/web --yes
opsifier destroy shop/web --confirm web        # the service's exact name, checked by the panel too
opsifier delete-project shop --confirm shop    # the project's exact name
```

Without it, the command refuses and sends nothing.

## Everything else

The whole API is available through one command, with exactly the rights of the key:

```sh
opsifier api list domain                      # what this key can call, with an optional search
opsifier api describe POST /projects/shop/services/web/domains
opsifier api GET /projects/shop/services/web/domains
opsifier api PUT /projects/shop/services/web/resources -d @resources.json
opsifier api DELETE /projects/shop/services/web/domains/abc --yes
```

Paths work as they are written in the reference (`/api/v1/...`) or without the prefix. `-d` takes JSON, or `@file`, or `@-` for standard input, and `-q name=value` adds a query parameter. Anything destructive needs `--yes`. Everything is JSON except uploading source code, which takes a raw file: use `curl` for that one.

## What it will never do

- Send the key anywhere but the panel: requests only ever go to `OPSIFIER_URL`, and a redirect is refused outright, wherever it points. If your panel has really moved, set `OPSIFIER_URL` to its new address.
- Do what the key could not do through the API. A read-only key cannot change anything, a key narrowed to some projects sees nothing outside them, and whatever only a person at a browser can do (accounts, other keys, server settings) stays refused.

The command line follows your language (`LC_ALL`, `LC_MESSAGES`, `LANG`): English or French. What the panel itself answers stays as the panel wrote it.
