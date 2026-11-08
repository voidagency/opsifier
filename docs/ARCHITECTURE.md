# Opsifier architecture

Opsifier is a self-hosted control panel. You install it on a Linux server with one command, then deploy apps, databases and compose stacks from a web UI. Docker Swarm runs the workloads and Traefik routes the traffic.

This file is the contract every contributor builds against. Change it when a decision changes.

## Principles

1. **One container, one SQLite file.** No external database or queue.
2. **Desired state lives in the database.** A deploy compiles it into a Swarm service spec and a Traefik file. The compilers are pure functions, so they can be tested without Docker.
3. **Anything slow is an Action.** It is queued, logged, cancellable and visible on the Activity page.
4. **Secrets stay on the server.** They are encrypted at rest and never appear in list responses. A dedicated endpoint reveals one secret when the UI explicitly asks for it.
5. **No outside calls from the browser.** Fonts and assets are self-hosted. There is no telemetry.
6. **Every feature is free.** No tiers, no gates, no upsell.

## Repository

| Path                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `apps/server`        | Hono API, Action engine, Docker and Traefik drivers            |
| `apps/web`           | React single-page app                                          |
| `packages/contract`  | Zod schemas shared by the server, the web app and a future CLI |
| `templates`          | Our own application catalogue                                  |
| `scripts/install.sh` | One-line installer                                             |
| `scripts/sandbox.sh` | Docker-in-Docker sandbox for checking against real Docker      |

Stack: Node 22, strict TypeScript, ESM. Bun manages packages and workspaces. Biome lints and formats. Vitest runs tests.

## Server

`apps/server/src/core` holds shared modules: `config`, `db`, `errors`, `auth`, `secrets`, `actions`, `docker`, `proxy`, `realtime`, `tools`.

Each feature is a self-contained module:

```
apps/server/src/features/<feature>/
  routes.ts      thin HTTP layer
  service.ts     business logic
  repo.ts        queries
  *.test.ts
packages/contract/src/<feature>.ts
```

A feature joins the app with one line in `apps/server/src/features/index.ts`.

### Service tabs

An App service is one feature split by tab, so tabs can be filled in independently. A tab is named after its URL segment and lives in four places:

```
packages/contract/src/service-tabs/<tab>.ts   schemas for its routes and its part of the spec
apps/server/src/features/service-tabs/<tab>/  routes.ts, service.ts, repo.ts, *.test.ts
apps/web/src/features/services/tabs/<tab>/    its page
apps/web/src/i18n/<lang>/service-<tab>.json   its strings
```

Tabs that are not built yet already have a route and a placeholder page in `apps/web/src/features/services/tabs.tsx`, so filling one in only touches its own folders. Its server routes join with one line in `features/index.ts`, and its settings with one field in `features/services/spec.ts`. Saving a setting never touches what is running: settings reach the container at the next deploy unless a tab says otherwise.

### API

- REST and JSON under `/api/v1`, defined with `@hono/zod-openapi`. The document is served at `/api/v1/openapi.json`.
- Errors always have the shape `{ "error": { "code", "message", "fields"? } }`. Validation failures return 400 with `fields` mapping each field to its message.
- Long operations return 202 with the Action they created.
- Destructive endpoints that the UI confirms by typing a name take `{ "confirm": "<name>" }` and check it on the server.
- Authentication is either the session cookie or `Authorization: Bearer <token>`. The cookie is `__Host-opsifier_session` over HTTPS and `opsifier_session` over plain HTTP, and a request is only ever authenticated by the one matching its scheme. Cookie-authenticated mutations must pass an `Origin` check that compares scheme and host. `X-Forwarded-Proto` only counts from a configured trusted proxy.

### Persistence

SQLite through `better-sqlite3` and Drizzle, with migrations checked in and applied at boot. The data directory is `/var/lib/opsifier` in production and `.data` in development.

A service stores its type-specific configuration as one JSON `spec` column validated by Zod, including its env, mounts, ports and resources. Data queried across services gets its own table: domains, actions, backups, users, tokens.

### Actions

`actions.enqueue({ type, projectName?, serviceName?, title, run })` returns the row immediately.

- One Action runs per service at a time, and others wait in FIFO order. Actions without a service run concurrently, up to four.
- Deployments of one service queue, and a further deploy request while one is already waiting joins it, so a webhook delivery is never lost. Operations that cannot safely follow a running one are refused with 409 and an explicit message: destroy, rename or move while an Action is active on the service, and start, stop or restart during a deployment.
- `run(ctx)` receives `ctx.log(line)` and `ctx.signal`. Output is appended to `<data>/actions/<id>.log` and streamed to the topic `action:<id>`.
- Statuses are `queued`, `running`, `succeeded`, `failed` and `cancelled`. At boot, any `running` row becomes `failed` with the reason that the panel restarted.
- The newest 1,000 Actions are kept. Older rows and their log files are pruned at boot and hourly, never one that is queued or running.

### Docker

`core/docker/driver.ts` defines one interface with two implementations: `DockerodeDriver` and `FakeDriver`. `OPSIFIER_DRIVER=fake` exists for local development and tests. Production never falls back to it.

Workloads run as Swarm services named `<project>_<service>`, on an attachable overlay network per project named `opsifier-<project>`. The proxy joins every project network. Project names allow no underscore, so a Swarm service name can only be split one way.

A named volume is a local Docker volume bound to `<data>/projects/<project>/<service>/volumes/<name>`, which is world-writable so that a non-root container can use it. A service that publishes host ports always updates stop-first, since a new task could not bind a port its predecessor still holds, and is limited to one replica on a host. A bind mount that exposes the data directory or the Docker socket needs an explicit confirmation, stored with the mount and checked again by the compiler.

A deploy pulls the image, rolls out and then watches the tasks: it only succeeds once the new tasks have stayed running through a stability window (`core/docker/rollout.ts`), and it fails if they crash or run out of time. Deploys and restarts raise Docker's `ForceUpdate` counter rather than changing the task's environment. The container env is `PORT` from the primary domain's target port, then the project's variables, then the service's.

### Building from source

A service whose source is GitHub, Git, an inline Dockerfile or an upload is built on the server by its deploy Action, before the rollout. The image is tagged `opsifier/<project>/<service>:latest` and exists only on this server, so nothing is pushed anywhere.

The code goes in `<data>/projects/<project>/<service>/code`, replaced completely at every deploy. A repository is fetched one commit deep into a temporary directory and checked out with no `.git`, so a force push or a local change cannot get in the way and the Docker context stays clean. The commit's SHA reaches the build and the container as `GIT_SHA`.

The build path is both the detection root and the Docker context. With no saved settings, a `Dockerfile` in the build path is used if there is one, and Nixpacks otherwise. A builder's command fields replace what it would have detected, and `railpack.json`, `nixpacks.toml` and `project.toml` in the build path are honoured. Project and service variables reach the build by name through the environment of the process, so their values are not in any argument list: build arguments for Dockerfiles, `--env NAME` for Nixpacks and Buildpacks, BuildKit secrets for Railpack. Names that steer the tools themselves (`PATH`, `DOCKER_*`, `BUILDKIT_*` and the like) are not passed.

External programs go through `core/tools`: `spawn` with an argument array, never a shell, and the environment each one needs instead of the panel's own. Every program leads its own process group, so cancelling an Action or running past the build timeout (`OPSIFIER_BUILD_TIMEOUT_SECONDS`, one hour by default) kills everything it started. A failed step fails the deployment and leaves what is running alone. `FakeTools` replaces all of this when the Docker driver is fake.

Git only ever speaks https and ssh: remotes are validated when saved, and `GIT_ALLOW_PROTOCOL` holds git itself to that for anything it is redirected to. Prompts are off, no system or global configuration is read, and `--` comes before every value that came from a request. Git runs the SSH command and the credential helper through its own shell, so they contain only fixed flags and paths the panel generated, and SSH host keys are remembered per service on first contact.

SSH deploy keys and the GitHub token are sealed at rest. For the length of one git operation they exist in 0600 files under `<data>/tmp`, which is also emptied at boot, and they are removed from any output that could mention them. A GitHub token is used for `github.com` sources only, an SSH key for SSH remotes only.

Build paths and Dockerfile paths are checked again with `realpath` once the checkout exists, because a symlink in the repository can point anywhere. Uploads are limited to 1 GiB, counted as they arrive. `bsdtar` reads every supported format, an archive is listed and refused if an entry would escape, unpacked without `-P`, and then walked: links that lead outside and anything that isn't a file, folder or link fail the build, as does unpacking past a size limit.

A deploy trigger is a token per service, 48 hex characters, sealed and looked up by hash. `/api/v1/deploy/<token>` starts a deployment without a session, and `?forceRebuild` skips the cache. A GitHub push webhook calls the same URL, signed with the token, and only a push to the configured branch deploys.

### Databases

A database is a service row whose `type` is its engine (`postgres`, `mysql`, `mariadb`, `mongo`, `redis`) and whose spec carries one extra field, `database`, next to the `source`, `env` and `resources` an App has. `compile/database/` holds its pure sub-compilers. It runs one task, stop-first, with a healthcheck, so a deploy only succeeds once the engine answers. Data lives on a named Docker volume whose name is fixed at creation, so a rename cannot disconnect it, and destroying the service deletes it.

Passwords are generated with a CSPRNG, sealed at rest and only returned by the audited reveal endpoint of the Credentials tab, one secret per request, with every reveal recorded in the activity log. Connection URLs percent-encode every part.

Changing a password is an Action that records its intent first, applies the change in the running engine (or, for Redis, restarts it with the new value), connects with the new password to verify it, and only then saves it. If anything fails, the old password is restored. If the panel dies midway, a recovery Action at the next boot probes which password the database accepts, so the panel and the database always end up agreeing.

Public exposure publishes the engine port on the host in host mode, after checking other services and reserved ports, and rolls back if Docker reports the port as taken on the node.

### Proxy

Traefik 3 reads a file-provider directory at `<data>/traefik/dynamic`. There is one YAML per service, `<project>__<service>.yaml`, plus `_base.yaml` for the panel's own routes and shared middlewares. Writes are atomic: temporary file, then rename.

`compileService(input)` returns `{ swarmSpec, proxyConfig, files }` and performs no I/O. It lives in `apps/server/src/features/services/compile/` and only composes one pure sub-compiler per concern: `env`, `mounts`, `ports`, `resources`, `deploy`, `domains` and `middlewares`. A feature extends the one it needs without touching the others.

A new service's default domain is `<project>-<service>.<server-ip>.sslip.io`, or `<project>-<service>.<base>` when the `service_domain` setting is set. A stopped service keeps its routers with no servers behind them, so its domains answer 503.

`_base.yaml` also holds a catch-all at the lowest priority: HTTP redirects to HTTPS, and HTTPS shows the panel's not-found page. The panel serves its own pages at `/api/proxy-pages/*` with no session: bad gateway (every router, through an `errors` middleware on 502), not found, service stopped (on the routers of a stopped service, on 503) and maintenance. Maintenance points every router of a service at the panel with a `replacePath` to its page. Domains, redirects, basic auth and maintenance apply at once through the proxy writer and never touch the Docker service. `OPSIFIER_PANEL_UPSTREAM` overrides where Traefik reaches the panel, for setups other than the shared network's `http://opsifier:3000`.

A service's routes live in its own file, and the file provider only ever sees valid YAML, so a domain that fails to get a certificate or names a resolver that doesn't exist can't affect any other service. Hosts, paths, regexes and basic auth users are validated in the contract and again in the compilers, because Traefik disables the whole router for one thing it can't parse. Redirect patterns are checked against Go's regular expression syntax, which is what Traefik compiles them with.

### Realtime

One WebSocket at `/api/v1/ws` carries JSON frames with topics such as `action:<id>`, `service-logs:<project>/<service>` and `metrics:system`. Clients send `{ "t": "sub", "topic" }` and `{ "t": "unsub", "topic" }`. The server sends `{ "t": "data", "topic", "payload" }`. Terminals use their own binary WebSocket at `/api/v1/terminal/<project>/<service>`.

A feature can produce a topic on demand with `realtime.provide(provider)`: the first subscriber starts it, the last one stops it, and each new subscriber gets a replay. `service-logs:<project>/<service>` and `service-metrics:<project>/<service>` work this way, keyed on the project and service so that they serve any type of service, as `metrics:services` does for the Monitor page. A log feed keeps bounded buffers and stops reading from Docker while its slowest subscriber catches up.

Other WebSocket endpoints join the hub with `realtime.route(route)`, behind the same Origin and session checks at upgrade, and end with their session. The terminal route also requires an administrator, runs its program as an argument vector, writes each session to the Activity log, and bounds its frames and buffers. Docker keeps a TTY exec running when its client goes away, so closing a terminal ends its processes explicitly.

### Security

- Passwords use `scrypt` and are at most 256 characters. Session tokens are random and stored hashed. Login is rate limited.
- A panel with no user can only be claimed with the one-time token at `<data>/setup-token`, mode 0600, printed in the log at boot as `/setup?token=...` and deleted by a successful setup.
- Sessions opened over plain HTTP last at most 12 hours, whatever the user asked for.
- Starting two-factor enrolment and turning it off take the current password. Enabling it issues ten single-use recovery codes, shown once and stored hashed.
- Secrets are sealed with AES-256-GCM using a 32-byte key at `<data>/secret.key`, mode 0600. If the key is missing once users exist, the panel refuses to boot.
- Names and paths are validated before they reach Docker or the file system. Nothing is interpolated into a shell.
- Validate strictly, even where another product might not: hostnames, paths, port ranges, replica counts, negative resources and empty credentials are all rejected.

## Runtime on a server

The installer initializes Swarm, creates the `opsifier` overlay network, then starts two services:

| Service            | Image       | Mounts                             | Published             |
| ------------------ | ----------- | ---------------------------------- | --------------------- |
| `opsifier`         | our image   | Docker socket, `/var/lib/opsifier` | 3000, host mode       |
| `opsifier-traefik` | `traefik:3` | `/var/lib/opsifier/traefik`        | 80 and 443, host mode |

### What the panel's image contains

Besides Node and the panel itself, the image has to carry everything a build runs:

| Tool                   | Package or location                                  | Used for                                                                   |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `git`                  | `git`                                                | Fetching repositories and checking them before a source is saved           |
| `ssh`                  | `openssh-client`                                     | Git over SSH with a deploy key                                             |
| Docker CLI with buildx | `docker-ce-cli`, `docker-buildx-plugin`              | Dockerfile and Railpack builds, against the mounted Docker socket          |
| `bsdtar`               | `libarchive-tools`                                   | Listing and unpacking uploaded zip, tar, gzip, bzip2, xz, zstd, 7z and rar |
| Nixpacks               | `/opt/opsifier/builders/nixpacks/<version>/nixpacks` | One binary per version offered in the UI                                   |
| Railpack               | `/opt/opsifier/builders/railpack/<version>/railpack` | One binary per version offered in the UI                                   |
| `pack`                 | Cloud Native Buildpacks CLI on the `PATH`            | Buildpacks builds                                                          |

The offered versions are listed in `packages/contract/src/service-tabs/source.ts`. A version that is not installed falls back to whatever is on the `PATH` and says so in the build log. `OPSIFIER_BUILDERS_DIR` moves the builders folder for development.

## Web app

React 19, Vite, TanStack Router and Query, Tailwind 4 over our own tokens, Radix primitives, xterm.js for consoles, CodeMirror for editors, uPlot for charts, i18next with English and French.

```
apps/web/src/
  app/         shell, router, providers
  ui/          design system components
  features/<feature>/
  i18n/<lang>/<feature>.json
```

Every screen handles loading, empty and error states. Forms show a banner plus per-field messages from the API's `fields` map. Async buttons show progress and disable themselves.

### Design language

The concept is **a precise instrument panel**: precise, quiet, information first. It must not look like a stock component kit or a soft card-based dashboard.

- **Structure:** a slim top bar holds the mark, breadcrumb, primary navigation (Overview, Activity, Monitor, Domains, Settings), command palette trigger and user menu. There is no main sidebar. Service pages use horizontal underlined tabs below a header.
- **Surfaces:** flat. Separate things with 1px hairline rules and whitespace. Prefer tables and ruled lists to grids of cards. No drop shadows except on overlays. Corners are 3px.
- **Type:** Poppins for text and IBM Plex Mono for every machine value (hosts, ports, images, IDs, sizes), with tabular numerals. Self-hosted through `@fontsource`.
- **Colour** (CSS variables, light and dark both first-class):

| Token         | Light     | Dark      |
| ------------- | --------- | --------- |
| `--bg`        | `#FFFFFF` | `#0F1B36` |
| `--raised`    | `#F6F7FA` | `#16264A` |
| `--ink`       | `#16264A` | `#FFFFFF` |
| `--muted`     | `#5B6781` | `#A9B4CA` |
| `--rule`      | `#DFE3EC` | `#2B3C63` |
| `--accent`    | `#16264A` | `#E3A33A` |
| `--highlight` | `#E3A33A` | `#E3A33A` |
| `--ok`        | `#1F7A6E` | `#3DBFAE` |
| `--busy`      | `#B7791F` | `#E3A33A` |
| `--off`       | `#7B869C` | `#8592AC` |
| `--bad`       | `#BE2453` | `#FF7A9C` |

The brand is navy `#16264A`, white and amber `#E3A33A`. The top bar is navy in both themes. Amber fails contrast on white, so in the light theme it only decorates something another cue already conveys: the active tab, the mark, a signal point. It is never text there.

- **Signature elements:** a status lamp on every service, a _wake strip_ showing the outcome of the last 24 deployments as small segments, and a persistent _activity tape_ along the bottom edge showing running Actions, which expands into a live log drawer.
- **Motion:** 120 to 180 ms, transform and opacity only, disabled under `prefers-reduced-motion`.
- **Accessibility:** WCAG AA contrast, visible focus rings in the accent colour, full keyboard use.

### Visual language

People open this panel to check that their server is fine, so a screen must say so before anyone reads a word of it. The parts are in `apps/web/src/ui/visual`, and the dev server shows them all, in both themes, at `/src/ui/visual/gallery/`.

- **State first.** Anything with a state shows a `Lamp`, at the start of its row or in its header. `visual/state.ts` is the only source: it gives each state (failed, degraded, unknown, in progress, running, stopped) one colour, one shape, one label and one motion. Translate domain statuses with its `stateFrom...` helpers. Never choose a colour or shape by hand, and never let colour carry a state alone.
- **Problems first.** Lists, counts and summaries follow the order in `state.ts`. A screen with many things opens with a `HealthSummary`, whose counts are its filters; headers use its `row` form.
- **A visual form for every number that matters.** A value against a limit is a `Gauge`, or a `GaugeBar` in a table row. A trend is a `Sparkline`. Missing data is a drawn state, never a blank or a zero. A bare number is only for plain counts and machine values.
- **Pictograms say what a thing is, lamps say how it is doing.** Use `Pictogram`, from the hand-drawn set in `visual/pictograms.tsx`: one 24-unit grid, one 2-unit stroke, ink plus one amber accent, and it must read without the amber. No third-party logos or trademarks and no imitations: tell products apart by what they do.
- **Short labels, details on demand.** Labels are one or two words. Sentences, exact figures and history belong in tooltips, drawers and detail pages.
- **Illustrations are for empty and error states only**, through `Illustration`, which picks the theme's variant and reserves its space.
- **Colour and motion.** State colours are the `--state-*` tokens in `theme.css`, with `--state-degraded` (`#C94F1E`, `#FF8F5E`) added for degraded, and `--track` (`#ECEEF3`, `#2B3C63`) for the unfilled part of a gauge. Indicators reach 3:1 against their surface in both themes, checked by `visual/contrast.test.ts`. Only in-progress work moves continuously; problems flash three times and then hold still; nothing moves under `prefers-reduced-motion`, and a still lamp is complete.

## Testing

- Vitest covers compilers, services, routes and UI components, using `FakeDriver`.
- `OPSIFIER_E2E=1` runs the integration suite against a real Docker daemon inside a Docker-in-Docker sandbox. Never run it against a host daemon.

## Definition of done for a feature

1. Every field, rule and acceptance criterion in the feature's specification is implemented.
2. Invalid input is rejected with a clear message.
3. Typecheck, lint and tests pass.
4. Strings exist in English and French.
5. Loading, empty and error states exist.
6. It was exercised running, not only compiled.
