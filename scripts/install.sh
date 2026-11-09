#!/usr/bin/env bash
# Installs Opsifier on a Linux server, or brings an existing install back in shape.
#
#   curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | sudo bash
#
# Options:
#   --version <tag>         Install this release instead of the latest one.
#   --image <ref>           Install this image reference instead of the official one.
#   --advertise-addr <ip>   The address Swarm advertises. Worked out from the default route otherwise.
#   --server-ip <ip>        The address people reach this server on, when it differs, as behind NAT.
#   --force                 Passed on to the setup command: replace what is in the way, such as a
#                           service named opsifier that setup did not create. Off by default.
#   --clean-up              Do not install. Show what an install that stopped partway made, and what
#                           stays because it was not that install's to remove. Changes nothing.
#   --yes                   With --clean-up, remove what it lists. Docker itself and the panel's
#                           image stay, since an interrupted install may not be the only thing using them.
#
# Running it again changes nothing that is already right, and never updates Docker or the panel.
set -euo pipefail

readonly OFFICIAL_IMAGE="ghcr.io/voidagency/opsifier"
readonly DATA_DIR="/var/lib/opsifier"
# A server sold as 2 GB reports a little less, so the limit sits just under it.
readonly MIN_MEMORY_MB=1800
readonly MIN_DOCKER_MAJOR=26
readonly SUPPORTED_DISTROS="Ubuntu and Debian"

image=""
version="latest"
advertise_addr=""
server_ip=""
force=false
clean_up=false
yes=false

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) version="${2:?--version needs a value}"; shift 2 ;;
      --image) image="${2:?--image needs a value}"; shift 2 ;;
      --advertise-addr) advertise_addr="${2:?--advertise-addr needs a value}"; shift 2 ;;
      --server-ip) server_ip="${2:?--server-ip needs a value}"; shift 2 ;;
      --force) force=true; shift ;;
      --clean-up) clean_up=true; shift ;;
      --yes) yes=true; shift ;;
      -h | --help)
        sed -n '2,18p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  if [ "$clean_up" = true ] && [ -z "$image" ] && [ "$version" = "latest" ]; then
    # The image the interrupted install ran from, so it is that install's own command that undoes it.
    image="$(sed -n 's/.*"image": *"\([^"]*\)".*/\1/p' "${DATA_DIR}/setup-state.json" 2>/dev/null | head -n 1 || true)"
  fi
  if [ -z "$image" ]; then
    image="${OFFICIAL_IMAGE}:${version}"
  fi
}

check_root() {
  [ "$(id -u)" -eq 0 ] || die "Run this as root, for example with sudo."
}

check_os() {
  [ "$(uname -s)" = "Linux" ] || die "Opsifier installs on Linux, and this is $(uname -s)."
  case "$(uname -m)" in
    x86_64 | aarch64 | arm64) ;;
    *) die "Unsupported processor: $(uname -m). Opsifier runs on x86_64 and arm64." ;;
  esac
  [ -r /etc/os-release ] || die "Could not read /etc/os-release to tell which Linux this is."
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID:-}"
  os_codename="${VERSION_CODENAME:-}"
  say "Operating system: ${PRETTY_NAME:-$os_id}"
}

check_memory() {
  local memory_mb
  memory_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  [ "${memory_mb:-0}" -ge "$MIN_MEMORY_MB" ] ||
    die "This server has ${memory_mb:-an unknown amount of} MB of memory, and Opsifier needs 2 GB."
  say "Memory: ${memory_mb} MB"
}

# True when something is listening on this TCP port on any address.
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -H -ltn "sport = :${port}" 2>/dev/null)" ]
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v port=":${port}" '$4 ~ port "$" { found = 1 } END { exit !found }'
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
  fi
}

# True when a service of this name exists and was created by setup, so its ports are expected.
is_our_service() {
  command -v docker >/dev/null 2>&1 &&
    [ "$(docker service inspect "$1" --format '{{index .Spec.Labels "opsifier.managed"}}' 2>/dev/null)" = "true" ]
}

check_ports() {
  local ports=()
  is_our_service opsifier-traefik || ports+=(80 443)
  is_our_service opsifier || ports+=(3000)
  if [ "${#ports[@]}" -eq 0 ]; then
    say "Ports: already in use by Opsifier"
    return
  fi
  local port busy=()
  for port in "${ports[@]}"; do
    if port_in_use "$port"; then
      busy+=("$port")
    fi
  done
  [ "${#busy[@]}" -eq 0 ] || die "Port ${busy[*]} is already in use. Free it, then run this again."
  say "Ports: ${ports[*]} are free"
}

docker_works() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

wait_for_docker() {
  local attempt
  for attempt in $(seq 1 30); do
    docker_works && return 0
    sleep 1
    : "$attempt"
  done
  return 1
}

# Docker's own instructions for Debian and Ubuntu, nothing else: the distribution's packages lag behind.
install_docker() {
  case "$os_id" in
    ubuntu | debian) ;;
    *) die "Docker is not installed, and this script can only install it on ${SUPPORTED_DISTROS}. Install Docker, then run this again." ;;
  esac
  [ -n "$os_codename" ] || die "Could not tell which release of ${os_id} this is."

  say "Installing Docker from the official repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${os_id}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$os_id" "$os_codename" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker >/dev/null 2>&1 || true
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker
  fi
  if ! docker_works; then
    systemctl start docker >/dev/null 2>&1 || true
    wait_for_docker || die "Docker is installed but does not answer. See: journalctl -u docker"
  fi

  local server_version major
  server_version="$(docker version --format '{{.Server.Version}}')"
  major="${server_version%%.*}"
  # An upgrade is the owner's decision: this only says so, before anything has changed.
  [ "${major:-0}" -ge "$MIN_DOCKER_MAJOR" ] ||
    die "Docker ${server_version} is too old. Opsifier needs ${MIN_DOCKER_MAJOR} or later: upgrade Docker, then run this again."
  say "Docker: ${server_version}"
}

# The address Swarm should advertise: the one this server would use to reach the outside world.
# Asking the routing table sends nothing anywhere.
detect_advertise_addr() {
  [ -z "$advertise_addr" ] || return 0
  # Swarm keeps the address it already has.
  [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" != "active" ] || return 0
  advertise_addr="$( (ip -4 route get 1.1.1.1 2>/dev/null || true) | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -n 1)"
}

run_setup() {
  local args=(setup --image "$image")
  [ -z "$advertise_addr" ] || args+=(--advertise-addr "$advertise_addr")
  [ -z "$server_ip" ] || args+=(--server-ip "$server_ip")
  [ "$force" = false ] || args+=(--force)
  local env_args=()
  [ -z "${OPSIFIER_NAMES_URL:-}" ] || env_args+=(-e "OPSIFIER_NAMES_URL=${OPSIFIER_NAMES_URL}")

  say "Downloading ${image}"
  docker pull "$image"
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"

  # Host networking so that setup can see which ports are really free on this server.
  docker run --rm --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${DATA_DIR}:${DATA_DIR}" \
    ${env_args[@]+"${env_args[@]}"} \
    "$image" "${args[@]}" || {
    warn "If this stopped partway, running this script again carries on, and --clean-up removes what it made."
    exit 1
  }
}

# Undoes an install that stopped partway. The image's own command knows exactly what that install made.
run_clean_up() {
  [ -d "$DATA_DIR" ] || die "There is no record of an install on this server."
  { command -v docker >/dev/null 2>&1 && docker_works; } ||
    die "Docker does not answer, so what an earlier install made cannot be checked."
  local args=(clean-setup)
  [ "$yes" = false ] || args+=(--yes)
  docker run --rm --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${DATA_DIR}:${DATA_DIR}" \
    "$image" "${args[@]}"
  if [ "$yes" = true ]; then
    # Only goes if nothing is left in it, so it can never take anything that stayed.
    rmdir "$DATA_DIR" 2>/dev/null || true
  fi
}

main() {
  parse_args "$@"
  check_root
  check_os
  if [ "$clean_up" = true ]; then
    run_clean_up
    return
  fi
  check_memory
  check_ports
  ensure_docker
  detect_advertise_addr
  run_setup
}

# Everything is inside functions, so a download cut off midway cannot run half a script.
main "$@"
