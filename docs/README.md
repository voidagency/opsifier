# Opsifier documentation

Opsifier is an open-source, self-hosted control panel that deploys apps and databases on your own server from a web interface, using Docker Swarm and Traefik. It is in early development and not ready for production yet.

## Guides

- [Install on a server](INSTALL.md): requirements, the one-line installer, its options, and the first steps after it.
- [Deploy your first app](FIRST-APP.md): a project, an app from an image or a repository, its domain, a database, and going back to an earlier version.
- [Back up databases and whole servers](BACKUPS.md): destinations, schedules, retention, downloads, restores, and rebuilding a server from its backup.

## Reference

- [Builders](BUILDERS.md): how source code becomes an image, and what each builder supports.
- [Command line](CLI.md): the `opsifier` command, its output for scripts and its exit codes.
- [MCP server](MCP.md): connecting an AI agent to a panel, its tools and its confirmations.
- [API](API.md): API keys, roles, errors and the OpenAPI document.
- [Architecture](ARCHITECTURE.md): how the panel is built, decision by decision.
