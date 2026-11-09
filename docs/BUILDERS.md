# Builders

How a service's source becomes an image. A build runs on the server, inside the panel's image, before anything is replaced: a build that fails leaves what is running exactly as it was.

Every tool here is fixed to one version, and a build never falls back to another one. The panel offers exactly what its image ships, and the list lives in `packages/contract/src/service-tabs/source.ts`. Changing it means rebuilding the image, which is the only way a new version gets in.

## The builders

| Builder    | What runs                                                     | What decides the build             | Needs from the server          |
| ---------- | ------------------------------------------------------------- | ---------------------------------- | ------------------------------ |
| Dockerfile | `docker buildx build`, on the server's own Docker             | The `Dockerfile` in the build path | The Docker CLI's buildx plugin |
| Nixpacks   | `nixpacks build`, the binary of the chosen version            | The project, then `nixpacks.toml`  | The Docker CLI's buildx plugin |
| Railpack   | `railpack prepare`, then BuildKit through Railpack's frontend | The project, then `railpack.json`  | The Docker CLI's buildx plugin |
| Buildpacks | `pack build`, with the chosen builder image                   | The project, then `project.toml`   | Docker's API                   |

With no builder chosen, a `Dockerfile` in the build path is used if there is one, and Nixpacks otherwise.

## Compatibility

Every builder needs the same Docker as the rest of the panel: Docker 26.0 or later, on Engine API 1.45 or later. A server that doesn't meet that refuses builds with the reason. Languages come from what each release detects or what each image packs; anything not listed may still work, but a build that doesn't recognise it fails and says so.

### Dockerfile

| Tool                                        | Versions                         | Platforms | Languages                   |
| ------------------------------------------- | -------------------------------- | --------- | --------------------------- |
| `docker buildx` with this server's BuildKit | Whichever Docker the server runs | Its own   | Any, as the Dockerfile says |

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

| Failure                                       | Builders                       | What the deployment says                                                   |
| --------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| The chosen version isn't installed            | Nixpacks, Railpack             | That version is not installed, and which ones are. No other version is run |
| The builder image isn't pinned                | Buildpacks                     | The image can move, so nothing was built                                   |
| The Docker CLI's buildx plugin doesn't work   | Dockerfile, Nixpacks, Railpack | Nothing was built                                                          |
| A name doesn't resolve                        | All                            | To check the server's DNS                                                  |
| A server can't be reached                     | All                            | To check the server's network                                              |
| Docker's disk is full                         | All                            | To free some space                                                         |
| A registry refuses, or an image doesn't exist | All                            | To check the image's name or the access it needs                           |
| The project isn't one it can build            | Nixpacks, Railpack, Buildpacks | To check the languages above, or set the commands                          |

Anything else fails with the exit code, and the deployment's log has the rest.

## Forced rebuilds

"Rebuild from scratch" in the panel, `{ "force": true }` on a deployment, and `?forceRebuild` on a deployment trigger all ask for the same thing: a new build that uses no cache and fetches its base images again.

| Builder    | Build cache               | Base images                                                                                        |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Dockerfile | Skipped (`--no-cache`)    | Fetched again (`--pull`), unless the Dockerfile pins them to a digest                              |
| Railpack   | Skipped (`--no-cache`)    | Fetched again (`--pull`)                                                                           |
| Buildpacks | Cleared (`--clear-cache`) | The builder and run images are fetched again (`--pull-policy=always`)                              |
| Nixpacks   | Skipped (`--no-cache`)    | Stay the same: each Nixpacks release fixes its own base image, and it has no option to change that |

A forced rebuild never changes which version of a builder is used. The running tasks are replaced by the new image, as they are after every deployment, forced or not, and the build's log says what the rebuild did. A build that isn't forced reuses its cache and the base images already on the server. A deployment of an image source has no build to force: it always pulls the image.
