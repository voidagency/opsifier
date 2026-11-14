# The panel and everything a build on the server needs, for linux/amd64 and linux/arm64.
#
#   docker build -t opsifier --build-arg OPSIFIER_VERSION=1.2.3 .
#   docker buildx build --platform linux/amd64,linux/arm64 -t opsifier .
#
# Only the final stage ends up in the image: each of the others exists so that its compilers,
# package lists and download tools stay out of it.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# ---- JavaScript: the same output on every platform, so it runs natively on the build machine.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install --global bun@1.4.3
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
# The lockfile names every workspace, these included, even though the image builds none of them.
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN bun install --frozen-lockfile --ignore-scripts
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/contract packages/contract
COPY templates templates
RUN bun run build
# What the image owes the software inside it: each license text, and the list the About page shows.
COPY LICENSE NOTICE ./
COPY licenses licenses
RUN bun apps/server/src/bootstrap/notices.ts /src /src/notices

# ---- SQLite's native binding: the one thing in the panel that depends on the platform.
FROM ${NODE_IMAGE} AS native
WORKDIR /native
COPY bun.lock ./
RUN set -eu; \
  version="$(sed -n 's/.*"better-sqlite3@\([0-9][0-9.]*\)".*/\1/p' bun.lock | head -n 1)"; \
  test -n "$version"; \
  npm install --no-package-lock --no-save --omit=dev --no-audit --no-fund "better-sqlite3@$version"; \
  cd node_modules; \
  find better-sqlite3/prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete; \
  rm -rf node-addon-api better-sqlite3/deps better-sqlite3/src better-sqlite3/build

# ---- The Docker CLI and its plugins, from Docker's own repository.
FROM debian:bookworm-slim AS docker
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin

# ---- restic, for backups of the whole server: one static binary, checked against its published sum.
FROM debian:bookworm-slim AS restic
ARG TARGETARCH
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_SHA256_AMD64=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
ARG RESTIC_SHA256_ARM64=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl bzip2; \
  case "$TARGETARCH" in \
    amd64) sum="$RESTIC_SHA256_AMD64" ;; \
    arm64) sum="$RESTIC_SHA256_ARM64" ;; \
    *) echo "No restic for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  file="restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2"; \
  curl -fsSLo "/tmp/$file" "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/$file"; \
  echo "$sum  /tmp/$file" | sha256sum -c -; \
  bunzip2 -c "/tmp/$file" > /usr/local/bin/restic; \
  chmod 0755 /usr/local/bin/restic; \
  /usr/local/bin/restic version

# ---- Nixpacks and Railpack, one binary per version the panel offers, and the pack CLI.
FROM ${NODE_IMAGE} AS builders
ARG TARGETARCH
COPY packages/contract/src/service-tabs/source.ts scripts/install-builders.mjs /tmp/
RUN set -eu; \
  mkdir -p /opt/opsifier/builders /opt/opsifier/bin; \
  node /tmp/install-builders.mjs /tmp/source.ts /opt/opsifier/builders /opt/opsifier/bin "$TARGETARCH"

# ---- What runs on the server.
FROM ${NODE_IMAGE}
ARG OPSIFIER_VERSION=0.1.0
ARG OPSIFIER_IMAGE=
# Each Debian package keeps its copyright file: it is the license that comes with the package.
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates git openssh-client libarchive-tools; \
  rm -rf /var/lib/apt/lists/* /usr/share/man/*; \
  find /usr/share/doc -mindepth 1 -type f ! -name copyright -delete; \
  find /usr/share/doc -mindepth 1 -type d -empty -delete; \
  rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
COPY --from=docker /usr/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=builders /opt/opsifier/builders /opt/opsifier/builders
COPY --from=builders /opt/opsifier/bin/pack /usr/local/bin/pack
COPY --from=restic /usr/local/bin/restic /usr/local/bin/restic
COPY --from=native /native/node_modules /app/node_modules
COPY --from=build /src/apps/server/dist /app/dist
COPY --from=build /src/apps/server/drizzle /app/drizzle
COPY --from=build /src/apps/web/dist /app/web
COPY --from=build /src/notices /usr/share/doc/opsifier
ENV NODE_ENV=production \
    OPSIFIER_WEB_DIR=/app/web \
    OPSIFIER_VERSION=$OPSIFIER_VERSION \
    OPSIFIER_IMAGE=$OPSIFIER_IMAGE
EXPOSE 3000
# Swarm only considers the task running, and an update only starts counting, once this passes.
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OPSIFIER_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/main.js"]
