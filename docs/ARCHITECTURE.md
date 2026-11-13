# Opsifier architecture

Opsifier is a self-hosted control panel. You install it on a Linux server with one command, then deploy apps, databases and compose stacks from a web UI. Docker Swarm runs the workloads and Traefik routes the traffic.

This file is the contract every contributor builds against. Change it when a decision changes.

## Principles

1. **One container, one SQLite file.** No external database or queue.
2. **Desired state lives in the database.** A deploy compiles it into a Swarm service spec and a Traefik file. The compilers are pure functions, so they can be tested without Docker.
3. **Anything slow is an Action.** It is queued, logged, cancellable and visible on the Activity page.
4. **Secrets stay on the server.** They are encrypted at rest and never appear in list responses. A page gets names: a dedicated endpoint reveals a value when someone explicitly asks for it, and the asking is recorded.
5. **No outside calls from the browser.** Fonts and assets are self-hosted. There is no telemetry: the one call home is a server's own address, described under [Opsifier addresses](#opsifier-addresses), and it can be turned off.
6. **Every feature is free.** No tiers, no gates, no upsell.

## Repository

| Path                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `apps/server`        | Hono API, Action engine, Docker and Traefik drivers               |
| `apps/web`           | React single-page app                                             |
| `packages/contract`  | Zod schemas shared by the server, the web app and the API clients |
| `packages/client`    | The HTTP client behind the CLI and the MCP server                 |
| `packages/cli`       | `opsifier`, the command line, see `docs/CLI.md`                   |
| `packages/mcp`       | `opsifier-mcp`, the MCP server, see `docs/MCP.md`                 |
| `templates`          | Our own application catalogue                                     |
| `scripts/install.sh` | One-line installer                                                |
| `infra/names`        | The address service: Lambda, CloudFormation, deploy script        |
| `scripts/sandbox.sh` | Docker-in-Docker sandbox for checking against real Docker         |

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
- Errors always have the shape `{ "error": { "code", "message", "fields"? } }`. Validation failures return 400 with `fields` mapping each field to its message. A JSON body may hold only the fields its route defines: `jsonBody` closes every object in the schema, so an unknown key is a 400 that names it. A number in a URL is plain digits.
- Long operations return 202 with the Action they created.
- Destructive endpoints that the UI confirms by typing a name take `{ "confirm": "<name>" }` and check it on the server.
- Authentication is either the session cookie or `Authorization: Bearer <token>`. The cookie is `__Host-opsifier_session` over HTTPS and `opsifier_session` over plain HTTP, and a request is only ever authenticated by the one matching its scheme. Cookie-authenticated mutations must pass an `Origin` check that compares scheme and host. `X-Forwarded-Proto` only counts from a configured trusted proxy.

### Persistence

SQLite through `better-sqlite3` and Drizzle, with migrations checked in and applied at boot. The data directory is `/var/lib/opsifier` in production and `.data` in development.

One panel owns a data directory. It holds an exclusive lock on `<data>/panel.lock` from before it touches anything else until it stops, so a second panel started on the same directory refuses to boot and says why. The lock is a never-committed SQLite transaction: the kernel frees it when the process ends, even by SIGKILL, so a crash can't leave a stale lock. The panel's own commands (`setup`, `rollback`, `reset-password`) open the database without it.

Every statement goes through `StorageHealth` (`core/db/storage-health.ts`). The first one that fails because of the storage, whatever caused it, blocks further changes: mutating requests get `503 storage_failing`, nothing new can be enqueued, the queue stops and a banner stands above every page. Reads keep working, and an Action in progress can still be cancelled, since stopping work is the one change that cannot make things worse. While the block lasts, a real write (a file on the data disk, a committed row in the database) is tried every five seconds and the block lifts as soon as one succeeds, so fixing the disk is all it takes.

A service stores its type-specific configuration as one JSON `spec` column validated by Zod, including its mounts, ports and resources, and its variables sealed. Data queried across services gets its own table: domains, actions, backups, users, tokens.

### Actions

`actions.enqueue({ type, projectName?, serviceName?, title, run })` returns the row immediately.

- One Action runs per service at a time, and others wait in FIFO order. Actions without a service run concurrently, up to four.
- Deployments of one service queue, and a further deploy request while one is already waiting joins it, so a webhook delivery is never lost. Operations that cannot safely follow a running one are refused with 409 and an explicit message: destroy, rename or move while an Action is active on the service, and start, stop or restart during a deployment. The rules are in `core/actions/policy.ts`, checked in the same tick as the insert, and a deploy joining a waiting one passes on what it asked for, such as a forced rebuild.
- An Action that restarts the panel calls `ctx.handOver()`: its row stays `running`, nothing else can be queued until the process ends, and whichever process starts next finds the row through `claimInterrupted` and concludes it.
- `run(ctx)` receives `ctx.log(line)`, `ctx.phase(name)` and `ctx.signal`. Output is appended to `<data>/actions/<id>.log` and streamed to the topic `action:<id>`. A phase is a short key for the step under way (`pull`, `rollout`, `verify`, `importing`), stored on the row, so the interface can say what an Action is doing, or where it stopped, without reading its log.
- Statuses are `queued`, `running`, `succeeded`, `failed`, `cancelled` and `uncertain`. At boot, any `running` row becomes `failed` with the reason that the panel restarted, except a deployment, which is `uncertain`: nothing recorded how it ended, and Docker may well have finished it.
- `uncertain` means the panel cannot say how something ended, because it could not write that down. If the database refuses an Action's final status, its outcome is held in memory and written as soon as storage is fixed, and until then the row reads as `uncertain` everywhere rather than staying `running`. If a run itself fails because the panel's database did, it ends `uncertain`, since what it changed outside the panel happened and could not be noted down. A full disk on the work's own files is an ordinary `failed`.
- The newest 1,000 Actions are kept. Older rows and their log files are pruned at boot and hourly, never one that is queued or running.

### Docker

`core/docker/driver.ts` defines one interface with two implementations: `DockerodeDriver` and `FakeDriver`. `OPSIFIER_DRIVER=fake` exists for local development and tests. Production never falls back to it. On the fake driver nothing is real, so the panel says so: the system info reports `simulated`, every screen carries a notice that can't be dismissed, and every Action's log says it near the top.

Docker has to be able to do what the panel needs, and the panel finds out from Docker rather than from its version number: `core/docker/support.ts` reads the Engine API the daemon speaks (1.45 or later, which is Docker 26.0), whether it has Swarm and, at runtime, whether this node manages it, and the network and volume drivers it lists. A version number alone can't say any of that. `setup` runs those checks before its first change. A running panel runs them before every call that changes something in Docker, through a driver that refuses with `503 docker_unsupported` and the reason, so a command the engine can't run is never sent to it. Reads still work, so the panel can say what is wrong, and ending what is already running stays possible. The Docker CLI's `buildx` and Compose plugins are checked the same way, right before something needs them, and the settings page lists whatever is missing.

Workloads run as Swarm services named `<project>_<service>`, and a project owns two attachable overlay networks: `opsifier-<project>`, its services' own network, and `opsifier-<project>_proxy`, which carries only the proxy's traffic to them. Project names allow no underscore, so a Swarm service name can only be split one way and a proxy network can't be mistaken for another project's. Every service also has a stable identifier, `services.id`, which never changes through a rename or a move and is written to Docker as the label `opsifier.id`.

Apps, Compose children and a database's web tools join both of their project's networks, so that a domain added to one later works at once. A database joins only its project's own network. The proxy joins every project's proxy network and no project's own, and it shares `opsifier` with the panel and with nothing else. Builds use the builder's own network. So a project reaches no other project over any network, by name or by address, and the proxy never reaches a database. What a service answers to, `<project>_<service>`, `<project>-<service>` and `<service>`, means nothing outside its project's network.

A project joins only the networks it owns, and a project that needs a database from another one goes through that database's published port, on the Expose tab, and the server's address. Two things stop a deployment from assuming otherwise, each in terms that say why and offer that way instead: a service whose environment or command names another project's database by its address, and a Compose file that joins a network its project does not own.

A panel upgraded from a version with one shared network leaves everything running as it is, and every deployed service shows changes waiting. A database moves at its next deployment, which replaces its task as any deployment does, stop-first: it leaves `opsifier` and keeps its project's network with the same names, port, password and connection strings. A deployment that would cut off a service in another project still connecting to it over `opsifier` is refused, with nothing changed, until that service is changed. An App, a Compose stack or a web tool moves at its next deployment too, onto the proxy network, and the proxy stays on the project's own network until the last of them has moved, because Swarm gives a running service no new network without replacing its tasks. Each change to the proxy's networks restarts it, so it joins the proxy networks of every project at once, at the first deployment after the upgrade, and leaves each project's own network once, when that project has finished moving.

A task stops on the signal and within the delay its service was given, by default the image's own signal and ten seconds. A custom command runs as itself, so it needs nothing the image lacks and the stop signal reaches it; only a command that needs a shell to mean what it says (expansions, pipes, lists and the like) goes through `/bin/sh`. Every task is limited to 8192 processes, so orphans stay bounded whether or not it runs an init to reap them.

A named volume is a local Docker volume bound to `<data>/projects/<project>/<service>/volumes/<name>`, which is world-writable so that a non-root container can use it. At each deployment, what a volume already holds is checked against the user the image runs as, with the groups the service adds, and anything that user could not write is named in the deployment's log. A service that publishes host ports always updates stop-first, since a new task could not bind a port its predecessor still holds, and is limited to one replica on a host. A bind mount that exposes the data directory or the Docker socket needs an explicit confirmation, stored with the mount and checked again by the compiler. Any path on the host is an administrator's to give, as is a new Linux capability: see Accounts, access and API keys. A rename moves the folder and removes the old Docker volume, and the next deploy or start makes one under the new name.

A deploy pulls the image, rolls out and then watches the tasks: it only succeeds once the new tasks have stayed running through a stability window (`core/docker/rollout.ts`), and it fails if they crash or run out of time. Before any of that, it works out how much room the image is expected to need on Docker's disk and stops there, with nothing changed, if it can't fit (`features/services/disk-check.ts`). Deploys and restarts raise Docker's `ForceUpdate` counter rather than changing the task's environment. The container env is `PORT` from the primary domain's target port, then the project's variables, then the service's. `$(PROJECT_NAME)`, `$(SERVICE_NAME)` and `$(PRIMARY_DOMAIN)` are filled in only for a service that has turned that on in its Environment tab, and anything else that looks like a variable stays as typed.

A deploy that fails puts back what it replaced, stop-first or not, and says so in its result. Before pulling or building it gives the outgoing image a name of its own, `opsifier/<project>/<service>:previous`, because Docker's image store drops an image the moment its last tag moves, however many containers still name it by ID. Published ports are checked before anything is replaced: against other services, plain containers, and what is listening on the host, read from `/proc/net` by a helper in the host's network (`features/services/host-ports.ts`). Docker reports a port conflict only once it fails to bind, which is too late for a stop-first update.

What runs is pinned. Right after the pull or the build, before anything is replaced, the name is resolved once (`features/services/image-identity.ts`) and from then on the deployment deals in that answer: Swarm gets `repository@sha256:...` for an image from a registry, so that other nodes pull exactly that, and the image ID for a local build, which Swarm never tries to pull. A tag that moves later changes nothing, in a restart or anywhere else. A build from a repository ends with one more step that writes the commit into the OCI label `org.opencontainers.image.revision`, whichever builder ran, because not all of them can set a label and the panel is the one that knows the commit. The deployment records as data, on its Action, what was requested (branch, tag or commit), which commit was built, what the label says, the image name, ID and digest, the tasks running at the end and whether it answered. A failed one keeps what it had established, and an old row simply has none of it.

Each successful deployment of an App keeps a release (`service_releases`): the image under a tag of its own, `opsifier/releases/<service id>:<n>`, the identity above, and a sealed snapshot of what it ran with: the compiled Swarm spec, the contents of its file mounts and the record `services.applied` then held. The snapshot never leaves the server, and the API lists only metadata. It holds no credential for a registry or a Git host: a registry password goes to Docker separately, and a Git key or token never enters a compiled spec. Compose stacks and databases have no releases, since a stack is more than one container and a database's files can't go backwards under an older engine. A database still records the image it really runs, shown next to the configured image and the catalogue's proposal.

Going back is `POST .../releases/{n}/rollback` with `{ "confirm": "<service>" }`: an Action of type `service.rollback`, a deployment in everything but where its image comes from, listed with the deployments and treated like one by the wake strip, notifications and a restart that catches it running. Nothing is pulled, built or fetched: the image comes by its ID, already on the server, and the tasks are held to the node the panel runs on, the one node that has it. It joins the networks the project uses today, whichever layout the version was deployed on, and a version whose variables name another project's database is refused, as a deployment would be. It is refused with 409, before any change, while other work is active on the service, and when the image is gone, the tag keeping it was moved or removed, the version's volumes and host paths are not the ones in use now, it was deployed under another name, or it is already what runs. Volumes are never touched: data written since is kept, nothing is restored and no application migration is undone, as the dialog says. What the version ran with comes back, including its variables, while what is saved stays saved, so `pendingChanges` then says what the next deployment would still bring. A rollback ends as a new release that records which one it went back to.

Each service keeps its newest releases: five, unless changed in Settings, General (`PUT /api/v1/server/releases-kept`, 1 to 50). That costs disk on the server, so the number is shown on the Deployments tab, a rollback counts as a release like any other, and lowering the number gives the older ones back at once. A release's tag is a claim the Docker cleanup honours, and its images go when the service does.

A task that started has only proved that it started. A health check in the image holds the task in `starting` until it passes, as Swarm does for databases, and for anything with a domain the deploy then asks the proxy's task to connect to the primary domain's port, so over the network the traffic really arrives on. Not answering is reported in the log and on the service rather than failing the deploy: every App gets a default domain, and a background worker has nothing to answer with.

What Docker holds is only the panel's if it says so, in the labels `opsifier.project` and `opsifier.service` (and `opsifier.id`, below). Deploying, stopping, starting, restarting, renaming and destroying all check them, and a new service can't take a name something else already uses in Docker. A Compose stack's containers carry the same labels, set by the generated override, and a database's volume asks Docker for them when it is created. What is someone else's is left exactly as it was.

The spec column is what was saved. What was applied is a separate, sealed record (`services.applied`), written by a deploy that succeeded, which holds the compiled spec with `$(secret.x)` references filled in and a hash of each file mount, minus what differs between two deploys of the same settings. Comparing the two is how a service knows it has changes waiting. `GET .../deployments/pending` turns that comparison into a list of what the next deployment would change, values only where they can't be a secret, variables and file contents named and never quoted. A deployment only ever writes the fields it owns: it reads the row in the same tick as its write, so a setting saved during a pull or a build stays saved.

`services.runtime_uncertain` says nobody can vouch for what is running. A deployment writes it before it touches anything and clears it when it is done, so a panel that dies halfway leaves it behind with nothing further to do at boot, and so does a failed update that could not be put back. While it is set, backups, restores, password changes, a destroy, a rename, and changing or removing a published port or a domain are refused with 409, until a deployment succeeds.

### Building from source

A service whose source is GitHub, Git, an inline Dockerfile or an upload is built on the server by its deploy Action, before the rollout. The image is tagged `opsifier/<project>/<service>:latest` and exists only on this server, so nothing is pushed anywhere.

A rename moves the tag with the service, so that starting it again never has to clone or build anything. The code goes in `<data>/projects/<project>/<service>/code`, replaced completely at every deploy. A repository is fetched one commit deep into a temporary directory and checked out with no `.git`, so a force push or a local change cannot get in the way and the Docker context stays clean. The commit's SHA reaches the build and the container as `GIT_SHA`.

The build path is both the detection root and the Docker context. With no saved settings, a `Dockerfile` in the build path is used if there is one, and Nixpacks otherwise. A builder's command fields replace what it would have detected, and `railpack.json`, `nixpacks.toml` and `project.toml` in the build path are honoured. Three sets of values stay separate. The runtime variables are the container's and do not reach a build. Build variables are its arguments, and whatever a Dockerfile declares as `ARG` can be read back from the image's history, so nothing secret belongs there and a sealed reference is refused. Build secrets are handed to one step at a time and can be replaced but never read back: a Dockerfile reads one with `RUN --mount=type=secret,id=NAME`, BuildKit keeps it out of the history and the layers, Railpack receives it the same way, and Buildpacks through the build phase's environment. Nixpacks writes everything it is given into `ARG` and `ENV` lines, so it gets none. Every value reaches a tool by name through the environment of its process, never in an argument. Besides these, a build gets `PORT` and `GIT_SHA`. Names that steer the tools themselves (`PATH`, `DOCKER_*`, `BUILDKIT_*` and the like) are refused.

A service that was already building when these scopes appeared has `build.inheritsRuntime`: its builds go on receiving its runtime variables, so that a working build does not stop working or start producing something else, until someone sets what it needs and turns that off, one way only. It never covers anything sealed, a Dockerfile build only receives the names that Dockerfile declares (anything else has no effect on it), and the build log and the Environment tab both say what is being passed. A service created afterwards gets nothing it wasn't given.

A file of build variables can be written before each build, and whether it enters an image is decided explicitly when it is turned on. In the build context, a `COPY` can put it in a layer, so it only ever holds build variables. Kept out of it, it lives in the build's temporary folder and a Dockerfile mounts it as the build secret `env-file`.

External programs go through `core/tools`: `spawn` with an argument array, never a shell, and the environment each one needs instead of the panel's own. Every program leads its own process group, so cancelling an Action or running past the build timeout (`OPSIFIER_BUILD_TIMEOUT_SECONDS`, one hour by default) kills everything it started. A failed step fails the deployment and leaves what is running alone. `FakeTools` replaces all of this when the Docker driver is fake.

A source can be pinned to a commit. A deployment runs exactly that commit for as long as the host serves it, even after a force push has moved a branch away from it. Once it is gone, the fetch fails, says the commit was rewritten or removed, and leaves what is running alone: the way on is to point the source at a branch, a tag or a commit that exists.

A failed fetch is told apart as refused access, a missing ref, a network problem or a size problem, each with the next step to take. A checkout is held to the same size budget as an uploaded archive, watched as it runs and checked once more at the end, and to a time budget, and it streams to the disk: the panel keeps none of it in memory.

Git only ever speaks https and ssh: remotes are validated when saved, and `GIT_ALLOW_PROTOCOL` holds git itself to that for anything it is redirected to. Prompts are off, no system or global configuration is read, and `--` comes before every value that came from a request. Git runs the SSH command and the credential helper through its own shell, so they contain only fixed flags and paths the panel generated. TLS is verified and redirects are not followed, so a repository that has moved has to be saved under its new address. SSH servers are checked against an administered list of known hosts, `StrictHostKeyChecking=yes` with a `known_hosts` built from the registry for that one operation: a server with no entry, or a key that does not match, is refused.

SSH deploy keys and the GitHub token are sealed at rest. For the length of one git operation they exist in 0600 files under `<data>/tmp`, which is also emptied at boot, and they are removed from any output that could mention them. Each credential goes to the one repository it was given for, compared by host, port and path however the address is written. A deploy key is bound to the first repository it is used for and refuses any other until it is deleted, so that a saved URL can't quietly send it elsewhere; replacing a key keeps the binding. The panel's GitHub token is presented through a credential entry scoped to the repository's path, and is used by a service only for the repository an administrator saved for it. The token can be pasted, or granted through an OAuth app the owner registers on GitHub and saves under Settings: the panel sends the browser to GitHub with a state that is good for one trip and ten minutes, trades the code it gets back for a token, checks it with GitHub and seals it like any other, and removing it gives the grant back. A stored registry password belongs to the repository of the image it was entered with, and moving to another asks for it again.

Build paths and Dockerfile paths are checked again with `realpath` once the checkout exists, because a symlink in the repository can point anywhere. Uploads are limited to 1 GiB, counted as they arrive. `bsdtar` reads every supported format, an archive is listed and refused if an entry would escape, unpacked without `-P`, and then walked: links that lead outside and anything that isn't a file, folder or link fail the build, as does unpacking past a size limit.

A deploy trigger is a token per service, 48 hex characters, stored hashed and shown once. A CI job sends it to `/api/v1/deploy` as `Authorization: Bearer <token>`, and `?forceRebuild` forces a rebuild: no cache, and the base images fetched again where the builder allows it, as `docs/BUILDERS.md` sets out builder by builder. The running tasks are replaced after every deployment, forced or not, and the build's log says what a forced rebuild did. A push webhook has its own secret, sealed because each delivery has to be signed again with it, and its own URL, `/api/v1/deploy/hook/<id>`, where the id names the webhook and proves nothing. A delivery counts only if its `X-Hub-Signature-256` is correct over the bytes that arrived, a missing one counts as a wrong one, and only a push to the repository and branch the webhook was issued for deploys, at the commit the push announced. A delivery is remembered by its id and by the hash of its signed body, since a signature does not cover the id, so a redelivery or a replay under a new id starts nothing, across restarts too. A delivery that could not start anything is forgotten, so its redelivery still can.

Changing a service's repository or branch revokes its token and pauses its webhook, because both were issued for what it deployed before: rotating the webhook's secret resumes it and binds it to the new values. Tokens and hand-given webhook secrets record who issued them, and that account's password, email or rights changing revokes them. A token issued before this existed keeps working as a bearer token and in its old URL until it is replaced, and its webhook keeps being accepted there, signed with the old token, until it is rotated.

### Databases

A database is a service row whose `type` is its engine (`postgres`, `mysql`, `mariadb`, `mongo`, `redis`) and whose spec carries one extra field, `database`, next to the `source`, `env` and `resources` an App has. `compile/database/` holds its pure sub-compilers. It runs one task, stop-first, with a healthcheck, so a deploy only succeeds once the engine answers. Data lives on a named Docker volume whose name is fixed at creation, so a rename cannot disconnect it. Destroying the service leaves it in place, and a new database of the same name gets a volume of its own.

An image has to name a fixed version: a digest, or a tag with at least a major and a minor number, so that a pull can never move the engine under its data. `latest`, no tag and a bare major are refused wherever a database's image is set, and a database already running one keeps it until its image is changed. A database's image only changes from its Advanced tab. Moving to another major version, or to an image whose version can't be compared, takes the service's name typed when it is saved. Saving changes nothing that runs: the deployment that applies it first backs the whole server up to Local Disk and stops, with the old version still running, if that fails, and a new version that does not start is rolled back to the previous one. A stopped database has nothing to read its data with, so it stays on the version it was stopped on until it has been started and deployed.

A running task and a healthy one say nothing about whether anyone can sign in, so a separate probe, `GET .../database/availability`, reports the two as separate facts and runs a real sign-in with the panel's credentials.

Passwords are generated with a CSPRNG, sealed at rest and only returned by the audited reveal endpoint of the Credentials tab, one secret per request, with every reveal recorded in the activity log. Connection URLs percent-encode every part.

Changing a password is an Action that records its intent first, applies the change in the running engine (or, for Redis, restarts it with the new value), connects with the new password to verify it, and only then saves it. If anything fails, the old password is restored. If the panel dies midway, a recovery Action at the next boot probes which password the database accepts, so the panel and the database always end up agreeing.

Saving a public port only stores it, after checking other services and reserved ports. The next deployment publishes it on the host in host mode, and if Docker reports the port as taken on the node, the database goes back up on the port it had and the deployment fails saying so. Until then the page and the connection details show what is really published, not what was saved.

### Compose stacks

A Compose stack is a service row whose `type` is `compose` and whose spec carries one extra field, `compose`, next to its variables, `notes`, the deploy token and the domains. It is not a Swarm service: its children are plain containers started by the Docker Compose CLI, spawned as an argument vector with the stack's variables in the process environment. The Compose project is `<project>_<service>`, its own identifier, so stacks cannot reach each other's containers.

Files live in `<data>/projects/<project>/<service>/code`. An inline file is written alone and a Git checkout is laid over the folder, tracking what it brought in `compose-manifest.json`, so anything a stack writes through a relative mount survives a deploy. A deploy writes a generated override next to `code/` (so a repository cannot collide with it) that puts every child on both of the project's networks under the alias `<project>_<service>__<child>`. That is the address a domain's Compose service field routes to, and the double underscore keeps it out of reach of any service name; a domain with no child chosen has a router with no servers and answers 503.

`compose/inspect.ts` reads the file with no side effects, after every save and on page load. Errors stop a deploy (invalid YAML, a relative path that leaves the stack, a dependency that doesn't exist). A network the project does not own can't be confirmed at all: an external or fixed-name network other than the project's own, a network mode that shares another container's network or a named one, Docker's default bridge, a build joining another network. Each is an error, and since `include`, `extends` and variables can introduce one the inspection doesn't read, what Compose itself resolves is held to the same rule right before anything starts. Anything else that reaches the host (the Docker socket, the data directory, other host paths, privileged mode, host namespaces, added capabilities and devices) or outside the stack (external or fixed-name volumes, another container's namespaces) needs an administrator to confirm that exact file: the confirmation is stored as its SHA-256 and checked again at deploy, so an edited file asks again. A value Compose would interpolate there counts as reaching out, since the stack's variables could make it say anything. Everything else is advice that stops nothing. A Git file is only known after the fetch, so the same checks run again at that point. A stack's state comes from its containers: it is running only when every child is, a child that finished cleanly during its deploy counts as done, and anything else that is down is a failure of the stack. Its logs are read container by container through the Docker API, not with `docker compose logs`, which runs standard output and standard error together.

Destroying a stack runs `docker compose down` and removes its routes and folder. Named volumes are kept, on purpose: deleting them is a separate decision, as for any service.

### Boxes

A box is a service row whose `type` is `box` and whose spec carries one extra field, `box`, next to the `source`, `env` and `domains` an App has: its modules, processes, hooks, IDE and build history. Its source is a Dockerfile that nobody writes. `features/box/dockerfile.ts` generates it from the modules, processes and hooks whenever one of those is saved, and a deployment renders it again first, in case the matrix moved under a box since. Everything downstream is the ordinary App pipeline, so a box builds, rolls out, rolls back and is cleaned up like any other service.

The module matrix in `packages/contract/src/service-tabs/box-modules.ts` is the one list of what a box can contain: every version of every module pinned to one image or package. The server refuses anything else, the page offers nothing else. Runtimes are copied whole from their own official images onto one small distribution, the libraries they need are resolved the way those images resolve them, and every module is smoke-tested as a build step, so a runtime that lands broken stops the build. Layers run from what every box shares to what changes most: changing a process or a hook only rewrites the top of the image.

An extension that the chosen version can't have is refused on save, and again before a build (the matrix may have changed since it was saved), and an extension that installs but does not load fails the build's own check. Each of those is before anything running is touched.

A box runs one task, stop-first, because two tasks would be writing to the same workspace. Everything inside it runs as the user `box`, uid and gid 1000, and only the build hook runs as root, while the image is built. The workspace, a named volume mounted at `/workspace`, is the only thing that survives a deploy: the Storage tab can add mounts but not move or remove that one. Who a box runs as is not a setting.

The main process is a POSIX shell script (`features/box/supervisor.ts`), since nothing else is guaranteed to be in an image built from any combination of modules, tested against a real shell in `supervisor.test.ts`. It runs the start hook, then keeps each process running, one group per process, restarting a crashed one with a backoff that doubles up to 30 seconds and resets after a minute of staying up. Its output reaches the service's logs with the process's name in front. `boxctl`, next to it, reads and steers what the supervisor leaves in its state folder: that is what the panel reaches through `docker exec` for the Processes tab and to restart one process.

A hook is a script run with `set -e`. The build hook runs while the image is built, so a failure stops the build and leaves what is running alone. The start hook runs at every start, in the workspace, before any process, and the image's health check holds the task in `starting` until it has finished, so a deployment waits for it; a failing start hook exits 78 and fails the deployment, which puts the previous version back. After a deployment, the Scripts tab's `runAfterDeploy` is what runs inside the new task.

A preset fills in modules, processes and hooks, and can add starter files, but only where nothing of that name exists: it replaces settings, and never a line of anyone's code.

A build records why it happened (`spec.box.history`): which module versions moved, which pins moved under the same version (a security update), whether someone forced it, and who. A forced rebuild passes `--no-cache --pull`, since a pinned tag is how a fix to the same version arrives. What a build contains is kept as a manifest, so the next deployment, and the page before it, can say exactly what will change.

### The browser IDE

A box can open its workspace in a browser, as a file tree and a text editor, at `/ide/<project>/<service>` on the panel's own address. It is its own authority and a boundary of its own: its routes under `/api/v1/ide/<project>/<service>` take one thing, the bearer token issued for that box, ask for it on every call and answer before anything else about the request is looked at. A panel session does not open it, and an IDE token opens nothing else in the panel. A wrong token, a missing one, a revoked or rotated one, a box with the IDE off and a service that does not exist all get the same 401, and only someone holding the right token, once it has run out, is told it has expired.

The token is shown once and stored hashed. It always expires, within 90 days, rotating or revoking it ends it at once, turning the IDE off ends it for good, and the account that issued it losing its rights or being deactivated ends it too. Issuing one takes a signed-in operator, never an API key. Opening the IDE is written to the activity log.

Its reach is the workspace and nothing else, enforced on the server, in `features/box-ide/confined.ts`. There is no terminal and no route that runs anything, so there is no shell to get out through. A workspace can hold links the box wrote itself, so a path that looks fine can point at the panel's own secrets: no link is ever followed. On Linux every step of a path is opened from the descriptor of the step before it through `/proc/self/fd`, so a directory swapped for a link mid-walk can't redirect anything. Files are read with the descriptor they were opened on, replaced by a temporary file and a rename, created as the box's user, and refused when they changed since being read. A file reaches the browser as JSON text, never as a page of its own, so nothing in a workspace can run in the panel's origin.

### What a deletion removes

Deleting a service removes its configuration and everything it ran (Swarm service or stack, routes, generated files), and keeps its named volumes and backups: their files stay exactly where they are. Each kept volume is written to `retained_volumes`, which is what makes it deletable: the Monitor page's Storage tab lists them, and deleting one is a separate Action, one volume at a time, with its name typed and checked on the server. A deletion can never reach a volume the panel did not keep itself. A new service that mounts the same named volume picks its data up again, except a database, which always gets a volume of its own. A project can only be deleted once it holds no services, and it never takes a kept volume with it. Every dialog that deletes something says what goes and what stays.

### Templates

`templates/*.json` is the catalogue: original documents, one per application, in the format of `packages/contract/src/templates.ts`. A pasted schema (Create from schema) is the same format, and the document is strict: no project name, no host path except the single `docker-socket` mount that a person has to confirm, no field the schema does not know. Every image is pinned, every service with a domain declares a start-up test, and only an application with a real fixture in `templates.e2e.test.ts` may be marked `verified`.

A form is generated from the document. Installing creates configuration only, in one transaction: database rows through `prepareDatabaseSpec`, app and Compose rows, default domains and generated secrets. Values in a document's `env` may use `{{project}}`, `{{server.host}}`, `{{params.x}}`, `{{secrets.x}}` and `{{services.<key>.<attribute>}}` (name, host, domain, url, and for a database port, user, database, password, passwordEncoded, url and rootPassword). A database dependency is a real database service, or an existing one in the project. Anything sealed, generated secrets and database passwords alike, is written into the service's environment as a reference (`$(secret.x)`, `$(db.x.password)`) and stored in `spec.references`: it is resolved once per deploy from sealed values, so the environment never holds a secret in plain text and a rotated database password reaches the app at its next deploy.

`template_installs` keeps what each install created so it can be shown, resumed (a second deploy skips what already runs) and removed as a unit. Deploying is a separate Action that deploys the parts in dependency order, each through its own service's ordinary deploy. Nothing is deployed until someone asks.

### Backups

A storage provider is a destination behind one interface (`storage-providers/backends`): local disk, SFTP, FTP, the S3 family (AWS, R2, Spaces, B2, Wasabi, generic), Dropbox and Google Drive. Credentials are sealed per provider and never returned. Saving a provider runs the same check every time: it lists, writes, reads back and removes a probe file, so a provider that saves is one that works, and one that can no longer be reached stays deletable. Uploads are all or nothing at every destination: a temporary name then a rename, or the store's own atomic commit. Dropbox and Google Drive sign in with the operator's own OAuth app, keep a refresh token sealed, and when access is revoked they turn disconnected and are hidden from backups until connected again.

A backup is an Action. A database backup holds one of three things, each with its own format, and its file says which: one database (`pg_dump` plain SQL, `mysqldump`/`mariadb-dump`, `mongodump --archive --gzip`), a whole server with its accounts (`pg_dumpall`, the same dump tools across all databases, `mongodump` of everything), or users and roles alone. It is exported inside its own container, streamed out through `docker exec` and hashed as it is written, so memory stays bounded whatever its size; the SQL formats are gzipped by the panel, and `--set-gtid-purged=OFF` on MySQL leaves a GTID source untouched. A named volume is packed by the panel's own tar writer, which keeps numeric owners and modes, stores hard links as copies, skips sockets, and refuses devices and every symbolic link, on the way in and on the way out, so a volume holding one fails its backup by name rather than failing its restore. Next to every file goes `<file>.manifest.json`, naming the format, engine, version, size and SHA-256, so a panel with no record of the file can still prove what it is. Redis has no backups. Volume copies of a running application are not transactionally consistent, and the panel does not encrypt backup files: a destination should be trusted accordingly.

A schedule's next run is a column, so schedules survive restarts by construction. Cron follows the server's time zone, and the first minute after a daylight-saving gap stands in for times inside it. A missed run is not replayed: however many occurrences a downtime covered, a due schedule runs once after the boot delay and returns to its calendar, and a service with other work in progress is left due until it is free. Retention keeps the newest N successful scheduled backups of one configuration, driven by rows so that no file outside that configuration can be touched. Manual backups and safety copies are never counted, and a failed cleanup is reported on the backup, which still succeeded.

A stored backup can be downloaded through its record, never by a path, by an operator of its project: it is fetched into the panel's own space and checked against its recorded size and SHA-256 before a byte is sent, and the download is written to the activity log.

A restore needs the service to be deployed and started and the target's exact name typed, or the service's own name for a whole server or its accounts, and is refused while the service has other work in progress or an earlier restore left it unresolved. It also needs operator rights on where the file came from: a recorded backup belongs to its own service, and a file named by hand belongs to the project on the panel's record of it, or failing that the one its manifest names. A file the caller has no rights on answers exactly as a file that is not there. What the record or manifest says has to match the target before the file is fetched: kind, scope, engine, major version and, for a volume, its name. It then downloads and verifies the file, and takes a safety backup of the current data to Local Disk before anything changes. Postgres imports inside one transaction, so a failure rolls back by itself and the client's end of input never commits a partial file. MySQL, MariaDB and Mongo cannot do that, so a failed or cancelled import removes what it created and reloads the safety backup. A volume is unpacked next to itself, swapped in with the service stopped only for that moment, and the old contents stay in a folder beside it until someone discards them.

A whole server is put back in a server of its own, on a new volume with no network, so nothing is connected while it loads and an empty target leaves nothing to work around. The service only moves over once the import has succeeded, the previous volume stays listed under Monitor, Storage, and a failure before or during that move leaves it exactly where it was. Accounts are put back in place, without touching data, and the panel's own account is never changed by either, because the panel holds its password and the backup may hold an older one. After a panel crash, a volume restore is finished or undone from what the folders show, and a database restore is held as unresolved until a person checks the data. The panel's own data directory is not covered by service backups: back it up with the panel stopped, and keep `secret.key` with it.

### Proxy

Traefik 3 reads a file-provider directory at `<data>/traefik/dynamic`. There is one YAML per service, `<project>__<service>.yaml`, plus `_base.yaml` for the panel's own routes and shared middlewares. Writes are atomic: temporary file, then rename.

`compileService(input)` returns `{ swarmSpec, proxyConfig, files }` and performs no I/O. It lives in `apps/server/src/features/services/compile/` and only composes one pure sub-compiler per concern: `env`, `mounts`, `ports`, `resources`, `deploy`, `domains` and `middlewares`. A feature extends the one it needs without touching the others.

A new service's default domain is `<project>-<service>.<base>` when the `service_domain` setting is set, otherwise `<project>-<service>.<address>` under the server's address, and `<project>-<service>.<server-ip>.sslip.io` when it has none. A stopped service keeps its routers with no servers behind them, so its domains answer 503.

`_base.yaml` also holds a catch-all at the lowest priority: HTTP redirects to HTTPS, and HTTPS shows the panel's not-found page. The panel serves its own pages at `/api/proxy-pages/*` with no session: bad gateway (every router, through an `errors` middleware on 502), not found, service stopped (on the routers of a stopped service, on 503) and maintenance. Maintenance points every router of a service at the panel with a `replacePath` to its page. Domains, redirects, basic auth and maintenance apply at once through the proxy writer and never touch the Docker service. `OPSIFIER_PANEL_UPSTREAM` overrides where Traefik reaches the panel, for setups other than the shared network's `http://opsifier:3000`.

A service's routes live in its own file, and the file provider only ever sees valid YAML, so a domain that fails to get a certificate or names a resolver that doesn't exist can't affect any other service. Hosts, paths, regexes and basic auth users are validated in the contract and again in the compilers, because Traefik disables the whole router for one thing it can't parse. Redirect patterns are checked against Go's regular expression syntax, which is what Traefik compiles them with.

A route for `/api` answers on `/api` and below it, never on `/apix`: its rule is `Path` or `PathPrefix` with the slash, which needs no escaping, and it can take the path off the request before forwarding. A service with no routes has no file at all, because Traefik refuses a whole directory over one empty `routers:` and keeps serving its old routes. Hostnames are stored in lower case and punycode.

Two routes that could match the same request are refused unless they have one owner. An owner is a project, or custom destinations taken together, so services of one project can still share a host by path, while another project can't add a longer path on it, nor a wildcard over an exact host or the reverse. Names the panel generates obey the same rule, and the panel's own domains are reserved in both directions. Only a change to what a route claims is checked, so one that predates a rule stays editable.

An HTTPS upstream is verified. Its transport is in the service's own file, checks the name on the certificate against the public hostname unless the domain names another, and trusts the public authorities unless the domain gives its own certificates. A check that fails answers 500, and the reason is in Traefik's log. HTTPS on a wildcard depends on an owner's DNS resolver and has not been verified, so it reads `unverified` until the proxy really holds the certificate.

Saving a redirect rule, or an address, is refused when following the service's own addresses shows a redirect that never ends. It only refuses a loop it actually walked, within one service, and a user's pattern always runs under a time limit because JavaScript's regular expressions, unlike Go's, can run for ever.

### Opsifier addresses

A server can ask for `<id>.opsifier.dev` and `*.<id>.opsifier.dev` from a small serverless service in `infra/names`, and a person approves each request. Until then generated names use `sslip.io`, and the owner's own domains are unaffected at any point. DNS answers come from Route 53, so names already issued keep working if the API is down.

Issuing names on request is deliberate. A shared domain is only as safe as its worst tenant: one phishing page can get all of `opsifier.dev` blocked, and until the domain is on the Public Suffix List every new certificate counts against a single weekly Let's Encrypt limit and a server can set cookies for the others.

**This is the only call home, and only a server that asked makes it.** A server calls `OPSIFIER_NAMES_URL` (`https://names.opsifier.dev` by default) to ask, every five minutes while the request waits, once a day as a heartbeat after that, to release, and from Traefik during a certificate's DNS challenge. Apart from the email and the purpose an administrator types to ask, those requests carry the server's ID and secret and nothing else: no version, no hostname, no inventory, and the IP is the connection's own source address as the API sees it. With `OPSIFIER_NAMES_URL=off` a server can't ask at all. The release feed and the Docker version check read public documents and say nothing about the server.

`setup` never asks. It only puts back what the proxy needs for an address the server already has. The address lives in one `settings` row with its secret sealed, and Traefik reads the secret from a 0600 file in `<data>/traefik`, because a variable would put it in the Swarm service's spec.

A request is made from Settings and holds a name and nothing else: a `requested` row with the email, the purpose and the source IP, and no records. The operator lists and answers requests with `infra/names/requests.sh`, which invokes the maintenance function, so no route leads to a decision. With `NOTIFICATION_EMAIL` set at deploy, each request is also sent by email through SNS. Approving writes both A records in one Route 53 batch, at the IP the row holds by then, and can be repeated if a step fails. A request nobody answers is dropped after 30 days. The email and the purpose are kept while the address exists, as a way to reach whoever asked, and erased once the row is a tombstone.

The panel finds out at its next check. An approved address is taken up with nobody there: the secret file is written, generated names move from `sslip.io` to the address, routes are rewritten and the proxy restarts with the DNS resolver. The panel keeps answering on its `sslip.io` name as well, because an approval can come at any moment and must not take away the name people are using.

One wildcard certificate per server keeps individual hostnames out of Certificate Transparency logs. The `opsifier` resolver answers the DNS challenge through `httpreq`, and the HTTP challenge stays for domains people bring. `addressCertificatesGuard` wraps the protection guard: any route whose hosts sit one label under the address gets the wildcard certificate, and only ever its `tls` changes. It does this on the routing file, as protection does, so every kind of route is covered, and protection still has the last word on what reaches the proxy.

A heartbeat is sent once a day, and after a restart if the last one is over an hour old, which is also how a new IP is picked up. An address the service no longer honours is shown as lost or disabled and is not offered for new names. Releasing an address moves every name under it back to `sslip.io`, and another can then be asked for.

The service never takes an IP from a request: it reads the source of the connection from the API Gateway event. Only public IPv4 is given a name. A server can only touch its own records and its own `_acme-challenge` name, and only once it has been approved. A daily job finishes whatever a crash left half done and removes addresses with no heartbeat for 90 days. IDs are never reissued: released, expired, refused and disabled ones stay as tombstones.

### Server purpose and protection

A server declares what it is for: `development`, `staging` or `production`. Anything but production is protected, and so is a server whose owner has not chosen yet. The purpose, the credentials and the exemptions are one row in `settings`, and whatever can't be read comes back as the strictest state: no purpose, no users.

Protection is enforced in one place: `ProxyFiles` writes a routing file only after passing it through a `ProxyGuard`, which runs the pure sub-compiler in `compile/protection.ts`. It works on the routing file itself, not on one kind of service, so Compose stacks, templates, database web tools and whatever comes next are covered with no redeploy. What it adds carries the prefix `opsifier-protect-`, so applying it again, or for another purpose, always starts from the plain routes.

On a protected server every router starts with the `X-Robots-Tag` header, so errors and 401s carry it too, then the basic auth gate, placed after any redirect to HTTPS so credentials are not asked for over plain HTTP. The gate's users and the shared middlewares live in `_base.yaml`, so one change reaches every route. Each host gets its own `/robots.txt` route at a priority above any rule, served by the panel and outside the gate. The panel's own domains get the header and `robots.txt` but never the gate, so deployment triggers and Git webhooks keep working, and ACME challenges are answered by Traefik's own router first. With no valid credentials the gate is locked: its one user has a hash no password can match, so a route cannot be published open. A browser sends one Authorization header, so a route with its own basic auth gets a gate that also accepts its users, and its own layer has the last word. A per-service exemption is a route that is the original rule AND a path or IP range, one priority step above it, so it can never widen what the service answers on.

A change of purpose, users or exemptions rewrites every routing file together. `ProxyFiles.rewriteAll` first renders and stages every file in a hidden temporary name, then renames them in one pass, and on any failure restores the previous files and state. Moving to protection stores the state and swaps `_base.yaml` first, moving away does both last, so a crash midway comes back protected: `reconcile` rewrites every file at boot. The top bar and the domain lamps report what `auditRoutingFiles` reads back from those files, not what was asked for.

### Accounts, access and API keys

The first account is the owner, kept unique by a partial index. Everyone else is an administrator or a member, and a member holds a role per project: a viewer sees the inventory and the state of things, an operator can configure and deploy. Authorization is one table, `features/access/policy.ts`, consulted by a middleware before any route: `requirementFor(method, path)` denies by default, so a route added later is closed until someone decides otherwise. Handlers only filter what they list. A project out of the caller's reach answers exactly as a missing one does, 404, and only inside a project the caller can see does a forbidden action answer 403. A conflict never names what another project holds. WebSocket topics pass through a guard written with the same rules. Changing a member's rights downwards ends their sessions and API keys, and deactivating an account ends them too and keeps it from signing in, with its project rights kept for when it comes back. The owner and the person doing it can't be deactivated. Administering the server itself (a shell on the host, its disk and a reboot) is a right of its own, apart from being an administrator or being able to open a service's console: the owner always has it, and only the owner gives it to an administrator. It needs a session, never a key.

A route that names a second project checks that one as well. Moving a service needs the operator role on both projects, and the service then belongs to the target: its members and keys reach it and its history, and those of the project it left no longer do. Reaching the host reaches every project on it, so a path on the host, a new capability, and the confirmations for host access in a Compose file or a template take an administrator with no narrowed key, checked in `requireHostAccess`. Two services never answer to one network address: `<project>_<service>`, `<project>-<service>` and the bare name are checked within a project, the only place they mean anything.

An administrator can invite people rather than choose their passwords. An invitation is a link that works once, expires after seven days and is stored as a hash. It carries the role and project rights it will give, and it answers for the administrator who sent it, so it ends when they are demoted, deactivated or deleted. The links go out by e-mail through an SMTP notification channel, in an Action, or are handed to the administrator to pass on. An e-mailed link only ever points at the panel's own address, and nothing in the e-mail is free text, so the panel's mail can't be turned into someone else's message. Accepting checks the link again after the password is hashed, creates the account with the projects that still exist, and signs it in.

An API key is shown once and stored hashed. It is read or write, may be narrowed to a list of projects, expires after 90 days unless told otherwise and after at most 365, and is checked on every request against the current rights of its owner, so it can never do more than they can. Accounts, server settings, other keys and deployment triggers need a session and refuse keys. The `reset-password` command recovers an account from the server's own shell.

Every Action records where it came from: a session, an API key, a deployment trigger, a push webhook, or the panel itself. The origin is read from the request that created the Action through an async context, so a feature cannot forget it, and it is stored on the row so that it survives a restart. An API key's Actions name its owner, a trigger's the account that issued it.

### API clients

The command line and the MCP server are clients of `/api/v1`, nothing more: they hold an API key from the environment and have no route to the database, the filesystem or Docker, so `packages/client` is the one way anything they do leaves the process. It sends the key only to the configured panel, refuses a path that is not under its API, and treats every redirect as an error, because a redirect is an instruction to send the key somewhere else.

Both are bundled into one file with no dependencies, use types from `packages/contract` at compile time, and have no runtime dependency on it. Their dedicated commands and tools are one API operation each, listed in `ROUTES` and checked against the OpenAPI document by a test, so a route that moves breaks the build rather than a client. Everything else goes through the catalogue, read from the panel's own OpenAPI document at runtime. `GET /api/v1/auth/identity` is what makes discovery honest: the server runs every route through the same check a real request goes through and returns what passes, so a client shows only what will work without carrying any rights logic of its own. A client can only ever ask; the panel decides, every time.

Output is the API's own JSON whenever the client is not talking to a person, so a CLI action and its API equivalent are comparable byte for byte (`packages/cli/src/acceptance.test.ts` compares them). Whatever is destructive needs an explicit confirmation before anything is sent. That confirmation is a brake against a wrong call; the rights of the key are the security boundary. The public API's shape is recorded in `docs/api-surface.txt`, and `apps/server/src/api-surface.test.ts` holds the OpenAPI document to it, so any change to the surface comes with a diff and a row in `docs/API.md`.

### Monitoring

The panel samples the host and every service on a timer into `metric_samples`, and rolls raw readings up into 1 minute, 5 minute and 1 hour buckets as weighted averages. A roll-up starts from the newest bucket already written, so a restart loses nothing. Retention is a number of days or of gigabytes, enforced together with the roll-ups, and a bucket with no reading is null rather than zero, so a chart never invents a flat line. The same store, opt-in, keeps service logs in `log_entries` so they stay searchable after Docker has rotated them. A cursor per service, written in the same transaction as the lines, carries the collector across a restart. The limits are an age and a size on disk: each pass removes what is past its age and, over the size, the lines printed longest ago, only as many as it takes. Host figures come from the machine the panel runs on and name their origin in the response. Every reading says where it came from, what it covers and when it was taken. A figure Docker did not report is null, in the API as on screen, never zero. With Docker gone every reading says so, instead of showing the last values as current, and carries the date of the last measurement.

### Host operations

Traefik's static configuration is carried only by environment variables, rendered by `renderProxyEnv`: trusted proxies, the certificate contact and the owner's own variables, the latter sealed at rest. A custom dynamic file goes through the same writer as generated routes, only as valid YAML, and the dashboard's password is shown once. Certificates are read back from the proxy's own `acme.json`.

What can't be reached through the Docker API, a shell on the host, a disk listing and a reboot, runs in a short-lived helper container that the panel removes when it ends. A reboot is an Action that stays in progress: the helper records it in `<data>/host-reboots.log` on the machine itself, which needs neither the panel nor its database, and the panel's next start reads that record and the machine's boot time to say whether the reboot happened. Rebooting, restarting the panel or the proxy, updating and the cleanups need a word typed by a person and checked by the server. A cleanup is previewed first and evaluated again when it runs. It only removes what the panel can show it made or used: by its own image tags, by a remembered ID only for an image left with no tag, and, since Docker keeps no owner for build cache, by what the panel saw appear while its own builds ran, so nobody's images or cache are removed by accident. The image of any service that still exists is kept even when nothing is running it. So is every image a release retains. The daily cleanup is off until someone turns it on. A cleanup reports what Docker says it gave back, not what its items were listed at.

Docker's own disk, the one its images and containers fill, is read from the host through the same helper, since the panel only mounts its data directory. It is shown beside the panel's disk and it is the disk a deploy's space check compares against. When it can't be read, it is reported as unknown and stops nothing.

### Notifications

A channel is a Discord or Slack webhook, a Telegram chat, an SMTP server or a plain signed webhook, and its secrets are sealed per channel. A stored secret only fills in a field left empty while the channel points where it was saved for: an SMTP password stays with its host, port and username, a webhook's signing secret with its URL. Otherwise a save or a test send is refused with `secret_destination_changed`, so whoever can edit a channel can't have its password sent to a server of their own. A Telegram token only ever goes to Telegram, and a Discord or Slack URL is its own destination. A test send uses exactly the delivery path a real event does. Destinations are resolved before every send, private and loopback addresses are refused unless the owner has allowed them (an address of the NAT64 prefix, which DNS64 hands out for names with no IPv6 address, counts as the IPv4 address it reaches), the connection goes to the address that was checked, and redirects are not followed. SMTP uses STARTTLS when offered and will not send a password over a connection without encryption. Delivery is bounded in attempts, recorded per channel, and deduplicated by event and channel, so a retried event can't be sent twice.

### Realtime

One WebSocket at `/api/v1/ws` carries JSON frames with topics such as `action:<id>`, `service-logs:<project>/<service>` and `metrics:system`. Clients send `{ "t": "sub", "topic" }` and `{ "t": "unsub", "topic" }`. The server sends `{ "t": "data", "topic", "payload" }`. Terminals use their own binary WebSocket at `/api/v1/terminal/<project>/<service>`.

A feature can produce a topic on demand with `realtime.provide(provider)`: the first subscriber starts it, the last one stops it, and each new subscriber gets a replay. `service-logs:<project>/<service>` and `service-metrics:<project>/<service>` work this way, keyed on the project and service so that they serve any type of service, as `metrics:services` does for the Monitor page. A log feed keeps bounded buffers and stops reading from Docker while its slowest subscriber catches up. Swarm queues a follow's output without limit, so once the feed is reading lines more than a few seconds old, it drops the follow, marks the gap and starts again from the present.

Other WebSocket endpoints join the hub with `realtime.route(route)`, behind the same Origin and session checks at upgrade, and end with their session. The terminal route also requires an administrator, opens sh in place of a bash the container doesn't have and says so, runs its program as an argument vector, writes each session to the Activity log, and bounds its frames and buffers. Docker keeps a TTY exec running when its client goes away, so closing a terminal ends its processes explicitly. A session goes on record in `console_sessions` before its process starts and comes off once it has ended, so the next boot can end exactly what a dead panel left behind: the marker in that process's environment, in that one container, and nothing else. Helper containers a dead panel left are removed at the same moment.

### Scripts

A saved script belongs to a service, in its spec, with a maximum duration (one hour unless set, a day at most), an optional schedule and a `runAfterDeploy` flag. Every way of running one ends up as the same thing: an Action of type `service.script` and a row in `script_runs`, written first, whose id is the Action's and is also the marker in the process's environment. So a run queues behind other work on the service like anything else, cancels like anything else, shows on the Activity page, and is refused by destroy or rename while it lasts. It runs as `/bin/sh -c` in the service's first running task, with no terminal and its input closed, and the row names that task.

**Overlap.** There is one policy: a script has at most one run in progress. A person or an API key asking for another gets 409 `script_already_running` and nothing starts, so a retried request cannot launch a second job. A schedule or a deployment that finds one in progress starts nothing and leaves a `skipped` row saying why. Both read `script_runs`, not memory, so the policy holds across a restart: a run left over from an earlier panel still counts until something has settled it.

**Time.** A schedule is a five-field cron expression and a time zone that must be stated, evaluated in that zone whatever the server's own clock is set to: the first minute after a daylight-saving gap stands in for a time inside it, and a time that happens twice runs once. The next due time is a column, `script_schedules.next_run_at`, written before anything starts so a crash cannot run an occurrence twice. An occurrence missed while the panel was down is not replayed: a schedule that fell due runs once after a boot delay and returns to its calendar. The limit counts from the moment the process starts, not from the queue.

**HTTP.** `POST /api/v1/projects/{project}/services/{service}/script-runs` with `{ "script": "<name>" }` answers 202 with the Action and the run, or 404 for a name that isn't there, or 409 as above. There is no separate trigger credential: it is authorized like any other change to a project, a session or a write API key holding the operator role, and a viewer or a read-only key gets 403. `GET .../script-runs` lists the history newest first, `GET .../script-runs/{id}` adds the output, and `POST .../script-runs/{id}/cancel` stops one, answering at once while the process is still ending and, for a run that has already finished, 409 `script_run_finished`. The origin is stored as `manual`, `api`, `schedule`, `hook` or `console`, with the account and an API key's name beside it, next to the exit code.

**Ending a process.** A cancel or the limit runs the terminate script against the marker: every process carrying it, in that one container, gets HUP and then KILL a second later, so a script that ignores signals or left children behind ends all the same and nothing else in the container is touched. The run only reads `cancelled` or `timed_out` once Docker says the process is gone; if it never does, the record says it could not confirm that.

**A run outlives the panel watching it.** Docker keeps a process going when the connection to it drops, so the panel restarting ends nothing. The output kept is the end of what was printed, at most 64 KiB, written to the row every two seconds and at the end; the rest goes to the Action's own log. A row still `running` at boot, or that a panel finds itself no longer reading, is settled from what Docker says about the process it was given, by its exec id. Still running: it stays `running`, marked `outputComplete: false`, and is still held to its limit and still cancellable, polled every pass of the scheduler. Over: the exit code is the one Docker reports, and the output is marked incomplete. Docker no longer knowing the process, which happens a few minutes after it ended or with its container: the status is `unknown` and the exit code null, rather than a guess, and its Action reads `uncertain`. A run still queued at boot never started and says so. `note` on the record carries a code and the English sentence, which the interface says in its own language. Skips and failures each have one too.

**Hooks.** `runAfterDeploy` runs a script once after every successful deployment of its service, with the deployment's account as its actor. A failing hook fails its own run: the deployment it follows already succeeded and stays that way.

**History.** A script keeps its newest 50 runs, with their output, and 20 skips apart from those, so a schedule outrunning itself can't push real runs out. A renamed script keeps its past. Runs follow their service when it is renamed and go with it when it is deleted. A console session of a saved script is recorded too, with its person and exit code, under the same limit and overlap policy, but its output belonged to the terminal.

### Security

- Passwords use `scrypt` and are at most 256 characters. Session tokens are random and stored hashed. Login is rate limited.
- A panel with no user can only be claimed with the one-time token at `<data>/setup-token`, mode 0600, printed in the log at boot as `/setup?token=...` and deleted by a successful setup.
- Sessions opened over plain HTTP last at most 12 hours, whatever the user asked for.
- Starting two-factor enrolment and turning it off take the current password. Enabling it issues ten single-use recovery codes, shown once and stored hashed.
- The owner can require two-factor sign-in of every account, once their own uses it. An account without it can then only turn it on: every other request it makes, with its session or one of its keys, is refused, it listens to nothing over the WebSocket, and nobody can turn their own off while the rule stands.
- Secrets are sealed with AES-256-GCM using a 32-byte key at `<data>/secret.key`, mode 0600. If the key is missing once users exist, the panel refuses to boot.
- Names and paths are validated before they reach Docker or the file system. Nothing is interpolated into a shell.
- Validate strictly, even where another product might not: hostnames, paths, port ranges, replica counts, negative resources and empty credentials are all rejected.
- Variables are sealed in the database, a project's and a service's alike. A page gets their names, and the values come from a reveal that lands in the activity log. Build secrets have no reveal at all.
- Output is filtered through `Redactor` (`core/tools/redact.ts`), which knows a service's current values, what its running container holds, and everything it has held before, kept sealed in `sealedRetired` so that a value still masked after it changes. Everything an Action writes goes through it, whichever feature wrote it, and so do service logs before they are shown or stored, and a log read back later. Values too short or too ordinary to tell from normal output (`production`, numbers, paths) are left alone unless the name says otherwise. A value known to be a secret also goes when printed in long enough pieces, and `LineRedactor` puts one split over several lines back together, per BuildKit step and per stream. This is a filter for known values, not a data-leak prevention system: a secret transformed on its way out, or printed a character at a time among other output, gets through.
- What a server holds is bounded before it reaches Docker: 256 projects, 100 services per project and 20 domains per service, next to the limits each field already has.

## Runtime on a server

The installer initializes Swarm, creates the `opsifier` overlay network, then starts two services:

| Service            | Image       | Mounts                             | Published             |
| ------------------ | ----------- | ---------------------------------- | --------------------- |
| `opsifier`         | our image   | Docker socket, `/var/lib/opsifier` | 3000, host mode       |
| `opsifier-traefik` | `traefik:3` | `/var/lib/opsifier/traefik`        | 80 and 443, host mode |

`scripts/install.sh` checks the server, installs Docker when absent and hands over to the image's `setup` command (`apps/server/src/bootstrap`), which can also be run directly with the socket and the data directory mounted. Each step leaves alone what is already right, so running it twice changes nothing. It never leaves a Swarm or replaces a service it did not create without `--force`, and it refuses everything that would stop it before making its first change. It sets `OPSIFIER_TRUSTED_PROXIES` to the overlay network's range, because Traefik is the only thing that can reach the panel from there, and it registers the server for an address unless told not to (`--no-opsifier-address`), saying so in one line of its output.

A setup that stops partway can be carried on by running it again, or undone. `setup-state.json` in the data directory is the run's own record: its id, the top-level names the data directory held when it began, and everything it made, each entry written before the step that makes it. Services and the network also carry the run's id in the label `opsifier.setup-run`, set by the same call that creates them, so there is never a moment when something of the run exists without saying so. `clean-setup`, or `install.sh --clean-up`, shows what that record comes to; with `--yes` it removes it. Only what the record and the label both say is the run's goes, and it works only on a run that never finished and a panel nobody has claimed. A Swarm the run started is left only when nothing else is on it: no other service, network, node, secret or config. Files go when they weren't there before the run, and an address it registered is given back. Whatever was there before, or has been replaced since, is listed and left alone. It can be interrupted and run again, because the record stays until everything in it has gone. Docker itself and the panel's image are left in place.

### Updating the panel

`GET /api/v1/system/update` and the top bar show the running version and what the release feed offers: a JSON document at `OPSIFIER_RELEASES_URL` (`{ version, image, notes, migrations, publishedAt }`, `off` to disable), fetched by the server and only ever by the server. Applying one is an Action that pulls the image, records its digest and size, saves the database and key under `<data>/panel-update`, writes a journal there, and hands the service to Swarm with a new image. The old process is gone from then on, so the way back cannot depend on it:

- Swarm itself rolls the service back when the new task fails to start or dies within the monitoring window (`PANEL_UPDATE_CONFIG`), healthcheck included.
- The first thing any process does at boot, before opening the database, is read the journal: an old version waking up under an unfinished update means Swarm brought it back, so it restores the saved database and key, because the new version may already have migrated them.
- The target version watches itself through a verification window and only then marks the update as succeeded. The rollback button or `opsifier rollback` from outside the panel go back afterwards, restoring the data only if the schema changed.

### What the panel's image contains

Besides Node and the panel itself, the image has to carry everything a build runs:

| Tool                   | Package or location                                  | Used for                                                                   |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `git`                  | `git`                                                | Fetching repositories and checking them before a source is saved           |
| `ssh`                  | `openssh-client`                                     | Git over SSH with a deploy key                                             |
| Docker CLI with buildx | `docker-ce-cli`, `docker-buildx-plugin`              | Dockerfile and Railpack builds, against the mounted Docker socket          |
| Docker Compose plugin  | `docker-compose-plugin`                              | Runs Compose stacks, against the mounted Docker socket                     |
| `bsdtar`               | `libarchive-tools`                                   | Listing and unpacking uploaded zip, tar, gzip, bzip2, xz, zstd, 7z and rar |
| Nixpacks               | `/opt/opsifier/builders/nixpacks/<version>/nixpacks` | One binary per version offered in the UI                                   |
| Railpack               | `/opt/opsifier/builders/railpack/<version>/railpack` | One binary per version offered in the UI                                   |
| `pack`                 | Cloud Native Buildpacks CLI on the `PATH`            | Buildpacks builds                                                          |

The offered versions are listed in `packages/contract/src/service-tabs/source.ts`, and [`docs/BUILDERS.md`](BUILDERS.md) publishes what each one supports. A build runs the binary of exactly the version chosen and fails, saying so and replacing nothing, if that version is not there: there is no falling back to another one. `OPSIFIER_BUILDERS_DIR` moves the builders folder for development. A Buildpacks builder is a pinned reference, to a digest or a full release, and one that isn't is refused when saved and at build time. A builder saved by an earlier release reads as the pinned build of its line.

## Web app

React 19, Vite, TanStack Router and Query, Tailwind 4 over our own tokens, Radix primitives, xterm.js for consoles, CodeMirror for editors, uPlot for charts, i18next with English and French.

```
apps/web/src/
  app/         shell, router, providers
  ui/          design system components
  features/<feature>/
  i18n/<lang>/<feature>.json
```

Every screen handles loading, empty and error states. Forms show a banner plus per-field messages from the API's `fields` map. Async buttons show progress and disable themselves. A control that can't be used yet says what it needs: `disabledReason` on `Button` and `DropdownMenuItem` keeps it focusable and states the prerequisite, because a native `disabled` button can't show a tooltip or take focus. Every field has a visible label and useful help, with its error in the same place.

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
- **On a screen.** `features/services/serviceState.ts` turns a service into its state, its word and its pictogram, and `features/service-runtime/resources.ts` turns its readings into gauge values against the limits the server reports. Empty states pass an `illustration` to `EmptyState`, a screen that could not load uses `ErrorState`, and section headings use `SectionIntro`, which keeps the explanation folded until someone asks for it.
- **Size.** The interface is meant to be read without effort: body text is 16px and nothing goes below 13px. Every height, gap and icon comes from the 5px `--spacing` step in `theme.css`, so a new screen uses the normal scale and never a smaller custom size. Pictograms and lamps take their drawn size and show at `Pictogram`'s scale or the `lampSizes` table.
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
