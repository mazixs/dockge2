#!/usr/bin/env bash
#
# Dockge2 installer.
#
# One command on a fresh server: check what is missing, ask the few things that
# cannot be guessed, show them for review, build the image and start the panel.
# It writes only inside the install directory, the data directory and the stacks
# directory, and it never touches containers it did not create.
#
# Usage:
#   ./install.sh                       interactive
#   ./install.sh --yes                 take every default, ask nothing
#   ./install.sh --port 8080 --stacks-dir /srv/stacks --yes
#   ./install.sh --update              rebuild the installation this script lives in
#
set -euo pipefail

REPO_URL="${DOCKGE2_REPO:-https://github.com/mazixs/dockge2.git}"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/dockge2"
DEFAULT_STACKS_DIR="/opt/stacks"
DEFAULT_PORT="5001"
# Where a released image is looked for. Building is the expensive part of an
# install, so it is the fallback, not the first move
DEFAULT_IMAGE_REPO="ghcr.io/mazixs/dockge2"
DEFAULT_IMAGE_CHANNEL="latest"

BRANCH=""
INSTALL_DIR=""
STACKS_DIR=""
DATA_DIR=""
PORT=""
ASSUME_YES=0
DO_UPDATE=0
INTERACTIVE=0
SUDO=""
FSUDO=""
DOCKER="docker"
ENV_FILE=""
CLEANUP_DIR=""
ROLLBACK_IMAGE=""
ROLLBACK_COMMIT=""
IMAGE_REPO="${DOCKGE2_IMAGE_REPO:-$DEFAULT_IMAGE_REPO}"
IMAGE_CHANNEL="${DOCKGE2_IMAGE_CHANNEL:-$DEFAULT_IMAGE_CHANNEL}"
IMAGE_REF=""
BUILD_FROM_SOURCE=0

# Every explicit answer is remembered as explicit: an existing .env is the truth
# for everything the user did not name on the command line, and the command line
# is the truth for what they did
DIR_SET=0
STACKS_SET=0
DATA_SET=0
PORT_SET=0
BRANCH_SET=0

# Diagnostics go to stderr so that a function can both talk to the user and
# return a value on stdout
say()  { printf '\n\033[1m%s\033[0m\n' "$*" >&2; }
info() { printf '  %s\n' "$*" >&2; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31mStopped:\033[0m %s\n\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Dockge2 installer.

  ./install.sh                       interactive
  ./install.sh --yes                 take every default, ask nothing
  ./install.sh --port 8080 --stacks-dir /srv/stacks --yes
  ./install.sh --update              rebuild the installation this script lives in

  --dir PATH          where this repository is checked out (default /opt/dockge2)
  --stacks-dir PATH   where your stacks live, absolute path only (default /opt/stacks)
  --data-dir PATH     database, settings and secrets (default <install dir>/data)
  --port NUMBER       the port the panel answers on (default 5001)
  --branch NAME       branch to install from (default main, or the one already checked out)
  --image REF         use this published image instead of looking for one
  --build             build from the sources, do not look for a published image
  --update            rebuild an existing installation
  -y, --yes           take the defaults and ask nothing
  -h, --help          this text

By default a published image is downloaded and nothing is built here: building needs
about 1 GB of memory, running the panel needs about 170 MB. When no published image is
available the installer builds from the sources and says so. --build always builds, and
is the way to install the code of a branch rather than the last release.

Without a terminal the installer cannot ask anything, so it stops and asks for --yes
rather than deciding on its own.
USAGE
    exit 0
}

need_value() {
    # need_value <option> <value...>
    [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (try --help)."
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) need_value "$1" "${2:-}"; INSTALL_DIR="$2"; DIR_SET=1; shift 2 ;;
        --stacks-dir) need_value "$1" "${2:-}"; STACKS_DIR="$2"; STACKS_SET=1; shift 2 ;;
        --data-dir) need_value "$1" "${2:-}"; DATA_DIR="$2"; DATA_SET=1; shift 2 ;;
        --port) need_value "$1" "${2:-}"; PORT="$2"; PORT_SET=1; shift 2 ;;
        --branch) need_value "$1" "${2:-}"; BRANCH="$2"; BRANCH_SET=1; shift 2 ;;
        --image) need_value "$1" "${2:-}"; IMAGE_REF="$2"; shift 2 ;;
        --build) BUILD_FROM_SOURCE=1; shift ;;
        --update) DO_UPDATE=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) usage ;;
        *) die "Unknown option: $1 (try --help)" ;;
    esac
done

########################################
# Talking to the user
########################################

# A terminal is a terminal even when stdin is the script itself, which is what
# `curl ... | bash` does. Guessing "yes" there would install Docker and rebuild a
# running panel without anyone agreeing to it
# 2>/dev/null comes first on purpose: a redirection that fails is reported by
# the shell through the stderr it has at that moment, so the other order prints
# "/dev/tty: No such device or address" before our own message
if [ "$ASSUME_YES" = "0" ] && : 2>/dev/null </dev/tty; then
    INTERACTIVE=1
fi
if [ "$ASSUME_YES" = "0" ] && [ "$INTERACTIVE" = "0" ]; then
    die "There is no terminal to ask questions on. Re-run with --yes to accept every default, or give the answers as options (see --help)."
fi

ask() {
    # ask <prompt> <default> -> answer on stdout
    local prompt="$1" default="$2" answer=""
    if [ "$INTERACTIVE" = "0" ]; then
        printf '%s' "$default"
        return
    fi
    read -r -p "  $prompt [$default]: " answer </dev/tty || true
    printf '%s' "${answer:-$default}"
}

ask_raw() {
    # ask_raw <prompt> -> answer on stdout, no default shown
    local answer=""
    [ "$INTERACTIVE" = "1" ] || return 0
    read -r -p "  $1: " answer </dev/tty || true
    printf '%s' "$answer"
}

confirm() {
    # confirm <question> -> 0 when the answer is yes. Without a terminal only
    # --yes can answer, and --yes means yes
    local answer
    if [ "$INTERACTIVE" = "0" ]; then
        [ "$ASSUME_YES" = "1" ] && return 0
        return 1
    fi
    read -r -p "  $1 [y/N]: " answer </dev/tty || true
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# A partially cloned directory is worse than no directory: the next run would
# refuse it as "not empty" and there would be no way forward except rm -rf. A
# directory the user made themselves is theirs, so only its contents go
CLEANUP_KEEP_DIR=0
cleanup() {
    local code=$?
    if [ -n "$CLEANUP_DIR" ]; then
        if [ "$CLEANUP_KEEP_DIR" = "1" ]; then
            warn "Emptying the half-written $CLEANUP_DIR (the directory itself was there before)."
            $FSUDO find "$CLEANUP_DIR" -mindepth 1 -delete 2>/dev/null || true
        else
            warn "Removing the half-written $CLEANUP_DIR."
            $FSUDO rm -rf "$CLEANUP_DIR"
        fi
    fi
    exit "$code"
}
trap cleanup EXIT
trap 'die "Interrupted."' INT TERM

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
        curl -fsSL https://get.docker.com | $SUDO sh || die "The Docker install script failed. Install Docker by hand: https://docs.docker.com/engine/install/"
        if [ -n "$SUDO" ]; then
            info "To use docker without sudo later: ${SUDO} usermod -aG docker $(id -un), then log in again."
        fi
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
COMPOSE_VERSION="$($DOCKER compose version --short 2>/dev/null | tr -d 'v' | tr -d ' ')"
info "Compose plugin: ${COMPOSE_VERSION:-unknown}."

# --wait-timeout only exists from Compose 2.17. Passing it to an older plugin
# would fail as "unknown flag" and look exactly like a panel that never started
WAIT_ARGS=( --wait )
compose_has_wait_timeout() {
    local major minor
    major="$(printf '%s' "$COMPOSE_VERSION" | cut -d. -f1)"
    minor="$(printf '%s' "$COMPOSE_VERSION" | cut -d. -f2)"
    case "$major$minor" in ''|*[!0-9]*) return 1 ;; esac
    [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 17 ]; }
}
if compose_has_wait_timeout; then
    WAIT_ARGS=( --wait --wait-timeout 180 )
else
    warn "Compose ${COMPOSE_VERSION:-<2.17} has no --wait-timeout: the start will be waited for without a deadline."
fi

if docker --version 2>/dev/null | grep -qi podman; then
    warn "This docker command is Podman. The panel is tested against Docker Engine; Compose behaviour may differ."
fi

# What already runs here is the user's, and the installer says so rather than deciding for them
RUNNING="$($DOCKER ps --format '{{.Names}}' | wc -l | tr -d ' ')"
if [ "$RUNNING" != "0" ]; then
    info "$RUNNING container(s) already run on this host. Dockge2 will list them, and will not change them."
fi

# Another dockge2 on this host is a reason to say so, not a reason to decide
# that this run is an update: it may well be a second installation elsewhere
if $DOCKER ps -a --filter 'label=com.docker.compose.project=dockge2' --format '{{.Names}}' | grep -q .; then
    warn "A dockge2 project already exists on this host. docker-compose.yml pins the project name to \"dockge2\", so a second installation in another directory would take over those containers rather than stand beside them."
    [ "$DO_UPDATE" = "1" ] || confirm "Continue anyway?" || die "Nothing was changed."
fi

# The build happens on the Docker root filesystem, and running out of space
# there fails in the middle of npm or apt with an error about neither
DOCKER_ROOT="$($DOCKER info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$DOCKER_ROOT" ] && [ -d "$DOCKER_ROOT" ] || DOCKER_ROOT="/var/lib/docker"
if [ -d "$DOCKER_ROOT" ]; then
    FREE_MB="$(df -Pm "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
    case "${FREE_MB:-}" in
        ''|*[!0-9]*) ;;
        *) if [ "$FREE_MB" -lt 2500 ]; then
               warn "Only ${FREE_MB} MB free on $DOCKER_ROOT; the build needs around 2 GB."
               confirm "Try anyway?" || die "Free some space and run this again."
           fi ;;
    esac
fi

########################################
# 2. The answers
########################################

# An installation is the checkout this script lives in. Reading it from the
# script's own location is the only way --update can be right for someone who
# installed somewhere other than /opt/dockge2
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)"
if [ "$DIR_SET" = "0" ]; then
    if [ -d "$SCRIPT_DIR/.git" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/docker/Dockerfile" ]; then
        INSTALL_DIR="$SCRIPT_DIR"
        [ "$DO_UPDATE" = "1" ] && info "Updating the checkout this script lives in: $INSTALL_DIR"
    else
        INSTALL_DIR="$DEFAULT_INSTALL_DIR"
    fi
fi

check_abs() {
    # check_abs <path> -> 0 when it can be used as a host path
    case "$1" in
        /) return 1 ;;
        /*) ;;
        *) return 1 ;;
    esac
    case "$1" in
        *[[:space:]]*|*:*) return 1 ;;
    esac
    return 0
}

ask_path() {
    # ask_path <prompt> <default> -> absolute path on stdout
    local prompt="$1" default="$2" answer
    while :; do
        answer="$(ask "$prompt" "$default")"
        answer="${answer%/}"
        if check_abs "$answer"; then
            printf '%s' "$answer"
            return
        fi
        [ "$INTERACTIVE" = "1" ] || die "$prompt has to be an absolute path without spaces or a colon: ${answer:-<empty>}"
        warn "An absolute path without spaces or a colon is needed here: docker compose runs inside the container but is executed by the daemon on the host, which gets exactly this path."
    done
}

# Free means nothing listens on it. Without `ss` there is nothing to ask, and a
# guess would be worse than the honest answer: docker itself refuses a taken port
port_is_free() {
    command -v ss >/dev/null 2>&1 || return 0
    ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

next_free_port() {
    local candidate="$1" tries=0
    while [ "$tries" -lt 50 ]; do
        port_is_free "$candidate" && { printf '%s' "$candidate"; return; }
        candidate=$((candidate + 1))
        tries=$((tries + 1))
    done
    printf '%s' "$1"
}

port_is_valid() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

choose_port() {
    # choose_port <starting value> -> a valid, free port on stdout
    local candidate="$1" suggestion
    while :; do
        if ! port_is_valid "$candidate"; then
            [ "$INTERACTIVE" = "1" ] || die "The port has to be a number between 1 and 65535: ${candidate:-<empty>}"
            warn "The port has to be a number between 1 and 65535."
            candidate="$(ask 'Web port for the panel' "$DEFAULT_PORT")"
            continue
        fi
        if [ "$EXISTING" = "1" ] || port_is_free "$candidate"; then
            printf '%s' "$candidate"
            return
        fi
        suggestion="$(next_free_port $((candidate + 1)))"
        [ "$INTERACTIVE" = "1" ] || die "Port $candidate is already taken. Free it, or pass --port $suggestion."
        warn "Something already listens on port $candidate."
        candidate="$(ask 'Another port' "$suggestion")"
    done
}

# An existing installation has already answered all of this, and its .env is the
# answer. Re-asking would invent a second truth next to the running container,
# and silently ignoring an option given on the command line would invent a third.
# A root-owned .env from an earlier run as root is still the answer: it is read
# through sudo rather than replaced by the defaults, which would send the
# installer looking for stacks in a directory nobody chose
env_contents() {
    if [ -r "$INSTALL_DIR/.env" ]; then
        cat "$INSTALL_DIR/.env"
    elif [ -f "$INSTALL_DIR/.env" ] && [ -n "$SUDO" ]; then
        $SUDO cat "$INSTALL_DIR/.env" 2>/dev/null || true
    fi
}

read_env() {
    [ -f "$INSTALL_DIR/.env" ] || return 0
    env_contents | sed -n "s/^$1=//p" | tail -1 | tr -d '\r' || true
}

HAS_ENV=0
if [ -f "$INSTALL_DIR/.env" ]; then
    HAS_ENV=1
    if [ ! -r "$INSTALL_DIR/.env" ]; then
        warn "$INSTALL_DIR/.env belongs to another user; it is read through sudo, and its owner is fixed before docker compose needs it."
    fi
fi

# What is already installed here decides what may still be asked. The --update
# flag only says the user expects it to exist
EXISTING=0
if [ -d "$INSTALL_DIR/.git" ] || [ "$HAS_ENV" = "1" ]; then
    EXISTING=1
fi

if [ "$HAS_ENV" = "1" ]; then
    ENV_STACKS="$(read_env DOCKGE_STACKS_DIR)"
    ENV_DATA="$(read_env DOCKGE_DATA_DIR)"
    ENV_PORT="$(read_env DOCKGE_PORT)"
    [ "$STACKS_SET" = "0" ] && [ -n "$ENV_STACKS" ] && STACKS_DIR="$ENV_STACKS"
    [ "$DATA_SET" = "0" ] && [ -n "$ENV_DATA" ] && DATA_DIR="$ENV_DATA"
    [ "$PORT_SET" = "0" ] && [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi

say "Settings"

if [ "$EXISTING" = "0" ]; then
    [ "$DIR_SET" = "1" ] || INSTALL_DIR="$(ask_path 'Install directory' "$INSTALL_DIR")"
    [ "$STACKS_SET" = "1" ] || STACKS_DIR="$(ask_path 'Directory for your stacks' "${STACKS_DIR:-$DEFAULT_STACKS_DIR}")"
fi

INSTALL_DIR="${INSTALL_DIR%/}"
check_abs "$INSTALL_DIR" || die "The install directory has to be an absolute path without spaces or a colon: $INSTALL_DIR"
[ -n "$STACKS_DIR" ] || STACKS_DIR="$DEFAULT_STACKS_DIR"
STACKS_DIR="${STACKS_DIR%/}"
check_abs "$STACKS_DIR" || die "The stacks directory has to be an absolute path without spaces or a colon: $STACKS_DIR"
[ -n "$DATA_DIR" ] || DATA_DIR="$INSTALL_DIR/data"
DATA_DIR="${DATA_DIR%/}"
check_abs "$DATA_DIR" || die "The data directory has to be an absolute path without spaces or a colon: $DATA_DIR"

[ -n "$PORT" ] || PORT="$(ask 'Web port for the panel' "$DEFAULT_PORT")"
PORT="$(choose_port "$PORT")"

# Nothing has been written yet, so every answer can still be taken back. After
# this block the script starts changing the machine
review() {
    local choice
    while :; do
        printf '\n' >&2
        info "1. Install directory: $INSTALL_DIR"
        info "2. Stacks:            $STACKS_DIR"
        info "3. Data:              $DATA_DIR"
        info "4. Port:              $PORT"
        if [ "$EXISTING" = "1" ]; then
            info "   Mode:              rebuild the installation already in that directory"
        fi
        if [ "$INTERACTIVE" = "0" ]; then
            return 0
        fi
        if [ "$EXISTING" = "1" ]; then
            # The paths belong to a running installation: changing them here
            # would leave the containers and the volumes behind
            choice="$(ask_raw 'Enter to continue, 4 to change the port, q to quit')"
        else
            choice="$(ask_raw 'Enter to continue, a number to change it, q to quit')"
        fi
        case "$choice" in
            '') return 0 ;;
            q|Q) die "Nothing was changed." ;;
            1) if [ "$EXISTING" = "1" ]; then
                   warn "An existing installation cannot be moved from here. Install a second one with --dir instead."
               else
                   INSTALL_DIR="$(ask_path 'Install directory' "$INSTALL_DIR")"
                   [ "$DATA_SET" = "1" ] || DATA_DIR="$INSTALL_DIR/data"
               fi ;;
            2) if [ "$EXISTING" = "1" ]; then
                   warn "Moving the stacks directory would leave your stacks at the old path. Change DOCKGE_STACKS_DIR in $INSTALL_DIR/.env deliberately instead."
               else
                   STACKS_DIR="$(ask_path 'Directory for your stacks' "$STACKS_DIR")"
                   STACKS_SET=1
               fi ;;
            3) if [ "$EXISTING" = "1" ]; then
                   warn "Moving the data directory here would start the panel with an empty database. Copy the old directory first, then change DOCKGE_DATA_DIR in $INSTALL_DIR/.env deliberately."
               else
                   DATA_DIR="$(ask_path 'Data directory' "$DATA_DIR")"
                   DATA_SET=1
               fi ;;
            4) PORT="$(choose_port "$(ask 'Web port for the panel' "$PORT")")"; PORT_SET=1 ;;
            *) warn "Not one of the numbers above." ;;
        esac
    done
}
review

########################################
# 3. The files
########################################
say "Getting the source"

# Writing under /opt needs root, writing under a home directory does not, and a
# password prompt that changes nothing is its own kind of failure
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
    # git refuses a repository owned by somebody else, and its own message does
    # not say what to do about it here
    $FSUDO git -C "$INSTALL_DIR" rev-parse --git-dir >/dev/null 2>&1 \
        || die "git will not read $INSTALL_DIR (it is probably owned by another user). Allow it with: ${FSUDO:+$FSUDO }git config --global --add safe.directory $INSTALL_DIR"

    # A checkout standing on a commit rather than a branch is what the rollback
    # hint leaves behind. Fast-forwarding it would move HEAD and print a branch
    # name that is not true, so the user is asked to step back onto the branch first
    CURRENT_REF="$($FSUDO git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ "$CURRENT_REF" = "HEAD" ] || [ -z "$CURRENT_REF" ]; then
        die "$INSTALL_DIR is checked out at a commit, not a branch (after a rollback, probably). Return to the branch with: ${FSUDO:+$FSUDO }git -C $INSTALL_DIR checkout ${BRANCH:-$DEFAULT_BRANCH} - then run this again. Nothing was changed."
    fi
    if [ "$BRANCH_SET" = "0" ]; then
        BRANCH="$CURRENT_REF"
    fi

    # An unfinished local edit is somebody's work, and a rebuild is not a reason
    # to lose it. The installer never resets, stashes or overwrites it. Untracked
    # files are nobody's business here: .env is one of them
    if [ -n "$($FSUDO git -C "$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        warn "There are uncommitted changes in $INSTALL_DIR:"
        $FSUDO git -C "$INSTALL_DIR" status --short >&2
        info "They are left exactly as they are; the update below can only fast-forward."
        confirm "Continue?" || die "Nothing was changed."
    fi

    ROLLBACK_COMMIT="$($FSUDO git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    info "Fetching origin/$BRANCH."
    $FSUDO git -C "$INSTALL_DIR" fetch --prune origin \
        || die "Could not reach $REPO_URL. Check the network and run this again; nothing was changed."
    if ! $FSUDO git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" 2>/dev/null; then
        die "$INSTALL_DIR cannot be fast-forwarded to origin/$BRANCH: it has local commits, or it is on a branch that has diverged. Resolve it by hand (git -C $INSTALL_DIR status) and run this again. Nothing was changed."
    fi
    info "Now at $($FSUDO git -C "$INSTALL_DIR" rev-parse --short HEAD) on $BRANCH."
else
    # --update on something that was never installed would quietly become a
    # second installation, on the same port as the first one
    if [ "$DO_UPDATE" = "1" ]; then
        die "--update was asked for, but $INSTALL_DIR is not a dockge2 checkout. Run the installer from the directory of your installation, name it with --dir, or drop --update to install a new one."
    fi
    [ "$BRANCH_SET" = "1" ] || BRANCH="$DEFAULT_BRANCH"
    if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        die "$INSTALL_DIR exists and is not empty, and it is not a checkout. Install somewhere else with --dir, or empty it first."
    fi
    [ -d "$INSTALL_DIR" ] && CLEANUP_KEEP_DIR=1
    $FSUDO mkdir -p "$INSTALL_DIR"
    CLEANUP_DIR="$INSTALL_DIR"
    $FSUDO git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
        || die "Could not clone $REPO_URL (branch $BRANCH). Check the network and the branch name."
    CLEANUP_DIR=""
fi

[ -f "$INSTALL_DIR/docker-compose.yml" ] || die "$INSTALL_DIR has no docker-compose.yml: this is not a dockge2 checkout."

$FSUDO mkdir -p "$STACKS_DIR" "$DATA_DIR"

ENV_FILE="$INSTALL_DIR/.env"

# docker compose reads .env as whoever runs it. A root-owned 0600 file would be
# skipped without a word and every value would fall back to the defaults in
# docker-compose.yml - a different port, a different stacks directory, no warning.
# The same file is edited below, so the owner is fixed first, not last
own_env() {
    chmod 600 "$ENV_FILE" 2>/dev/null || $SUDO chmod 600 "$ENV_FILE" 2>/dev/null || true
    if [ ! -r "$ENV_FILE" ] || [ ! -w "$ENV_FILE" ]; then
        $SUDO chown "$(id -u):$(id -g)" "$ENV_FILE" 2>/dev/null || true
    fi
    [ -r "$ENV_FILE" ] && [ -w "$ENV_FILE" ] \
        || die "$ENV_FILE cannot be read by $(id -un), and docker compose would silently ignore it. Fix its owner, or run the installer as root."
}

set_env_var() {
    # set_env_var <key> <value>: replace the line or append it, with no regard
    # for what the value contains. own_env has run, so the file is ours
    local key="$1" value="$2" tmp
    tmp="$(mktemp)"
    KEY="$key" VALUE="$value" awk '
        BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; written = 0 }
        index($0, k "=") == 1 { if (!written) { print k "=" v; written = 1 } next }
        { print }
        END { if (!written) print k "=" v }
    ' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
}

if [ -f "$ENV_FILE" ]; then
    own_env
    info ".env is already there and keeps every setting the installer was not told to change."
    # An option given on the command line is an instruction, not a suggestion:
    # printing an address the panel does not answer on would be worse than editing
    if [ "$PORT_SET" = "1" ] && [ "$(read_env DOCKGE_PORT)" != "$PORT" ]; then
        set_env_var DOCKGE_PORT "$PORT"
        info "DOCKGE_PORT is now $PORT."
    fi
    if [ "$STACKS_SET" = "1" ] && [ "$(read_env DOCKGE_STACKS_DIR)" != "$STACKS_DIR" ]; then
        set_env_var DOCKGE_STACKS_DIR "$STACKS_DIR"
        warn "DOCKGE_STACKS_DIR is now $STACKS_DIR. Stacks created earlier stay where they were; move them yourself if you want them back in the list."
    fi
    if [ "$DATA_SET" = "1" ] && [ "$(read_env DOCKGE_DATA_DIR)" != "$DATA_DIR" ]; then
        set_env_var DOCKGE_DATA_DIR "$DATA_DIR"
        warn "DOCKGE_DATA_DIR is now $DATA_DIR. The database and the settings of the old directory are not moved: copy them over before the panel starts, or you get an empty installation."
    fi
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
    own_env
    info "Wrote $ENV_FILE"
fi

cd "$INSTALL_DIR"
$DOCKER compose -f docker-compose.yml config --quiet \
    || die "docker-compose.yml plus .env do not form a valid configuration. Nothing was started; the message above says which value is wrong."

########################################
# 4. Get the image and start
########################################

# One fixed tag means the running image loses its only name during a rebuild.
# Naming it first is what makes going back possible at all
IMAGE_TAG="$(read_env DOCKGE_IMAGE)"
[ -n "$IMAGE_TAG" ] || IMAGE_TAG="dockge2:latest"
if $DOCKER image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    ROLLBACK_IMAGE="dockge2:rollback-$(date +%Y%m%d-%H%M%S)"
    $DOCKER tag "$IMAGE_TAG" "$ROLLBACK_IMAGE" >/dev/null 2>&1 || ROLLBACK_IMAGE=""
    [ -n "$ROLLBACK_IMAGE" ] && info "The image running now is kept as $ROLLBACK_IMAGE."
fi

how_to_go_back() {
    [ -n "$ROLLBACK_IMAGE" ] || [ -n "$ROLLBACK_COMMIT" ] || return 0
    info ""
    info "Back to what was running before:"
    [ -n "$ROLLBACK_COMMIT" ] && info "    git -C $INSTALL_DIR checkout $ROLLBACK_COMMIT"
    [ -n "$ROLLBACK_IMAGE" ] && info "    DOCKGE_IMAGE=$ROLLBACK_IMAGE docker compose -f $INSTALL_DIR/docker-compose.yml up -d"
    return 0
}

# Building is the expensive half of an install, and the cost is memory: the
# frontend bundler keeps the whole module graph in native memory and peaks near
# a gigabyte. It does not fit itself into a smaller machine - it gets killed
# there, silently, and the install ends with a container that never appears.
# Running the panel afterwards takes about 170 MB. So a published image is
# downloaded when there is one, and built only when there is not
enough_memory_to_build() {
    local total_kb swap_kb total_mb
    [ -r /proc/meminfo ] || return 0
    total_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)"
    swap_kb="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)"
    total_mb=$(( (total_kb + swap_kb) / 1024 ))
    [ "$total_mb" -ge 1200 ] && return 0
    warn "Building needs about 1 GB, and this machine has $total_mb MB of memory and swap together."
    info "  - the usual way out is a published image, which is downloaded instead of built"
    info "  - or give the machine swap for the build:"
    info "      ${SUDO:+$SUDO }fallocate -l 1G /swapfile && ${SUDO:+$SUDO }chmod 600 /swapfile"
    info "      ${SUDO:+$SUDO }mkswap /swapfile && ${SUDO:+$SUDO }swapon /swapfile"
    confirm "Build anyway?" || return 1
    return 0
}

FROM_REGISTRY=0
if [ "$BUILD_FROM_SOURCE" = "0" ]; then
    CANDIDATE="${IMAGE_REF:-$IMAGE_REPO:$IMAGE_CHANNEL}"
    say "Looking for a published image"
    info "$CANDIDATE"
    if $DOCKER pull "$CANDIDATE" >/dev/null 2>&1; then
        set_env_var DOCKGE_IMAGE "$CANDIDATE"
        IMAGE_TAG="$CANDIDATE"
        FROM_REGISTRY=1
        info "Downloaded. Nothing is built on this machine."
    elif [ -n "$IMAGE_REF" ]; then
        die "$CANDIDATE cannot be downloaded. Check the name, or leave out --image to build from the sources."
    else
        info "There is none to download, so the image is built here instead."
        info "A published image would have made this step unnecessary; --build always skips the search."
    fi
fi

if [ "$FROM_REGISTRY" = "0" ]; then
    # What is built here is built under the local name, whatever a previous run
    # from a registry left in .env
    if [ -n "$(read_env DOCKGE_IMAGE)" ] && [ "$(read_env DOCKGE_IMAGE)" != "dockge2:latest" ]; then
        set_env_var DOCKGE_IMAGE "dockge2:latest"
        IMAGE_TAG="dockge2:latest"
        info "DOCKGE_IMAGE is now dockge2:latest: this run builds the image instead of downloading it."
    fi

    enough_memory_to_build || die "Nothing was built, and what runs now, if anything, is untouched."

    say "Building the image (a few minutes on a small server)"
    if ! $DOCKER compose -f docker-compose.yml build; then
        warn "The build failed. The usual reasons, in order:"
        info "  - not enough memory: the frontend bundler needs about 1 GB and is killed without a message"
        info "  - no space left on $DOCKER_ROOT (df -h $DOCKER_ROOT)"
        info "  - Docker Hub refused node:24.19.0-bookworm-slim or golang:1.27.0-bookworm: rate limit, or no network"
        info "  - a package mirror was unreachable during apt or npm"
        how_to_go_back
        die "The image was not built. What runs now, if anything, is untouched."
    fi
fi

say "Starting the panel"
if ! $DOCKER compose -f docker-compose.yml up -d "${WAIT_ARGS[@]}"; then
    STATE="$($DOCKER compose -f docker-compose.yml ps --format '{{.Name}} {{.State}} {{.Status}}' 2>/dev/null || true)"
    if [ -n "$STATE" ]; then
        warn "The container exists but did not report itself healthy in time:"
        info "$STATE"
    else
        warn "The container did not start at all."
    fi
    info "Last 40 log lines:"
    $DOCKER compose -f docker-compose.yml logs --tail 40 2>&1 | sed 's/^/    /' >&2 || true
    info ""
    info "It may also simply be slow: the health check starts after 60 seconds and repeats every 60."
    info "Watch it with: docker compose -f $INSTALL_DIR/docker-compose.yml ps"
    how_to_go_back
    die "Dockge2 did not come up. Nothing was removed, so fixing the cause and running this again continues from here."
fi

# One previous image is a way back; a row of them from every update is a full
# disk on a small server. Only tags this installer made are touched, and only
# the newest one stays. Removing a tag never removes an image a container uses
if [ -n "$ROLLBACK_IMAGE" ]; then
    $DOCKER image ls --format '{{.Repository}}:{{.Tag}}' dockge2 2>/dev/null \
        | grep '^dockge2:rollback-' | grep -vx "$ROLLBACK_IMAGE" \
        | while IFS= read -r old_tag; do
            if $DOCKER image rm "$old_tag" >/dev/null 2>&1; then
                info "Older rollback tag removed: $old_tag."
            fi
        done || true
fi

########################################
# 5. Where it is
########################################

# The truth about the port is what the daemon actually published, not what the
# installer asked for
PUBLISHED="$($DOCKER compose -f docker-compose.yml ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | sed -n 's/.*:\([0-9]\{1,5\}\)->.*/\1/p' | head -1 || true)"
if [ -n "$PUBLISHED" ] && [ "$PUBLISHED" != "$PORT" ]; then
    warn "The panel answers on port $PUBLISHED, not on $PORT: $ENV_FILE says something else than this run did."
    PORT="$PUBLISHED"
fi

LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' | head -1)"
[ -z "$LOCAL_IP" ] && LOCAL_IP="127.0.0.1"

say "Dockge2 is running"
info "On this machine: http://127.0.0.1:$PORT"
info "On the network:  http://$LOCAL_IP:$PORT"

# A closed firewall is the usual reason a fresh VPS shows nothing on that link.
# Reading its state needs root, and asking for a password just to warn is not worth it
if [ -z "$SUDO" ] || $SUDO -n true 2>/dev/null; then
    if command -v ufw >/dev/null 2>&1 \
        && $SUDO ufw status 2>/dev/null | grep -q '^Status: active' \
        && ! $SUDO ufw status 2>/dev/null | grep -qw "$PORT"; then
        warn "ufw is active and port $PORT is not allowed: ${SUDO:+$SUDO }ufw allow $PORT/tcp"
    fi
    if command -v firewall-cmd >/dev/null 2>&1 \
        && $SUDO firewall-cmd --state 2>/dev/null | grep -q running \
        && ! $SUDO firewall-cmd --list-ports 2>/dev/null | grep -qw "$PORT/tcp"; then
        warn "firewalld is running and port $PORT is not open: ${SUDO:+$SUDO }firewall-cmd --add-port=$PORT/tcp --permanent && ${SUDO:+$SUDO }firewall-cmd --reload"
    fi
fi
info "On a cloud server the provider's own firewall is separate from the one above; port $PORT has to be open there too."

# The token file is 0600 and owned by root, so it is read from inside the
# container rather than from the host, where the installer may be an ordinary user
say "Setup code for the first sign-in"
TOKEN="$($DOCKER compose -f docker-compose.yml exec -T dockge cat /app/data/bootstrap-token 2>/dev/null | tr -d '\r\n')"
if [ -n "$TOKEN" ]; then
    info "$TOKEN"
    info "It works once. The first visit asks for it together with the owner account."
else
    warn "No setup code: this installation already has an owner, or DOCKGE_BOOTSTRAP_TOKEN is set."
fi

cat >&2 <<NEXT

  Open the panel over a private network or an SSH tunnel, or put a reverse proxy
  with HTTPS in front of it before exposing it to the internet - see the README.

  Update later:   $INSTALL_DIR/install.sh --update
  Stop:           docker compose -f $INSTALL_DIR/docker-compose.yml down
NEXT
if [ -n "$ROLLBACK_IMAGE" ]; then
    printf '  Previous image: %s (kept until the next update makes a newer one)\n\n' "$ROLLBACK_IMAGE" >&2
fi
