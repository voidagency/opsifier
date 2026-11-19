# Builders

How a service's source becomes an image. A build runs on the server, inside the panel's image, before anything is replaced: a build that fails leaves what is running exactly as it was.

Every tool here is fixed to one version, and a build never falls back to another one. The panel offers exactly what its image ships, and the list lives in `packages/contract/src/service-tabs/source.ts`. Changing it means rebuilding the image, which is the only way a new version gets in.

## The builders

| Builder    | What runs                                                            | What decides the build             | Needs from the server          |
| ---------- | -------------------------------------------------------------------- | ---------------------------------- | ------------------------------ |
| Dockerfile | `docker buildx build`, on the server's own Docker                    | The `Dockerfile` in the build path | The Docker CLI's buildx plugin |
| Nixpacks   | `nixpacks build --out`, then `docker buildx build` of what it writes | The project, then `nixpacks.toml`  | The Docker CLI's buildx plugin |
| Railpack   | `railpack prepare`, then BuildKit through Railpack's frontend        | The project, then `railpack.json`  | The Docker CLI's buildx plugin |
| Buildpacks | `pack build`, with the chosen builder image                          | The project, then `project.toml`   | Docker's API                   |

With no builder chosen, a `Dockerfile` in the build path is used if there is one, and Nixpacks otherwise.

Nixpacks and Railpack read the project's code and settings as root, and Nixpacks writes files where those settings say. Neither runs in the panel itself, which holds the server's files and the Docker socket: each runs in a throwaway container of the panel's own image, given the build's copy of the code at the same path and nothing else of the server, with no Docker socket, no capabilities and no way to gain privileges. Nixpacks runs with no network. Railpack's first step keeps the network, since Railpack fetches the tool it resolves versions with, and is also given the folder its plan goes in. A variable reaches either by name. A panel that can't tell which image it runs from, as one started outside Docker, builds with neither.

## Compatibility

Every builder needs the same Docker as the rest of the panel: Docker 26.0 or later, on Engine API 1.45 or later. A server that doesn't meet that refuses builds with the reason. Languages come from what each release detects or what each image packs; anything not listed may still work, but a build that doesn't recognise it fails and says so.

### Dockerfile

| Tool                                        | Versions                         | Platforms | Languages                   |
| ------------------------------------------- | -------------------------------- | --------- | --------------------------- |
| `docker buildx` with this server's BuildKit | Whichever Docker the server runs | Its own   | Any, as the Dockerfile says |

Every Dockerfile, and the one Nixpacks writes, is read by the same frontend: Docker's stable `docker/dockerfile`, at the version the panel pins, whatever the file's `# syntax=` line says. A line asking for the labs frontend (`docker/dockerfile:1-labs` and the like) is not refused but has no effect, so an instruction or a flag only labs knows fails the build. BuildKit fetches the pinned frontend from Docker Hub the first time a server builds a Dockerfile and keeps it from then on, until its build cache is cleared: a server that can't reach Docker Hub can't build one.

A build signs in to no registry with the panel's own Docker credentials, which every project would share: its Docker configuration is one of its own, with nothing but the `proxies` of the panel's (`~/.docker/config.json` of the panel's user), which the Docker CLI hands to every build and container it starts. A base image only those credentials could pull fails the build.

### Nixpacks

Run from `/opt/opsifier/builders/nixpacks/<version>/nixpacks`.

| Versions                                       | Platforms    | Languages                                                                                                                                                                |
| ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.41.0, 1.40.0, 1.39.0, 1.38.0, 1.37.0, 1.36.0 | amd64, arm64 | C# and .NET, Clojure, COBOL, Crystal, Dart, Deno, Elixir, F#, Gleam, Go, Haskell, Java, Lunatic, Node.js, PHP, Python, Ruby, Rust, Scala, Scheme, Staticfile, Swift, Zig |

### Railpack

Run from `/opt/opsifier/builders/railpack/<version>/railpack`, then carried out by `ghcr.io/railwayapp/railpack-frontend:v<version>` of the same version. Later versions detect more languages.

| Versions                                       | Platforms    | Languages                                                                                                   |
| ---------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| 0.17.1, 0.17.0, 0.16.0, 0.15.4, 0.15.0, 0.14.0 | amd64, arm64 | Deno, Elixir, Go, Java, Node.js, PHP, Python, Ruby, Rust, Shell scripts, Staticfile, Gleam, .NET, C and C++ |
| 0.13.0, 0.12.0, 0.11.0                         | amd64, arm64 | Deno, Elixir, Go, Java, Node.js, PHP, Python, Ruby, Rust, Shell scripts, Staticfile, Gleam, .NET            |
| 0.10.0                                         | amd64, arm64 | Deno, Elixir, Go, Java, Node.js, PHP, Python, Ruby, Rust, Shell scripts, Staticfile, Gleam                  |
| 0.9.2                                          | amd64, arm64 | Deno, Elixir, Go, Java, Node.js, PHP, Python, Ruby, Rust, Shell scripts, Staticfile                         |

### Buildpacks

Run by `pack` 0.40.0, with a builder image pinned to a digest or to a release that is never rebuilt.

| Builder image                                                                               | Platforms    | Languages                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `heroku/builder:24@sha256:7eaa43fc56aefe79b3c35cd08399ba4852f168ad9836bc1144ea216ceb025d85` | amd64, arm64 | .NET, Go, Java, Node.js, PHP, Python, Ruby, Scala                                           |
| `heroku/builder:22@sha256:4630eaab77371365c174bb39dcd1e43e9806f76588bb07c3fe7591bd13f4861c` | amd64        | Deprecated by Heroku. .NET, Go, Java, Node.js, PHP, Python, Ruby, Scala                     |
| `heroku/builder:20@sha256:237c875783e9ead0bc1eafa84535d58fc16d34777692d5b5ccaf965082f5d11a` | amd64        | Go, Java, Node.js, PHP, Python, Ruby, Scala. Heroku has stopped updating it                 |
| `paketobuildpacks/builder-jammy-full:0.3.705`                                               | amd64        | .NET, Go, Java, Java Native Image, Node.js, PHP, Python, Ruby, Static sites (Nginx, Apache) |
| `paketobuildpacks/builder-jammy-base:0.4.681`                                               | amd64        | .NET, Go, Java, Java Native Image, Node.js, Python, Ruby, Static sites (Nginx, Apache)      |
| `paketobuildpacks/builder-jammy-tiny:0.0.595`                                               | amd64        | Go, Java, Java Native Image                                                                 |

Any other builder image can be saved as long as it is pinned, to a digest or to a full release such as `0.4.681`, and it is then up to you what it supports.

## Overrides

| Builder    | What can be changed                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Dockerfile | The Dockerfile's path. Everything else is in the file. Build variables and secrets come from the Environment tab |
| Nixpacks   | The install, build and start commands, Nix and APT packages, and `nixpacks.toml` in the build path               |
| Railpack   | The install, build and start commands, Mise and APT packages, and `railpack.json` in the build path              |
| Buildpacks | The builder image, and `project.toml` in the build path                                                          |

A command set here replaces the one that would have been detected. Nixpacks receives no build secrets, because it writes everything it is given into the image.

## When a build fails

The deployment fails, says why, and leaves what is running alone. These are the failures it can name:

| Failure                                              | Builders                       | What the deployment says                                                   |
| ---------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| The chosen version isn't installed                   | Nixpacks, Railpack             | That version is not installed, and which ones are. No other version is run |
| The panel can't tell which image it runs from        | Nixpacks, Railpack             | That they only run in a container of it, so nothing was built              |
| The builder image isn't pinned                       | Buildpacks                     | The image can move, so nothing was built                                   |
| The Docker CLI's buildx plugin doesn't work          | Dockerfile, Nixpacks, Railpack | Nothing was built                                                          |
| A name doesn't resolve                               | All                            | To check the server's DNS                                                  |
| A server can't be reached                            | All                            | To check the server's network                                              |
| Docker's disk is full                                | All                            | To free some space                                                         |
| A registry refuses, or an image doesn't exist        | All                            | To check the image's name or the access it needs                           |
| An image belongs to another project or to the server | All                            | `image_not_allowed`: which image, and that it isn't this project's to use  |
| The project isn't one it can build                   | Nixpacks, Railpack, Buildpacks | To check the languages above, or set the commands                          |

Anything else fails with the exit code, and the deployment's log has the rest.

## Forced rebuilds

"Rebuild from scratch" in the panel, `{ "force": true }` on a deployment, and `?forceRebuild` on a deployment trigger all ask for the same thing: a new build that uses no cache and fetches its base images again.

| Builder    | Build cache               | Base images                                                                                                                                         |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dockerfile | Skipped (`--no-cache`)    | Fetched from their registry, as on every build (`--pull`)                                                                                           |
| Railpack   | Skipped (`--no-cache`)    | Fetched from their registry, as on every build (`--pull`)                                                                                           |
| Buildpacks | Cleared (`--clear-cache`) | The builder and its run image are pulled by the panel, as on every build, and pack fetches every other image it uses again (`--pull-policy=always`) |
| Nixpacks   | Skipped (`--no-cache`)    | Fetched from their registry, as on every build (`--pull`), and stay the same: each Nixpacks release fixes its own base image                        |

A forced rebuild never changes which version of a builder is used. The running tasks are replaced by the new image, as they are after every deployment, forced or not, and the build's log says what the rebuild did. A build that isn't forced reuses its cache. A deployment of an image source has no build to force: it always pulls the image.

Every build on the server shares one image store with every project's builds and services. So a Dockerfile build, forced or not, fetches what its `FROM`, `COPY --from` and `RUN --mount=from=` name from their registry, and never takes an image the server already holds under that name: a Dockerfile can no longer start from an image built on this server, even one of its own project's. To reuse what another build makes, build it in a stage of the same Dockerfile, or push it to a registry and name it there. An image the Dockerfile pins to a digest is pulled by the panel first, with no credentials, since an image store may hand over a digest it already holds without asking the registry; the build stops if the registry won't give it.

Nixpacks would run `docker build` itself, without `--pull`, so it only writes what it would build (`nixpacks build --out`), and the panel builds that Dockerfile as it builds any other, with `--pull`, its own frontend, and the build arguments its Dockerfile declares, with the project's own values and, for the rest, the ones Nixpacks writes in its `.nixpacks/build.sh`, taken as they are, spaces, quotes and newlines included. One of Nixpacks's own values whose name would act on the build tools, as Ruby's `MALLOC_ARENA_MAX`, still reaches the build, as an argument; one named `BUILDKIT_*` never does. The other builders have no such option, or decide for themselves, so the panel reads what each one will use before it runs, as the builder itself writes it down: every image Railpack's plan names, and for Buildpacks the builder with the run image its labels name, which pack is then given with `--run-image`. It pulls each one, with no credentials, and the build stops when a registry won't give one, before the builder runs.

## Images from other projects

Every image on the server sits in one store, which every project draws from by name. A project can't use what belongs to another project or to the server, and the panel refuses it with `image_not_allowed`, naming the image and never the project:

- `opsifier/<project>/…` of another project, the images the panel builds for it, and anything else under `opsifier/`, such as `opsifier/releases/…`, where the server keeps every version it deploys;
- a name whose first part is another project's `<project>_…`, which is how a Compose stack names its images.

An image source is refused when it is saved, and again when it is deployed or started. A Dockerfile, inline or in the repository, is read when it is saved and again by every build, with the build variables it is given: what `FROM`, `COPY --from` and `RUN --mount=from=` name, after its `ARG` values, in every way the file can be read. A name the panel can't work out stops the build. A frontend chooses for itself which images it reads, so every Dockerfile is built with Docker's own, `docker/dockerfile` at the version the panel pins, given as `BUILDKIT_SYNTAX` whatever the file's syntax line says; a syntax line that names another frontend, and a file that is a JSON document, are refused. What Nixpacks, Railpack and Buildpacks write down before they build is held to the same rule, and so is every buildpack that `project.toml` adds, read in the order pack resolves it: one pack fetches as an image, written `docker://…` or as a plain image name such as `registry.example.com/team/bp:1.0.0`, is checked and pulled by the panel first; one pack would look up in the Buildpack Registry (`urn:cnb:registry:…`, a bare `namespace/name` with or without `@version`, or an `id` and `version` the builder doesn't hold) is refused, since pack finds that image itself, and can be named by its image instead; a folder or archive outside the source is refused, as pack would read it on the panel's own disk. One of the builder's own, by its id, and a download over HTTPS are left to pack. A new project can't be called `releases`.
