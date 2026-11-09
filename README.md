<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opsifier-banner-dark.png" />
    <img src="docs/brand/opsifier-banner-light.png" alt="Opsifier" width="760" />
  </picture>
</p>

Opsifier is an open-source control panel for your own server. It deploys apps and databases from a web interface that shows the state of everything at a glance. Every feature is included, and there are no paid tiers.

> **Status: early development.** Opsifier is not ready for production yet, and the one-line installer is not published. Expect breaking changes.

## What works today

- Projects and services with live status, deployment history and an activity log.
- Deployments from a Docker image, a Git repository, GitHub, an inline Dockerfile or an uploaded archive, with signed webhooks and deployment tokens.
- Going back to an earlier release in one action, with the exact image of every deployment recorded.
- Domains with HTTPS through Traefik, redirects, basic authentication and maintenance mode.
- A free `<id>.opsifier.dev` address for every server, with one wildcard certificate. It can be turned off at install, and a server can use its own domain instead.
- Development, staging and production server roles. Anything that isn't production stays behind a password and out of search engines.
- Environment variables sealed at rest, with build inputs kept apart from runtime secrets, plus volumes, published ports, resource limits and replicas.
- Live logs with search, an in-browser console, per-service metrics and scheduled scripts with a run history.
- Postgres, MySQL, MariaDB, MongoDB and Redis, with managed credentials, optional public ports, backups you can download and restore, and networks kept apart between projects.
- Compose stacks, ready-made templates, and a modular runtime with a browser IDE.
- A command-line client and an MCP server, held to the same rights as the API.
- Sign-in with two-factor authentication and recovery codes, project roles and API keys.
- English and French, with light and dark themes.

WordPress sites, moving a project between servers, multi-node clusters and tunnels are still to come.

## Run it locally

You need [Bun](https://bun.sh) and Node.js 22.13 or later.

```bash
bun install
bun run dev
```

Open <http://127.0.0.1:5173>. The first-run page asks for a one-time setup code, which the server prints in its log. Development mode uses a simulated Docker driver, so it changes nothing on your machine.

## How it works

Docker Swarm runs the workloads and Traefik routes the traffic. Desired state lives in SQLite, and every deployment compiles it into a Swarm service and a Traefik route. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

The only call a server makes home is to the `opsifier.dev` address service: the registration and a daily heartbeat, and nothing else. It is documented in the architecture notes and can be turned off.

## Security

Whoever controls an Opsifier instance has root-equivalent access to its host through the Docker socket, so treat its credentials accordingly. Please report vulnerabilities privately through GitHub security advisories rather than in a public issue.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Opsifier is an independent project and is not affiliated with or endorsed by any other control panel vendor.
