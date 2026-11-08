#!/usr/bin/env bash
# A throwaway Docker-in-Docker daemon for checking Opsifier against real Docker.
#
#   scripts/sandbox.sh up     Start the sandbox, initialize Swarm and print the environment to use.
#   scripts/sandbox.sh down   Remove the sandbox, its volumes and its data directory.
#
# The host daemon only ever runs this one container, from the local docker:29-dind image.
set -euo pipefail

NAME="${OPSIFIER_SANDBOX_NAME:-opsifier-sandbox}"
IMAGE="docker:29-dind"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${OPSIFIER_SANDBOX_DATA_DIR:-$ROOT/.sandbox/data}"
DOCKER_PORT="${OPSIFIER_SANDBOX_DOCKER_PORT:-23750}"
HTTP_PORT="${OPSIFIER_SANDBOX_HTTP_PORT:-28080}"
HTTPS_PORT="${OPSIFIER_SANDBOX_HTTPS_PORT:-28443}"

exists() {
  [ -n "$(docker ps -aq --filter "name=^/${NAME}$")" ]
}

up() {
  if exists; then
    echo "${NAME} already exists. Run: scripts/sandbox.sh down" >&2
    exit 1
  fi
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "The local image ${IMAGE} is missing, and this script never pulls it." >&2
    exit 1
  fi

  mkdir -p "$DATA_DIR"

  # The data directory keeps its absolute path inside the sandbox, so a bind mount written by the
  # panel on the host resolves to the same place for the workloads and for Traefik's file provider.
  if ! docker run -d \
    --name "$NAME" \
    --privileged \
    --env DOCKER_TLS_CERTDIR= \
    --publish "127.0.0.1:${DOCKER_PORT}:2375" \
    --publish "127.0.0.1:${HTTP_PORT}:80" \
    --publish "127.0.0.1:${HTTPS_PORT}:443" \
    --volume "${DATA_DIR}:${DATA_DIR}" \
    "$IMAGE" >/dev/null; then
    # A failed start still leaves a created container behind.
    docker rm --force --volumes "$NAME" >/dev/null 2>&1 || true
    exit 1
  fi

  echo "Waiting for the sandbox's daemon..." >&2
  for _ in $(seq 1 60); do
    if docker exec "$NAME" docker info >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$NAME" docker info >/dev/null

  docker exec "$NAME" docker swarm init --advertise-addr eth0 >/dev/null

  cat <<ENV
export DOCKER_HOST=tcp://127.0.0.1:${DOCKER_PORT}
export OPSIFIER_DATA_DIR=${DATA_DIR}
ENV
  echo "# Proxy ports inside the sandbox: 80 -> 127.0.0.1:${HTTP_PORT}, 443 -> 127.0.0.1:${HTTPS_PORT}" >&2
}

down() {
  if exists; then
    docker rm --force --volumes "$NAME" >/dev/null
  fi
  rm -rf "$DATA_DIR"
  rmdir "$(dirname "$DATA_DIR")" 2>/dev/null || true
  echo "Sandbox removed." >&2
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "Usage: scripts/sandbox.sh up|down" >&2
    exit 2
    ;;
esac
