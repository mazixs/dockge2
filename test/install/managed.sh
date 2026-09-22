#!/usr/bin/env bash
# Exercise an already managed updater against a different real release.
set -euo pipefail
[[ "${CI:-}" == true && -n "${RUNNER_TEMP:-}" ]] || exit 1
if [[ "$EUID" != 0 ]]; then exec sudo --preserve-env=CI,RUNNER_TEMP,DOCKER_DEFAULT_PLATFORM,PATH bash "$0" "$@"; fi
assets=$(realpath "$1"); arch=$2; verifier=$(realpath "$3"); previous=$4
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "$RUNNER_TEMP/dockge-managed-$arch-XXXXXX")
project="dgmanaged-$arch-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
cleanup() {
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null
}
trap cleanup EXIT
mkdir "$work/previous" "$work/install"
for name in release.json release.json.sigstore.json docker-compose.yml install.sh "dockge2-update-linux-$arch"; do
    curl --proto '=https' --proto-redir '=https' -fsSL --max-time 180 "https://github.com/mazixs/dockge2/releases/download/$previous/$name" -o "$work/previous/$name"
done
# The current trusted binary verifies the previous release descriptor and every asset.
"$assets/dockge2-update-linux-$arch" --dir "$work/install" --project "$project" --port 39872 \
    --data-dir "$work/data" --stacks-dir "$work/stacks" --version "${previous#v}" \
    --release-dir "$work/previous" --verifier "$verifier" --yes
node "$root/test/install/account.mjs" bootstrap "$work/data" 39872
version=$(jq -er .version "$assets/release.json")
# This executes the previous release's installed binary, exercising updater self-upgrade.
"$work/install/.dockge2/update" --version "$version" --release-dir "$assets" --yes
node "$root/test/install/account.mjs" login "$work/data" 39872
"$work/install/.dockge2/update" --rollback --restore-data --yes
node "$root/test/install/account.mjs" login "$work/data" 39872
echo "Verified managed $previous -> v$version -> $previous on $arch."
# Drop only this fixture's image references before testing the next architecture.
# The classic Docker image store otherwise reuses/conflicts with the first platform.
cleanup
trap - EXIT
image=$(jq -er '.image+"@"+.digest' "$assets/release.json")
previous_image=$(jq -er '.image+"@"+.digest' "$work/previous/release.json")
docker image rm "$image" "$previous_image"
