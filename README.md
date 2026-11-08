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
- Deployments from a Docker image, a Git repository, GitHub, an inline Dockerfile or an uploaded archive.
- Domains with HTTPS through Traefik, redirects, basic authentication and maintenance mode.
- Environment variables, volumes, published ports, resource limits and replicas.
- Live logs with search, an in-browser console and per-service metrics.
- Postgres, MySQL, MariaDB, MongoDB and Redis, with managed credentials and optional public ports.
- Sign-in with two-factor authentication and recovery codes.
- English and French, with light and dark themes.

Templates, Compose stacks, backups, platform administration and the installer are under way.

## Run it locally

You need [Bun](https://bun.sh) and Node.js 22.13 or later.

```bash
bun install
bun run dev
```

Open <http://127.0.0.1:5173>. The first-run page asks for a one-time setup code, which the server prints in its log. Development mode uses a simulated Docker driver, so it changes nothing on your machine.

## How it works

Docker Swarm runs the workloads and Traefik routes the traffic. Desired state lives in SQLite, and every deployment compiles it into a Swarm service and a Traefik route. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Security

Whoever controls an Opsifier instance has root-equivalent access to its host through the Docker socket, so treat its credentials accordingly. Please report vulnerabilities privately through GitHub security advisories rather than in a public issue.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Opsifier is an independent project and is not affiliated with or endorsed by any other control panel vendor.
