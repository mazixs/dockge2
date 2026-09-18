#!/usr/bin/env bash
#
# Dockge2 installer.
#
# One command on a fresh server: check what is missing, ask the few things that
# cannot be guessed, build the image and start the panel. It writes only inside
# the install directory, the data directory and the stacks directory, and it
# never touches containers it did not create.
#
# Usage:
#   ./install.sh                       interactive
#   ./install.sh --yes                 take every default, ask nothing
#   ./install.sh --port 8080 --stacks-dir /srv/stacks --yes
#   ./install.sh --update              rebuild an existing installation
#
set -euo pipefail

REPO_URL="${DOCKGE2_REPO:-https://github.com/mazixs/dockge2.git}"
BRANCH="main"
INSTALL_DIR="/opt/dockge2"
STACKS_DIR="/opt/stacks"
DATA_DIR=""
PORT=""
ASSUME_YES=0
DO_UPDATE=0
SUDO=""
DOCKER="docker"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mStopped:\033[0m %s\n\n' "$*" >&2; exit 1; }

usage() {
    sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
        --stacks-dir) STACKS_DIR="${2:?--stacks-dir needs a path}"; shift 2 ;;
        --data-dir) DATA_DIR="${2:?--data-dir needs a path}"; shift 2 ;;
        --port) PORT="${2:?--port needs a number}"; shift 2 ;;
        --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
        --update) DO_UPDATE=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) usage ;;
        *) die "Unknown option: $1 (try --help)" ;;
    esac
done

ask() {
    # ask <prompt> <default> -> answer on stdout
    local prompt="$1" default="$2" answer=""
    if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
        printf '%s' "$default"
        return
    fi
    read -r -p "  $prompt [$default]: " answer </dev/tty || true
    printf '%s' "${answer:-$default}"
}

confirm() {
    # confirm <question> -> 0 when the answer is yes
    local answer
    if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
        return 0
    fi
    read -r -p "  $1 [y/N]: " answer </dev/tty || true
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

########################################
# 1. The machine
########################################
say "Checking this machine"

[ "$(uname -s)" = "Linux" ] || die "Dockge2 runs on Linux only."

if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 || die "Run this as root, or install sudo."
    SUDO="sudo"
    info "Not root: privileged steps will go through sudo."
fi

for tool in git curl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is missing. Install it and run this again."
done
info "git and curl are present."

if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    info "The official script from https://get.docker.com would install it."
    if confirm "Run it now?"; then
        curl -fsSL https://get.docker.com | $SUDO sh
    else
        die "Install Docker first: https://docs.docker.com/engine/install/"
    fi
fi

# A member of the docker group needs no sudo, and asking for it anyway would be
# a password prompt for nothing
if docker info >/dev/null 2>&1; then
    DOCKER="docker"
elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
else
    die "Docker is installed but the daemon does not answer. Try: ${SUDO:+$SUDO }systemctl start docker"
fi
info "Docker daemon answers: $($DOCKER version --format '{{.Server.Version}}')."

$DOCKER compose version >/dev/null 2>&1 || die "The Compose V2 plugin is missing (docker compose). Install docker-compose-plugin."
info "Compose plugin: $($DOCKER compose version --short)."

# What already runs here is the user's, and the installer says so rather than deciding for them
RUNNING="$($DOCKER ps --format '{{.Names}}' | wc -l | tr -d ' ')"
if [ "$RUNNING" != "0" ]; then
    info "$RUNNING container(s) already run on this host. Dockge2 will list them, and will not change them."
fi

if $DOCKER ps -a --filter 'label=com.docker.compose.project=dockge2' --format '{{.Names}}' | grep -q .; then
    warn "A dockge2 project already exists on this host."
    [ "$DO_UPDATE" = "1" ] || confirm "Continue and rebuild it?" || die "Nothing was changed."
    DO_UPDATE=1
fi

########################################
# 2. The answers
########################################
say "Settings"

if [ "$DO_UPDATE" = "0" ]; then
    INSTALL_DIR="$(ask 'Install directory' "$INSTALL_DIR")"
    STACKS_DIR="$(ask 'Directory for your stacks' "$STACKS_DIR")"
fi

case "$STACKS_DIR" in /*) ;; *) die "The stacks directory must be an absolute path: docker compose runs inside the container but is executed by the daemon on the host, which gets exactly this path." ;; esac
[ -z "$DATA_DIR" ] && DATA_DIR="$INSTALL_DIR/data"

# Free means nothing listens on it. Without `ss` there is nothing to ask, and a
# guess would be worse than the honest answer: docker itself refuses a taken port
port_is_free() {
    command -v ss >/dev/null 2>&1 || return 0
    ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

if [ -z "$PORT" ]; then
    PORT="$(ask 'Web port for the panel' '5001')"
fi

case "$PORT" in
    ''|*[!0-9]*) die "The port has to be a number." ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "The port has to be between 1 and 65535."

if [ "$DO_UPDATE" = "0" ] && ! port_is_free "$PORT"; then
    warn "Something already listens on port $PORT."
    PORT="$(ask 'Another port' '5001')"
    port_is_free "$PORT" || die "Port $PORT is taken too. Free it or pick another one."
fi

info "Install directory: $INSTALL_DIR"
info "Stacks:            $STACKS_DIR"
info "Data:              $DATA_DIR"
info "Port:              $PORT"

########################################
# 3. The files
########################################
say "Getting the source"

# Writing under /opt needs root, writing under a home directory does not, and a
# password prompt that changes nothing is its own kind of failure
FSUDO=""
writable() {
    local dir="$1"
    while [ ! -e "$dir" ] && [ "$dir" != "/" ]; do dir="$(dirname "$dir")"; done
    [ -w "$dir" ]
}
if ! writable "$INSTALL_DIR" || ! writable "$STACKS_DIR" || ! writable "$DATA_DIR"; then
    [ -n "$SUDO" ] || die "Cannot write to $INSTALL_DIR, $STACKS_DIR or $DATA_DIR."
    FSUDO="$SUDO"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
    info "Already a checkout, fast-forwarding it."
    $FSUDO git -C "$INSTALL_DIR" fetch --prune origin
    $FSUDO git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH"
else
    [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] && die "$INSTALL_DIR exists and is not empty."
    $FSUDO mkdir -p "$INSTALL_DIR"
    $FSUDO git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

$FSUDO mkdir -p "$STACKS_DIR" "$DATA_DIR"

ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    info ".env is already there and is left as it is."
else
    # Only the answers are written. Everything else keeps the documented default
    # from docker-compose.yml, and .env.example explains the rest
    $FSUDO tee "$ENV_FILE" >/dev/null <<ENVEOF
# Written by install.sh. See .env.example for everything else.
DOCKGE_PORT=$PORT
DOCKGE_STACKS_DIR=$STACKS_DIR
DOCKGE_DATA_DIR=$DATA_DIR
DOCKGE_ENABLE_CONSOLE=false
PUID=$(id -u)
PGID=$(id -g)
ENVEOF
    $FSUDO chmod 600 "$ENV_FILE"
    info "Wrote $ENV_FILE"
fi

########################################
# 4. Build and start
########################################
say "Building the image (a few minutes on a small server)"
cd "$INSTALL_DIR"
$DOCKER compose -f docker-compose.yml build
$DOCKER compose -f docker-compose.yml up -d --wait --wait-timeout 120 || {
    warn "The container did not become healthy in time. Its log:"
    $DOCKER compose -f docker-compose.yml logs --tail 40
    die "Dockge2 started but did not report itself healthy."
}

########################################
# 5. Where it is
########################################
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' | head -1)"
[ -z "$LOCAL_IP" ] && LOCAL_IP="127.0.0.1"

say "Dockge2 is running"
info "On this machine: http://127.0.0.1:$PORT"
info "On the network:  http://$LOCAL_IP:$PORT"

# A closed firewall is the usual reason a fresh VPS shows nothing on that link.
# Reading its state needs root, and asking for a password just to warn is not worth it
if command -v ufw >/dev/null 2>&1 && { [ -z "$SUDO" ] || $SUDO -n true 2>/dev/null; }; then
    if $SUDO ufw status 2>/dev/null | grep -q '^Status: active' && ! $SUDO ufw status 2>/dev/null | grep -q "$PORT"; then
        warn "ufw is active and port $PORT is not allowed: ${SUDO:+$SUDO }ufw allow $PORT/tcp"
    fi
fi

TOKEN_FILE="$DATA_DIR/bootstrap-token"
say "Setup code for the first sign-in"
if $FSUDO test -r "$TOKEN_FILE"; then
    info "$($FSUDO cat "$TOKEN_FILE")"
    info "It works once. The first visit asks for it together with the owner account."
else
    warn "No bootstrap-token file: this installation already has an owner, or DOCKGE_BOOTSTRAP_TOKEN is set."
fi

cat <<'NEXT'

  Open the panel over a private network or an SSH tunnel, or put a reverse proxy
  with HTTPS in front of it before exposing it to the internet - see the README.

  Update later:   ./install.sh --update
  Stop:           docker compose -f docker-compose.yml down
NEXT
