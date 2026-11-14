# The Opsifier command line

`opsifier` lets people and scripts work with a panel from a terminal. It is an ordinary client of the panel's public API under `/api/v1`: it signs every request with an API key and has no other way in. It never touches the panel's database or Docker, so whatever it can do, the same key can do with `curl`, and nothing more.

## Install

The command line needs Node 22.13 or later, and is one file with no dependencies. With Homebrew, which brings Node along:

```sh
brew trust voidagency/tap      # Homebrew 7 and later ask once before using a tap
brew install --cask voidagency/tap/opsifier
```

Or from the release itself, since 0.5.0:

```sh
curl -fsSL https://github.com/voidagency/opsifier/releases/latest/download/opsifier -o /usr/local/bin/opsifier
chmod +x /usr/local/bin/opsifier
opsifier --version
```

To build it from the sources instead:

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

### Shell completion

```sh
eval "$(opsifier completion bash)"    # in ~/.bashrc
eval "$(opsifier completion zsh)"     # in ~/.zshrc
opsifier completion fish > ~/.config/fish/completions/opsifier.fish
```

Commands, their options and their first words complete, and so do service names, which come from the panel the command would talk to: nothing is offered when it can't be reached.

## Connect it to a panel

Create an API key under **Settings, API keys**, then log in once:

```sh
opsifier login https://panel.example.com   # asks for the key without showing it
opsifier whoami
```

The panel checks the key before anything is kept. It is then kept in `~/.config/opsifier/credentials.json` (under `$XDG_CONFIG_HOME` when that is set, `%APPDATA%` on Windows), readable by you only, and `opsifier` warns if that file ever becomes readable by others. Log in to several panels and commands talk to the last one, or to the panel a folder is linked to; logging in again to a panel whose key is kept makes it the current one without asking for the key. `opsifier logout` forgets a panel's key and leaves no panel current until you log in again, so that the next command never lands on another panel unnoticed. The key itself works until it is revoked in the panel.

Scripts and CI jobs set two environment variables instead, which then come first:

```sh
export OPSIFIER_URL=https://panel.example.com
export OPSIFIER_API_KEY=opsifier_...
```

`OPSIFIER_URL` alone uses the key kept for that panel. `OPSIFIER_API_KEY` without `OPSIFIER_URL` is refused, so that a key never goes to a panel it was not meant for.

A key is never read from an argument, because a process's arguments can be seen by others on the same machine: `opsifier login` asks for it, or reads the first line of standard input (`opsifier login https://panel.example.com < key.txt`), or takes `OPSIFIER_API_KEY` when `OPSIFIER_URL` names that same panel: that key is never sent to any other. Use HTTPS whenever the panel is on another machine: over plain HTTP the key can be read on the way, and `opsifier` says so each time it runs at a terminal.

Give a key the smallest reach that will do: a read-only key for looking around, a key narrowed to one project for deploying it. A key can never do more than its owner can at that moment, and revoking it stops it at once.

### Sign in as a person, for accounts

Account administration (listing accounts, inviting, changing a role, deactivating) is never open to an API key. To do it from a terminal, sign the command line in as yourself:

```sh
opsifier login --web https://panel.example.com
```

The command prints a link and a code such as `BCDF-GHJK`, then waits. Open the link in a browser where you are signed in to the panel, check that it shows the same code, and approve with your two-factor code, or your password if your account has none. The page also says when the request came from another address than your browser's: refuse it if you did not run the command yourself. A request waits ten minutes.

The command line then keeps a session of your own account, valid for a day, next to any key kept for that panel. Commands use the key when there is one, and the session otherwise; `opsifier users` always uses the session. `opsifier logout` ends the session on the panel too, and forgets the panel.

## Work from a project's folder

Link a folder to a service once, and every command run in it, or in a folder below it, acts on that service:

```sh
cd ~/code/shop-web
opsifier link shop/web
opsifier deploy --wait
opsifier logs --follow
```

`opsifier link` checks that the service exists, then writes `.opsifier.json` with the service's name and the panel's address. The file holds no secret, so it can be committed. A link only works with the panel it was made on: if `OPSIFIER_URL` names another panel, commands refuse rather than act on a service of the same name somewhere else. `opsifier unlink` removes the folder's link.

A command that acts on one service finds it in this order: named on the command line as `project/service`, then `OPSIFIER_SERVICE`, then the nearest link. Removing a service or a project always takes its name on the command line.

## From code to a running app

```sh
cd ~/code/shop-web
opsifier create shop/web --link      # the project too, when it is new; links this folder
opsifier config set MODE=live
opsifier push --wait                 # packs this folder, sends it, deploys it, shows the build
opsifier open
```

`opsifier create` makes a project, or a service in one. Where the service comes from is one of `--image nginx:1.27`, `--git <url>` with `--ref <branch>` and `--path <folder>`, `--dockerfile ./Dockerfile`, or `--database` with `postgres`, `mysql`, `mariadb`, `mongo` or `redis`, whose credentials the panel generates. `--deploy` deploys it at once, and `--link` links the folder.

`opsifier push` packs a folder into a tar.gz, sends it, and deploys it: the panel builds it on the server. It packs the folder linked to that service as a whole, wherever in it the command runs; without a link, the folder it runs in; or the folder `--dir` names. It never packs a home folder, the root, or a folder that holds its own key file. It leaves out `.git`, the link file, and what git would leave out: every `.gitignore` from the repository's root down, `.git/info/exclude` and your global excludes file. `.opsifierignore` is read after `.gitignore` in each folder, so a `!` line there brings back what `.gitignore` leaves out. Files whose names suggest secrets, such as `.env`, `.npmrc` or a private key, stop it unless `--include-secrets` says to send them; templates such as `.env.example` go through. Links that lead out of the folder are left out, which the panel would refuse, and a link written as an absolute path inside the folder is rewritten from the link itself. A service that deploys from an image or a repository only switches to what is sent with `--yes`. `--upload-only` sends without deploying. `--path` names the folder to build from inside what is sent, and later pushes keep it. Ctrl-C stops it before anything more is sent, and no deployment starts. The panel takes archives up to 1 GiB.

## Everyday use

| Task                                   | Command                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| Who am I, and what can I reach         | `opsifier whoami`                                            |
| Everything at a glance, problems first | `opsifier status`                                            |
| One project's services                 | `opsifier services shop`                                     |
| One service in detail                  | `opsifier status shop/web`                                   |
| Recent logs                            | `opsifier logs shop/web`                                     |
| Logs of the last hour, only errors     | `opsifier logs shop/web --since 1h --level error`            |
| Search logs                            | `opsifier logs shop/web --grep timeout -n 50`                |
| Keep watching new lines                | `opsifier logs shop/web --follow`                            |
| Deploy                                 | `opsifier deploy shop/web`                                   |
| Deploy without any build cache         | `opsifier deploy shop/web --force`                           |
| Restart                                | `opsifier restart shop/web`                                  |
| Stop or start                          | `opsifier stop shop/web --yes`, `opsifier start shop/web`    |
| Recent activity                        | `opsifier actions --project shop -n 20`                      |
| How did that deploy go                 | `opsifier action <id>`                                       |
| Deployment history                     | `opsifier deployments shop/web`                              |
| Cancel what is running                 | `opsifier cancel <id>`                                       |
| Deploy, and follow it to the end       | `opsifier deploy shop/web --wait`                            |
| Send this folder's code and deploy it  | `opsifier push --wait`                                       |
| Versions the service keeps             | `opsifier releases shop/web`                                 |
| Go back to the previous version        | `opsifier rollback shop/web --confirm web`                   |
| The service's variables, names only    | `opsifier config shop/web`                                   |
| Set variables, then deploy             | `opsifier config set shop/web MODE=live --deploy`            |
| The service's address                  | `opsifier open shop/web`                                     |
| What it uses: processor, memory        | `opsifier ps shop/web`                                       |
| Its domains                            | `opsifier domains shop/web`                                  |
| Add a domain                           | `opsifier domains add shop/web shop.example.com --port 3000` |
| Show a maintenance page                | `opsifier maintenance on shop/web --yes`                     |
| A database's credentials, masked       | `opsifier db shop/db`                                        |
| Run a saved script                     | `opsifier run shop/web migrate`                              |
| Backups, and take one now              | `opsifier backups shop/db`, `opsifier backups run shop/db`   |

A deployment, a restart and anything else slow is an Action on the panel: the command returns as soon as the panel has taken it on, with the Action's id. Read it with `opsifier action <id>` to see how it is going and how it ended, including its output.

`logs --follow` is a client of the same search the Logs tab offers: every two seconds it asks for the last few seconds and prints what it has not printed yet.

### Follow an action to its end

`--wait` keeps `deploy`, `restart`, `start`, `stop`, `rollback` and `config ... --deploy` running until the action has ended. At a terminal it prints the action's output as it comes, then how long it took; for a script it prints the finished action as JSON. An action that fails ends the command with exit code 1. Interrupting stops the waiting only: the action goes on at the panel.

### Variables

```sh
opsifier config shop/web                          # names only: values stay hidden
opsifier config get shop/web DATABASE_URL --yes   # print values
opsifier config set shop/web MODE=live "GREETING=hello there"
opsifier config unset shop/web OLD_FLAG --yes
opsifier config set --project shop REGION=eu      # shared by every service of the project
```

Values are saved exactly as typed, spaces and quotes included. A value can't hold a line break. The panel keeps a set of variables as one text, so `set` and `unset` read the current text, change only the names given, keep comments and order, and save it back. Reading the values, there as with `get`, goes in the panel's activity log.

Changes apply at the next deployment. `--deploy` deploys the service as soon as they are saved, and `--wait` follows that deployment to its end.

### Versions and rollback

`opsifier releases` lists the versions a service keeps, five unless changed in the panel's settings, the running one marked, and says why one can't be gone back to. `opsifier rollback` runs a kept version again from the image already on the server: no pull, no build, and volumes and saved settings stay as they are. Without a version it takes the newest kept one older than the running one; `opsifier rollback shop/web v4` names one. It takes the service's exact name with `--confirm`, which the panel checks too.

### Domains and the maintenance page

`opsifier domains add` takes a host, or a whole address such as `https://example.com/api` whose path is then used, and `--port` names the port the service listens on inside its container (80 when not given). `--primary` makes it the address `open` and `$(PRIMARY_DOMAIN)` use, and `opsifier domains primary` changes that later. A host with several paths takes `--path` to say which one. Point the host at the server in its DNS: the certificate comes once it answers there. Domains and the maintenance page apply at once, without a deployment. `opsifier maintenance on --yes` shows the maintenance page to every visitor while the service keeps running, `--title` and `--subtitle` change its words, and `opsifier maintenance off` brings the service back.

### Databases, scripts and backups

`opsifier db` shows a database's credentials with the password masked. `opsifier db url --yes` prints its address, `--external` the one from outside the server when it is exposed, and `opsifier db password --yes` its password, `--root` the administrator's where the engine has one. Each secret printed goes in the panel's activity log.

`opsifier scripts add <name> --command "<script>"`, or `--file` with a file on this machine, saves a script the service runs with `sh` in its container: on demand, on a schedule with `--cron "0 3 * * *"` and `--tz`, or after every deployment with `--after-deploy`. `opsifier run <name>` runs it, prints its output as it comes, and fails when it fails; `--detach` only starts it. A command only ever runs as a saved script, so whatever a key runs stays listed in the panel, with each run in its activity.

`opsifier backups` lists a service's backups and its backup settings. `opsifier backups run` takes one now with the service's only setting, or the one named; settings themselves are made in the panel, where the destinations are.

`opsifier ps` shows a service's state with what it uses: processor, memory against its limit, and network.

### The address

`opsifier open` prints the service's primary address. At a terminal it is a link most terminals open with a click. The command line starts no other program, browsers included: on a Mac, `open "$(opsifier open shop/web --text)"` does that.

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

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Done                                                                           |
| 1    | The panel failed in some other way, or an action followed with `--wait` failed |
| 2    | Invalid use: a mistyped command, a missing confirmation, invalid values        |
| 3    | Not authenticated: no key, or a key that is revoked or expired                 |
| 4    | Forbidden                                                                      |
| 5    | Not found, or out of this key's reach                                          |
| 6    | Conflict with the current state                                                |
| 7    | The panel could not be reached, or answered with a redirect                    |
| 130  | Interrupted. With `--wait`, the action itself goes on                          |

## Destructive commands

Commands that remove something or take something offline do nothing without an explicit confirmation:

```sh
opsifier stop shop/web --yes
opsifier destroy shop/web --confirm web        # the service's exact name, checked by the panel too
opsifier delete-project shop --confirm shop    # the project's exact name
opsifier rollback shop/web --confirm web       # the service's exact name, checked by the panel too
opsifier config unset shop/web OLD_FLAG --yes
opsifier config get shop/web API_TOKEN --yes   # prints a secret
opsifier domains remove shop/web old.example.com --yes
opsifier maintenance on shop/web --yes
opsifier db password shop/db --yes             # prints a secret
opsifier scripts remove shop/web migrate --yes
```

Without it, the command refuses and sends nothing.

## Accounts

With a session from `opsifier login --web`:

```sh
opsifier users                                              # every account, its role, two-factor and state
opsifier users invite ada@example.com bob@example.com       # prints each one's single-use link
opsifier users invite ada@example.com --channel <id>        # the panel e-mails it through that channel
opsifier users invite ada@example.com --admin
opsifier users invite ada@example.com --all-projects operator
opsifier users set ada@example.com --role admin
opsifier users set ada@example.com --all-projects viewer    # or operator, or none
opsifier users deactivate ada@example.com                   # its sessions and keys stop at once
opsifier users activate ada@example.com
```

The panel applies its own rules, as it does in the browser: only the owner changes another administrator, for instance.

## Everything else

The whole API is available through one command, with exactly the rights of the key:

```sh
opsifier api list domain                      # what this key can call, with an optional search
opsifier api describe POST /projects/shop/services/web/domains
opsifier api GET /projects/shop/services/web/domains
opsifier api PUT /projects/shop/services/web/resources -d @resources.json
opsifier api DELETE /projects/shop/services/web/domains/abc --yes
```

Paths work as they are written in the reference (`/api/v1/...`) or without the prefix. `-d` takes JSON, or `@file`, or `@-` for standard input, and `-q name=value` adds a query parameter. Anything destructive needs `--yes`, a secret revealed included, judged on the path the panel routes however it is spelled. Everything is JSON except uploading source code, which takes a raw file: `opsifier push` does that one.

## What it will never do

- Send a key anywhere but its panel: requests only ever go to the panel the key was given for, and a redirect is refused outright, wherever it points. If your panel has really moved, log in to its new address, or set `OPSIFIER_URL` to it.
- Run another program. It starts no browser, no git and no tar: `push` packs the folder itself, and `open` prints the address.
- Do what the key could not do through the API. A read-only key cannot change anything, a key narrowed to some projects sees nothing outside them, and whatever only a person at a browser can do (accounts, other keys, server settings) stays refused.

The command line follows your language (`LC_ALL`, `LC_MESSAGES`, `LANG`): English or French. What the panel itself answers stays as the panel wrote it.
