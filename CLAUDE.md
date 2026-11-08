# Opsifier

Self-hosted control panel for apps and databases. Read `docs/ARCHITECTURE.md` before changing anything.

## Independent implementation

Opsifier is written from scratch. These rules are absolute:

- Never read, unpack or decompile the code of another control panel, including any Docker image, JavaScript bundle or source map of one.
- Copy no code, text, artwork or template content from any other product.

## Commands

- `bun install` installs dependencies.
- `bun run typecheck`, `bun run lint`, `bun run test` must pass before work is considered done.
- `bun run dev` starts the API and web app using `OPSIFIER_DRIVER=fake`.

## Working rules

- Never run Docker commands that change the host daemon, and never run `docker swarm init` on it. Use a Docker-in-Docker sandbox.
- Keep changes inside your feature's folders. Shared registries take one line per feature.
