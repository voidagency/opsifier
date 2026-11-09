<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/opsifier-banner-dark.png" />
    <img src="docs/brand/opsifier-banner-light.png" alt="Opsifier" width="760" />
  </picture>
</p>

Opsifier is an open-source control panel for your own server. It deploys apps and databases from a web interface that shows the state of everything at a glance. Every feature is included, and there are no paid tiers.

> **Status: early development.** Opsifier is not ready for production yet, and the one-line installer is not published. Expect breaking changes.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png" />
    <img src="docs/screenshots/overview.png" alt="The overview page, with the state of the whole server, gauges and every project" width="900" />
  </picture>
</p>

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

## Screenshots

Taken on a demo server with sample data.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/service.png" alt="A service page" /><br /><b>A service.</b> Its state, resources and live logs on one page.</td>
    <td width="50%"><img src="docs/screenshots/deployments.png" alt="The list of deployments and retained versions" /><br /><b>Deployments.</b> Every version is recorded, and you can go back to it.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/project.png" alt="A project and its services" /><br /><b>A project.</b> Each service with a status light, its resources and its recent deployments.</td>
    <td><img src="docs/screenshots/database.png" alt="A managed database" /><br /><b>Databases.</b> Credentials, connection details and backups in one place.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/domains.png" alt="The domains of a service" /><br /><b>Domains.</b> HTTPS by default, with the state of each certificate.</td>
    <td><img src="docs/screenshots/environment.png" alt="Environment variables" /><br /><b>Environment.</b> Variables sealed at rest, with build inputs kept apart.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/templates.png" alt="The list of templates" /><br /><b>Templates.</b> Ready-made apps to install in a few clicks.</td>
    <td><img src="docs/screenshots/monitor.png" alt="The monitoring page" /><br /><b>Monitoring.</b> The server and every service, with their history.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/purpose.png" alt="The server role and its protection" /><br /><b>Server role.</b> Development, staging or production, and proof of what is protected.</td>
    <td><img src="docs/screenshots/address.png" alt="The server's opsifier.dev address" /><br /><b>Your address.</b> A free name under opsifier.dev, with one wildcard certificate.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity.png" alt="The activity log" /><br /><b>Activity.</b> What happened, who did it and how it ended.</td>
    <td><img src="docs/screenshots/service-dark.png" alt="A service page in the dark theme" /><br /><b>Dark theme.</b> Every screen, in both themes.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/phone-overview.png" alt="The overview on a phone" width="260" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/phone-service.png" alt="A service on a phone" width="260" />
</p>

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
