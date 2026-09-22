#!/usr/bin/env bash
# Real release gate: isolated projects only, never a developer's existing data.
set -euo pipefail
[[ "${CI:-}" == true && -n "${RUNNER_TEMP:-}" ]] || { echo 'Run this gate on an isolated CI runner' >&2; exit 1; }
if [[ "$EUID" != 0 ]]; then exec sudo --preserve-env=CI,RUNNER_TEMP,DOCKER_DEFAULT_PLATFORM,PATH bash "$0" "$@"; fi
assets=$(realpath "$1")
arch=$2
verifier=$(realpath "$3")
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "$RUNNER_TEMP/dockge-upgrade-$arch-XXXXXX")
project="dgupd-${arch}-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
version=$(jq -er .version "$assets/release.json")
image=$(jq -er '.image+"@"+.digest' "$assets/release.json")
binary="$assets/dockge2-update-linux-$arch"
deployment="$work/installation"
mkdir -p "$deployment" "$work/stacks/example" "$work/anonymous"
cleanup() {
    # Only containers created for this fixture are selected; no global prune.
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null
    docker ps -aq --filter "label=com.docker.compose.project=$project-fresh" | xargs -r docker rm -f >/dev/null
    docker rm -f "$project-unrelated" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Clearing client credentials proves the artifact is accessible to a fresh host.
docker --config "$work/anonymous" pull --platform "linux/$arch" "$image"
# Fresh installation uses no checkout and no files from main.
mkdir -p "$work/fresh"
"$binary" --dir "$work/fresh" --project "$project-fresh" --data-dir "$work/fresh-data" --stacks-dir "$work/fresh-stacks" --port 39871 --version "$version" --release-dir "$assets" --verifier "$verifier" --yes
node "$root/test/install/account.mjs" bootstrap "$work/fresh-data" 39871
docker ps -aq --filter "label=com.docker.compose.project=$project-fresh" | xargs -r docker rm -f >/dev/null
docker pull --platform "linux/$arch" ghcr.io/mazixs/dockge2:0.0.8
legacy=$(docker image inspect ghcr.io/mazixs/dockge2:0.0.8 --format '{{.Id}}')
git -C "$root" show v0.0.8:docker-compose.yml > "$deployment/docker-compose.yml"
printf 'services:\n  dockge:\n    image: %s\n' "$legacy" > "$work/baseline.yml"
port=$((41000 + RANDOM % 10000))
cat > "$deployment/.env" <<ENV
DOCKGE_IMAGE=ghcr.io/mazixs/dockge2:latest
DOCKGE_DATA_DIR=$work/data
DOCKGE_STACKS_DIR=$work/stacks
DOCKGE_PORT=$port
DOCKGE_ENABLE_CONSOLE=false
ENV
printf '# untouched user stack\nservices: {}\n' > "$work/stacks/example/compose.yaml"
printf 'local work must survive\n' > "$deployment/local-notes.txt"
(cd "$deployment" && git init -q && git add docker-compose.yml && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm baseline)
printf '\n# dirty fixture\n' >> "$deployment/local-notes.txt"
config=(docker compose --project-directory "$deployment" -p "$project" --env-file "$deployment/.env" -f "$deployment/docker-compose.yml")
"${config[@]}" -f "$work/baseline.yml" up -d --no-build --pull never --wait --wait-timeout 180
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');db.prepare('INSERT OR REPLACE INTO setting(key,value,type) VALUES (?,?,?)').run('upgradeMarker','before','general');db.close()"
node "$root/test/install/account.mjs" bootstrap "$work/data" "$port"
docker run -d --name "$project-unrelated" --entrypoint sleep "$image" 1800
sha256sum "$deployment/.env" "$deployment/local-notes.txt" "$work/stacks/example/compose.yaml" > "$work/unchanged.sha256"
# Every invocation uses exactly the signed release bundle, regardless of the dirty checkout.
update=("$binary" --dir "$deployment" --update --project "$project" --version "$version" --release-dir "$assets" --verifier "$verifier" --image ghcr.io/mazixs/dockge2:latest)
"${update[@]}" --dry-run
"${update[@]}" --yes
node "$root/test/install/account.mjs" login "$work/data" "$port"
previous=$(sha256sum "$deployment/.dockge2/previous.json")
"${update[@]}" --yes
test "$(sha256sum "$deployment/.dockge2/previous.json")" = "$previous"
sha256sum --check "$work/unchanged.sha256"
test "$(docker inspect "$project-unrelated" --format '{{.State.Running}}')" = true
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');db.prepare('UPDATE setting SET value=? WHERE key=?').run('after','upgradeMarker');db.close()"
# Exercise explicit restoration even when this release happens to share the schema.
"$deployment/.dockge2/update" --rollback --restore-data --yes
node "$root/test/install/account.mjs" login "$work/data" "$port"
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
test "$(docker inspect "$container" --format '{{.Image}}')" = "$legacy"
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');if(db.prepare('SELECT value FROM setting WHERE key=?').get('upgradeMarker').value!=='before')process.exit(1);if(db.pragma('integrity_check')[0].integrity_check!=='ok')process.exit(2);db.close()"
sha256sum --check "$work/unchanged.sha256"
# A bad signer must fail even if all hashes in release.json still match.
if "$verifier" verify-blob --bundle "$assets/release.json.sigstore.json" --certificate-identity 'https://github.com/other/project/.github/workflows/release.yml@refs/tags/v1.0.0' --certificate-oidc-issuer https://token.actions.githubusercontent.com "$assets/release.json"; then
    echo 'Wrong signer accepted' >&2; exit 1
fi
echo "Verified $arch: legacy import, exact artifact readiness, owner login, no-op, explicit data restore and unrelated stack preservation."
