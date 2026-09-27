#!/usr/bin/env bash
# Released bootstrap: authenticate the host updater before executing it.
# Trust root: this reviewed bootstrap, GitHub HTTPS, and the pinned Cosign binary.
# Piped into bash, a download cut short must run nothing: bash reads the whole block below
# before it runs any of it.
{
set -euo pipefail
umask 077

usage() {
    cat <<'HELP'
Dockge2 verified release installer (Linux amd64/arm64)

curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | sudo bash
bash install.sh [--dir /opt/dockge2] [--version X.Y.Z] [--yes]
bash install.sh --update --dir /existing/installation [--dry-run]
/existing/installation/.dockge2/update --rollback [--restore-data]

Requires Docker Engine >=24, Compose >=2.20, curl, sha256sum, and write access
on the Docker host. No Node, Git checkout, source build or package installation
is required for a release. Downloads never fall back to a build.

Options are passed to the verified updater: --image REPOSITORY:CHANNEL,
--compose-file FILE (legacy import), --compose-override FILE (repeatable),
--project NAME, --data-dir DIR, --stacks-dir DIR, --port PORT, --dry-run, --yes.
Explicit development builds require --development --ref REF and Git.
Use --bootstrap to fetch a new verified updater even if one is installed.
For offline rollback use the installed .dockge2/update executable.
HELP
}

version=""
directory=""
update=false
force_bootstrap=false
args=()
for arg in "$@"; do
    if [[ "$arg" == --bootstrap ]]; then force_bootstrap=true; else args+=("$arg"); fi
done
set -- "${args[@]}"
while (($#)); do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --version|--dir)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for $1" >&2; exit 2; }
            if [[ "$1" == --version ]]; then version="${2#v}"; else directory="$2"; fi
            shift 2 ;;
        --version=*) version="${1#*=}"; version="${version#v}"; shift ;;
        --dir=*) directory="${1#*=}"; shift ;;
        --update) update=true; shift ;;
        --rollback|--restore-data|--resume|--status|--dry-run|--yes|--development) shift ;;
        --image|--compose-file|--compose-override|--project|--data-dir|--stacks-dir|--port|--ref|--release-dir)
            [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }; shift 2 ;;
        --image=*|--compose-file=*|--compose-override=*|--project=*|--data-dir=*|--stacks-dir=*|--port=*|--ref=*|--release-dir=*) shift ;;
        *) echo "Unknown option: $1. Use --help; legacy branch/build fallback flags are not supported." >&2; exit 2 ;;
    esac
done
if [[ -z "$directory" ]]; then
    if $update; then directory="$PWD"; else directory=/opt/dockge2; fi
fi
valid_version() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; }
if [[ -n "$version" ]] && ! valid_version "$version"; then echo "Invalid release version: $version" >&2; exit 2; fi
# An installed updater has a durable verifier and works without fetching a script.
if ! $force_bootstrap && [[ -x "$directory/.dockge2/update" ]]; then
    exec "$directory/.dockge2/update" "${args[@]}"
fi

# Sections of "ok" lines on stdout, problems with their details on stderr. The updater
# continues in the same layout; colour is for a terminal without NO_COLOR only.
bold="" green="" red="" plain="" red_end=""
if [[ -z "${NO_COLOR:-}" && "${TERM:-}" != dumb ]]; then
    if [[ -t 1 ]]; then bold=$'\033[1m' green=$'\033[32m' plain=$'\033[0m'; fi
    if [[ -t 2 ]]; then red=$'\033[31m' red_end=$'\033[0m'; fi
fi
section() { printf '\n%s%s%s\n' "$bold" "$1" "$plain"; }
ok() { printf '  %s%-7s%s  %s\n' "$green" ok "$plain" "$1"; }
problem() {
    printf '  %s%-7s%s  %s\n' "$red" "$1" "$red_end" "$2" >&2
    shift 2
    hint "$@"
}
hint() {
    local line
    for line in "$@"; do printf '           %s\n' "$line" >&2; done
}
# details indents what a failed command printed, at most twenty lines of it.
details() {
    local line count=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        count=$((count + 1))
        ((count <= 20)) || break
        printf '           %s\n' "$line" >&2
    done < "$1"
}
stopped() { printf '\nStopped: nothing was installed or changed.\n' >&2; exit 1; }

printf '%sDockge2 installer%s\n' "$bold" "$plain"
section Host
unmet=0
os="$(uname -s)"
machine="$(uname -m)"
arch=""
if [[ "$os" == Linux ]]; then
    case "$machine" in
        x86_64) arch=amd64; cosign_hash=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
        aarch64|arm64) arch=arm64; cosign_hash=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
    esac
fi
if [[ -n "$arch" ]]; then
    ok "Linux $arch"
else
    problem failed "$os $machine" "Dockge2 runs on Linux amd64 or arm64."
    unmet=$((unmet + 1))
fi
# Docker itself is not run before the updater's signature is checked: here it only has to exist.
for command in curl sha256sum docker; do
    if command -v "$command" >/dev/null; then ok "$command"; continue; fi
    unmet=$((unmet + 1))
    case "$command" in
        curl) problem missing curl "Install it with the package manager, for example: apt install curl" ;;
        sha256sum) problem missing sha256sum "It comes with coreutils; install that package with the package manager." ;;
        docker) problem missing docker "Install Docker Engine 24 or newer with the Compose plugin, then run this again:" \
            https://docs.docker.com/engine/install/ ;;
    esac
done
if ((unmet)); then
    if ((unmet == 1)); then summary="1 requirement is not met"; else summary="$unmet requirements are not met"; fi
    printf '\nStopped: %s.\nNothing was downloaded or changed.\n' "$summary" >&2
    exit 1
fi

section Updater
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 15 --max-time 180 --retry 2 "$@"; }
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
if [[ -z "$version" ]]; then
    if ! resolved="$(fetch -o /dev/null -w '%{url_effective}' https://github.com/mazixs/dockge2/releases/latest 2>"$work/error")"; then
        problem failed "finding the latest release"
        details "$work/error"
        stopped
    fi
    if [[ "$resolved" != https://github.com/mazixs/dockge2/releases/tag/v* ]] || ! valid_version "${resolved##*/v}"; then
        problem failed "finding the latest release" "GitHub lists no stable release of Dockge2."
        stopped
    fi
    version="${resolved##*/v}"
    ok "latest release is $version"
fi
if ! fetch "https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-$arch" -o "$work/cosign" 2>"$work/error"; then
    problem failed "downloading Cosign 3.1.3"
    details "$work/error"
    stopped
fi
if ! printf '%s  %s\n' "$cosign_hash" "$work/cosign" | sha256sum --check --status; then
    problem failed "Cosign 3.1.3 checksum" "The download does not match the pinned checksum, so it was not run."
    stopped
fi
chmod 700 "$work/cosign"
ok "Cosign 3.1.3 matches its pinned checksum"
base="https://github.com/mazixs/dockge2/releases/download/v$version"
binary="dockge2-update-linux-$arch"
for file in "$binary" "$binary.sigstore.json"; do
    if ! fetch "$base/$file" -o "$work/$file" 2>"$work/error"; then
        problem failed "downloading the $version updater"
        details "$work/error"
        if [[ "$(<"$work/error")" == *" 404"* ]]; then
            hint "Check that release $version exists: https://github.com/mazixs/dockge2/releases"
        fi
        stopped
    fi
done
if ! "$work/cosign" verify-blob --bundle "$work/$binary.sigstore.json" \
    --certificate-identity "https://github.com/mazixs/dockge2/.github/workflows/release.yml@refs/tags/v$version" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$work/$binary" >"$work/error" 2>&1; then
    problem failed "signature of the $version updater"
    details "$work/error"
    hint "The updater was not run."
    stopped
fi
chmod 700 "$work/$binary"
ok "updater $version is signed by the v$version release workflow"
# Keep the verifier alive until the updater has finished its recovery after a signal.
# A service manager may signal this shell alone, not the entire process group.
child=""
interrupted=""
forward_signal() {
    interrupted="$1"
    if [[ -n "$child" ]]; then kill -s "$1" "$child" 2>/dev/null || true; fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
"$work/$binary" --dir "$directory" "${args[@]}" --verifier "$work/cosign" &
child=$!
if [[ -n "$interrupted" ]]; then forward_signal "$interrupted"; fi
status=0
# wait can itself be interrupted before the child finishes restoring the panel.
while true; do
    wait "$child" && status=0 || status=$?
    kill -0 "$child" 2>/dev/null || break
done
exit "$status"
}
