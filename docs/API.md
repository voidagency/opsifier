# Opsifier API

The API lives under `/api/v1`. Everything the web app does goes through it, so what you can do by hand you can script. The full reference, every operation and schema, is in the panel at **Settings → API reference**, and as OpenAPI 3.1 at `/api/v1/openapi.json`.

## Authentication

Send an API key as a bearer token:

```sh
curl -H "Authorization: Bearer $OPSIFIER_API_KEY" https://your-panel/api/v1/projects
```

Create keys on **Settings → API keys**. A key is shown once, stored only as a hash, expires (90 days unless you choose otherwise, at most 365), and can be revoked at any time.

A key can do at most what its owner can, at the moment each request is made, narrowed by:

- its **level**: `read` keys can only make safe requests.
- its **projects**: a key limited to some projects sees nothing outside them.

Accounts, API keys, server settings, panel updates, custom domains and deployment triggers are out of reach of every key, including an administrator's. Those take a person signed in at a browser. Changing an account's rights, email or password revokes its keys.

`GET /api/v1/auth/identity` answers who a credential speaks for and what it may do: its owner, its level and projects, the role it holds in each, and every operation it may call right now, judged by the same rules every route applies. It is how a client shows only what will work. It grants nothing: every request is still checked when it is made.

The [command line](CLI.md) and the [MCP server](MCP.md) are clients of this API and nothing else, using these keys and subject to exactly these rights.

## Permissions

| Role                  | Can                                                                |
| --------------------- | ------------------------------------------------------------------ |
| Owner                 | Everything, and cannot be demoted or deleted                       |
| Administrator         | Everything in the panel: projects, server settings, other accounts |
| Operator of a project | Configure, deploy and read logs in that project                    |
| Viewer of a project   | See that project's inventory and states                            |

Anything outside what the caller may reach answers exactly as if it did not exist: `404`. A forbidden action on something the caller can see is `403`.

These rights organise people who trust each other, and projects are kept apart on the network. They do not isolate hostile tenants from each other: a published port is reachable by everyone, containers share a kernel, and anyone with access to the Docker socket controls the host.

## Errors

Every error has this shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields need attention.",
    "fields": { "host": "Required" }
  }
}
```

| Status | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| 400    | The input is invalid, or has a field the route does not define. `fields` names each problem |
| 401    | Not signed in, or the key is not valid                                                      |
| 403    | Not allowed                                                                                 |
| 404    | Does not exist, or out of the caller's reach                                                |
| 409    | Conflicts with the current state, including a confirmation that does not match              |
| 503    | The panel cannot take changes just now, such as `storage_failing` while it can't save state |

## Long operations

Anything slow returns `202` with the Action doing the work. Follow it at `GET /api/v1/actions/{id}`. Every Action records its `origin`: `session`, `api_key`, `trigger`, `webhook` or `system`, and the account behind it in `actorEmail` when there is one.

## Deployment triggers

A CI job starts a deployment by POSTing to `/api/v1/deploy` with the service's token as a bearer token:

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" https://your-panel/api/v1/deploy
```

`?forceRebuild` skips the build cache. Generate the token on the Deployments tab of the service, or with `POST /api/v1/projects/{project}/services/{service}/deployments/trigger/rotate` from a browser session. It is shown once and stored only as a hash. `GET .../deployments/trigger` reports whether one exists, never its value. Replacing or revoking it (`DELETE .../deployments/trigger`) stops it working at once.

## Push webhooks

`POST .../deployments/webhook/rotate` from a browser session creates a webhook for the service's repository and branch, or gives it a new secret. It answers with the address and a secret that is shown once, unless the panel installed it on GitHub itself, when nobody ever sees it. A Git host delivers to `/api/v1/deploy/hook/{id}`:

- it must carry `X-Hub-Signature-256`, the HMAC-SHA256 of the body with that secret: unsigned deliveries are refused;
- only a push to the repository and branch the webhook was issued for deploys, and it builds the commit named in `after`. Anything else answers `200` with `deployed: false` and a `reason`;
- a delivery already taken, by id or by content, answers `200` with `reason: "duplicate"`, and starts nothing.

Changing the service's repository or branch pauses the webhook: deliveries answer `409 webhook_paused` until its secret is rotated, and the deployment token is revoked at the same moment.

## Known hosts

`GET`, `POST` and `DELETE /api/v1/settings/known-hosts`, for a signed-in administrator, manage which SSH servers Git may connect to. `POST /api/v1/settings/known-hosts/scan` reads a server's keys for comparison and saves nothing. A server with no entry, or whose key does not match its entry, is refused.

## Invitations

An administrator signed in at a browser invites people with `POST /api/v1/users/invitations`: up to 100 addresses at once, with one role and one set of project rights for all of them. Each address gets a link that works once and expires after 7 days, and only its hash is stored. With `channel`, the id of an SMTP notification channel, an Action e-mails each person their own link, which always points at the panel's own address. Without it, the links are in the answer and nowhere else. An address repeated in the list, one that already has an account and one whose invitation is still waiting are reported in `results` and leave the others alone. An expired invitation is replaced.

`GET /api/v1/users/invitations` lists them with where each one stands (`delivery`). `POST /api/v1/users/invitations/{invitation}/resend` issues a new link, and the old one stops working. `DELETE /api/v1/users/invitations/{invitation}` takes one back. An invitation also ends when the administrator who sent it is demoted, deactivated or deleted.

The token is in the link's fragment, so no server or proxy log holds it. The page it opens reads the invitation with `POST /api/v1/auth/invitation/check`, and `POST /api/v1/auth/invitation/accept` with `token`, `name` and `password` creates the account, signs it in and uses the link up. A link that does not work answers `404 invitation_invalid`, and wrong links count against the address trying them.

## Upgrading to these rules

What was already configured keeps working unless this says otherwise:

| Configured before                                              | After upgrading                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deployment token                                             | Keeps working as a bearer token and in its old `/api/v1/deploy/<token>` URL until it is replaced. Its value can no longer be read back from the panel.                                                                                 |
| A webhook the panel installed on GitHub                        | Keeps working at its old address, signed with the old token, until it is rotated or the service's token is replaced, which moves it to its own secret.                                                                                 |
| A webhook added by hand, with the token as its secret          | Keeps working at its old address, and goes when the token is replaced. A new one is created on the Deployments tab.                                                                                                                    |
| A webhook added by hand with no secret                         | **Refused**: an unsigned delivery proves nothing. Create a webhook with a secret.                                                                                                                                                      |
| An SSH remote                                                  | Hosts connected to before are imported into Known hosts at the first boot, so they keep working. A new host has to be added there first.                                                                                               |
| An SSH deploy key                                              | Tied to the repository of its current source, if it has one, and refused for any other.                                                                                                                                                |
| A GitHub source using the panel's token                        | Keeps the token for that repository. Pointing the service at another repository needs an administrator.                                                                                                                                |
| A stored registry password                                     | Stays with its image's repository: changing only the tag keeps it, another repository asks for it again.                                                                                                                               |
| A stored notification password or signing secret               | Stays with its destination: an SMTP channel's host, port and username, a webhook's URL. Changing those asks for it again, for a test send as for a save. Clearing an SMTP username drops the password.                                 |
| A Git remote that redirects, a renamed repository              | **Fails**: redirects are not followed, so it has to be saved under its new address. A running service is unaffected until a deploy.                                                                                                    |
| Project and service variables                                  | Sealed at the first boot. Nothing about them changes for the running services.                                                                                                                                                         |
| A service that builds, with variables                          | Its builds keep receiving its runtime variables, except anything sealed, until `DELETE .../environment/build/inherited`. New services do not.                                                                                          |
| A file of variables written before each build                  | Stays in the build context, as it was. Saving the setting again has to say whether it may enter the image.                                                                                                                             |
| A database already deployed                                    | Stays as it is until its next deployment, which moves it onto its project's network alone. Its names, port, password and connection strings stay the same.                                                                             |
| A database another project reaches over the old shared network | Its deployment is **refused**, saying why, until that service is changed: publish the database's port and connect through the server's address, or run both in one project.                                                            |
| A service pointing at another project's database               | Its deployment is **refused**, saying why and offering the same way, since it could never have reached it.                                                                                                                             |
| A Compose file joining a network its project doesn't own       | Stays running. Its next deployment is **refused**, confirmed or not: a project joins only its own networks.                                                                                                                            |
| Apps, Compose stacks and web tools already deployed            | Keep running and keep their domains. Their next deployment puts them on the project's proxy network. The proxy leaves the project's own network when the last of them has. Each of those moments restarts the proxy for a few seconds. |

## Variables and secrets

`GET .../environment`, `GET /api/v1/projects/{project}/env` and `GET .../environment/build` answer with names. The values come from `POST .../environment/reveal`, `POST /api/v1/projects/{project}/env/reveal` and `POST .../environment/build/reveal`, each recorded in the activity log. A viewer can use none of these.

| Set               | Route                                      | Reaches                                                    |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Runtime variables | `PUT .../environment`                      | The container, at its next deploy                          |
| Build variables   | `PUT .../environment/build`                | The build, as arguments. It can stay in the image          |
| Build secrets     | `PUT .../environment/build/secrets/{name}` | One build step at a time. Can be replaced, never read back |

## Versions and going back

`GET .../services/{service}/releases` lists the kept versions of an App and which of them can be gone back to, and `GET .../releases/{number}` says what going back would change. `POST .../releases/{number}/rollback` with `{ "confirm": "<service name>" }` starts it as an Action, using the image already on the server with no pull, build or Git access: `409` when the image is gone, its kept tag was altered, its volumes are not the ones in use, or other work is active. Volumes and saved settings stay as they are. `GET .../deployments/pending` lists what the next deployment would change. `PUT /api/v1/server/releases-kept` sets how many versions each service keeps, from a browser session.

## Creating a whole service at once

`POST /api/v1/projects/{project}/services/definition` takes the source, environment, domains, mounts and resources together, and deploys if you ask. If any part is refused, no service is left behind.

## Pagination

Lists that can grow take `limit` and `cursor`, and answer with `nextCursor`. A null cursor means the end.

## Changes

The contract under `/api/v1` is stable: fields are added, and a change that would break a client gets a new path instead. Every operation, input and answer field is recorded in [`api-surface.txt`](api-surface.txt), and a test holds the document to that record: nothing can be removed, narrowed or added to the API without the file changing and a row being added here.

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | First published: API keys with levels, projects and expiry, project roles, stored metrics                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-08 | A body field a route does not define is a 400, a number in a URL is plain digits, and setup asks for the owner's name                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-08 | Deployment tokens use `POST /api/v1/deploy` with a bearer header. Webhooks have their own secret, at `/api/v1/deploy/hook/{id}`. The old `/api/v1/deploy/{token}` still answers for tokens issued before, until they are replaced                                                                                                                                                                                                                                                                                                                         |
| 2026-11-09 | `GET /api/v1/auth/identity` says who a credential speaks for and which operations it may call. The `opsifier` command line and the MCP server are clients of the API, see `docs/CLI.md` and `docs/MCP.md`                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-09 | Actions and deployments can end `uncertain`, and `GET /api/v1/system/storage` says whether the panel can save its state                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-09 | Saved scripts have a maximum duration, a schedule with a stated time zone and an after-deployment hook. `POST .../script-runs` starts one, `GET .../script-runs` and `GET .../script-runs/{id}` are its history with origin, exit code and output, and `POST .../script-runs/{id}/cancel` stops one                                                                                                                                                                                                                                                       |
| 2026-11-09 | `GET .../environment`, `GET .../env` and `GET .../database-advanced` name variables instead of returning them, since a value in those answers is what had to stop. Saving a file of variables says whether it may enter the image                                                                                                                                                                                                                                                                                                                         |
| 2026-11-09 | Actions and deployments report the `phase` of their work. `GET /api/v1/system/info` says whether the panel is `simulated`. Accounts carry `hostAdmin`, for administering the server itself, which only the owner gives. A service's notes can be hidden with `PUT .../notes/visibility`, shown as `notesHidden`                                                                                                                                                                                                                                           |
| 2026-11-09 | Backups can hold a whole server, or only its users and roles (`scope`, and new `format` values for those), and a stored one downloads from `GET .../backups/{backup}/download`. `GET .../database/availability` tells a running process from an engine that accepts the panel's credentials. Storage providers list the permissions they need. `PUT .../database-advanced` takes `confirm` and answers 409 for a move to another major version. `PUT .../environment` takes `interpolation`, and either field on its own                                  |
| 2026-11-09 | Compose issues can carry `foreign_network`, and a deployment can be refused with `compose_foreign_network` when a stack would cross from one project into another                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-09 | Deployments record the requested and built commits, the OCI revision and the exact image. Kept versions, rollbacks and the list of what the next deployment would change: `.../releases`, `.../deployments/pending`                                                                                                                                                                                                                                                                                                                                       |
| 2026-11-09 | `GET /api/v1/server/docker` says what this engine is missing (`missing`, `minimumApiVersion`), and a change Docker can't run answers `503 docker_unsupported`. `PUT /api/v1/settings/github/oauth` and `POST .../oauth/start` connect GitHub through an OAuth app you register, and a Buildpacks builder has to be pinned to a digest or a release                                                                                                                                                                                                        |
| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | First published: API keys with levels, projects and expiry, project roles, stored metrics                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-08 | A body field a route does not define is a 400, a number in a URL is plain digits, and setup asks for the owner's name                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-08 | Deployment tokens use `POST /api/v1/deploy` with a bearer header. Webhooks have their own secret, at `/api/v1/deploy/hook/{id}`. The old `/api/v1/deploy/{token}` still answers for tokens issued before, until they are replaced                                                                                                                                                                                                                                                                                                                         |
| 2026-11-09 | `GET /api/v1/auth/identity` says who a credential speaks for and which operations it may call. The `opsifier` command line and the MCP server are clients of the API, see `docs/CLI.md` and `docs/MCP.md`                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-09 | Actions and deployments can end `uncertain`, and `GET /api/v1/system/storage` says whether the panel can save its state                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-09 | Saved scripts have a maximum duration, a schedule with a stated time zone and an after-deployment hook. `POST .../script-runs` starts one, `GET .../script-runs` and `GET .../script-runs/{id}` are its history with origin, exit code and output, and `POST .../script-runs/{id}/cancel` stops one                                                                                                                                                                                                                                                       |
| 2026-11-09 | `GET .../environment`, `GET .../env` and `GET .../database-advanced` name variables instead of returning them, since a value in those answers is what had to stop. Saving a file of variables says whether it may enter the image                                                                                                                                                                                                                                                                                                                         |
| 2026-11-09 | Actions and deployments report the `phase` of their work. `GET /api/v1/system/info` says whether the panel is `simulated`. Accounts carry `hostAdmin`, for administering the server itself, which only the owner gives. A service's notes can be hidden with `PUT .../notes/visibility`, shown as `notesHidden`                                                                                                                                                                                                                                           |
| 2026-11-09 | Backups can hold a whole server, or only its users and roles (`scope`, and new `format` values for those), and a stored one downloads from `GET .../backups/{backup}/download`. `GET .../database/availability` tells a running process from an engine that accepts the panel's credentials. Storage providers list the permissions they need. `PUT .../database-advanced` takes `confirm` and answers 409 for a move to another major version. `PUT .../environment` takes `interpolation`, and either field on its own                                  |
| 2026-11-09 | A box is a service with chosen runtimes: `POST /api/v1/projects/{project}/box` makes one, `GET .../box` says what it holds and why it was built, and `PUT .../box/modules`, `.../box/processes` and `.../box/hooks` save what it contains. `POST .../box/processes/{process}/restart` restarts one process. `PUT .../box/ide`, `POST .../box/ide/token` and `DELETE .../box/ide/token` turn its browser IDE on, issue and revoke its token, and need a session. The IDE's own routes are under `/api/v1/ide/{project}/{service}` and take only that token |
| 2026-11-09 | An `opsifier.dev` address is now asked for and approved. `POST /api/v1/server/opsifier-address/register` is replaced by `POST` and `DELETE` on `/api/v1/server/opsifier-address/request`, the address state gains `requestedAt` and the statuses `requested` and `refused`. These routes only ever accepted a signed-in session, so no API key client used them.                                                                                                                                                                                          |
| 2026-11-12 | Invitations: `GET` and `POST /api/v1/users/invitations`, `POST .../invitations/{invitation}/resend` and `DELETE .../invitations/{invitation}` for an administrator at a browser, and `POST /api/v1/auth/invitation/check` and `.../accept` for whoever holds a link                                                                                                                                                                                                                                                                                       |
| 2026-11-12 | `PUT /api/v1/notifications/channels/{channel}` and `POST /api/v1/notifications/test` no longer fill an empty secret with the stored one for another destination: a new SMTP host, port or username, or a new webhook URL, without the password or signing secret answers `400 secret_destination_changed` with that field in `fields`, and nothing is saved or sent                                                                                                                                                                                       |
