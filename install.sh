#!/usr/bin/env bash
# Released bootstrap: authenticate the host updater before executing it.
# Trust root: this reviewed bootstrap, GitHub HTTPS, and the pinned Cosign binary.
set -euo pipefail
umask 077

usage() {
    cat <<'HELP'
Dockge2 verified release installer (Linux amd64/arm64)

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
# An installed updater has a durable verifier and works without fetching a script.
if ! $force_bootstrap && [[ -x "$directory/.dockge2/update" ]]; then
    exec "$directory/.dockge2/update" "${args[@]}"
fi
for command in curl sha256sum docker; do
    command -v "$command" >/dev/null || { echo "Required command: $command" >&2; exit 1; }
done
[[ "$(uname -s)" == Linux ]] || { echo "Linux is required" >&2; exit 1; }
case "$(uname -m)" in
    x86_64) arch=amd64; cosign_hash=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
    aarch64|arm64) arch=arm64; cosign_hash=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
    *) echo "Only Linux amd64/arm64 is supported" >&2; exit 1 ;;
esac
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 15 --max-time 180 --retry 2 "$@"; }
if [[ -z "$version" ]]; then
    resolved="$(fetch -o /dev/null -w '%{url_effective}' https://github.com/mazixs/dockge2/releases/latest)"
    [[ "$resolved" == https://github.com/mazixs/dockge2/releases/tag/v* ]] || { echo "No stable release is available" >&2; exit 1; }
    version="${resolved##*/v}"
fi
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || { echo "Invalid release version" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
fetch "https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-$arch" -o "$work/cosign"
printf '%s  %s\n' "$cosign_hash" "$work/cosign" | sha256sum --check --status || { echo "Cosign checksum mismatch" >&2; exit 1; }
chmod 700 "$work/cosign"
base="https://github.com/mazixs/dockge2/releases/download/v$version"
binary="dockge2-update-linux-$arch"
fetch "$base/$binary" -o "$work/$binary"
fetch "$base/$binary.sigstore.json" -o "$work/$binary.sigstore.json"
"$work/cosign" verify-blob --bundle "$work/$binary.sigstore.json" \
    --certificate-identity "https://github.com/mazixs/dockge2/.github/workflows/release.yml@refs/tags/v$version" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$work/$binary"
chmod 700 "$work/$binary"
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
