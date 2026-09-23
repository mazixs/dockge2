#!/usr/bin/env bash
# Import the released 0.0.10 image when an older checkout updated it without updater state.
set -euo pipefail
[[ "${CI:-}" == true && -n "${RUNNER_TEMP:-}" ]] || { echo 'Run this gate on an isolated CI runner' >&2; exit 1; }
if [[ "$EUID" != 0 ]]; then exec sudo --preserve-env=CI,RUNNER_TEMP,DOCKER_DEFAULT_PLATFORM,PATH bash "$0" "$@"; fi
assets=$(realpath "$1")
arch=$2
verifier=$(realpath "$3")
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "$RUNNER_TEMP/dockge-unmanaged-$arch-XXXXXX")
project="dgunmanaged-$arch-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
deployment="$work/installation"
image=$(jq -er '.image+"@"+.digest' "$assets/release.json")
old_digest=sha256:edf9bd51346f47c9c89d65b6bbe9c1da3d2d028dbcb45109dfc895164871d71b
old_image="ghcr.io/mazixs/dockge2@$old_digest"
cleanup() {
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null
}
trap cleanup EXIT
mkdir -p "$deployment" "$work/stacks" "$work/data"
mkdir "$work/prior"
gh release download v0.0.10 --dir "$work/prior" --pattern release.json >/dev/null
jq -e --slurpfile old "$work/prior/release.json" '.legacy["0.0.10"].schema == $old[0].schema and $old[0].digest == "sha256:edf9bd51346f47c9c89d65b6bbe9c1da3d2d028dbcb45109dfc895164871d71b" and $old[0].commit == "f6bdbfb2f907fd78ba3737edd836f5b5c1e2d822"' "$assets/release.json" >/dev/null
git -C "$root" show v0.0.10:docker-compose.yml > "$deployment/docker-compose.yml"
test "$(sha256sum "$deployment/docker-compose.yml" | cut -d' ' -f1)" = "$(jq -er '.legacy["0.0.10"].composeHash' "$assets/release.json")"
docker pull --platform "linux/$arch" "$old_image"
old_id=$(docker image inspect "$old_image" --format '{{.Id}}')
docker image inspect "$old_id" --format '{{json .RepoDigests}}' | jq -e --arg ref "$old_image" 'index($ref) != null' >/dev/null
printf 'services:\n  dockge:\n    image: %s\n' "$old_id" > "$work/baseline.yml"
port=$((41000 + RANDOM % 10000))
cat > "$deployment/.env" <<ENV
DOCKGE_IMAGE=ghcr.io/mazixs/dockge2:latest
DOCKGE_DATA_DIR=$work/data
DOCKGE_STACKS_DIR=$work/stacks
DOCKGE_PORT=$port
DOCKGE_ENABLE_CONSOLE=false
ENV
config=(docker compose --project-directory "$deployment" -p "$project" --env-file "$deployment/.env" -f "$deployment/docker-compose.yml")
"${config[@]}" -f "$work/baseline.yml" up -d --no-build --pull never --wait --wait-timeout 180
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');db.prepare('INSERT OR REPLACE INTO setting(key,value,type) VALUES (?,?,?)').run('upgradeMarker','before','general');db.close()"
node "$root/test/install/account.mjs" bootstrap "$work/data" "$port"
test ! -e "$deployment/.dockge2/active.json"
update=("$assets/dockge2-update-linux-$arch" --dir "$deployment" --update --project "$project" --version "$(jq -er .version "$assets/release.json")" --release-dir "$assets" --verifier "$verifier")
"${update[@]}" --dry-run
"${update[@]}" --yes
node "$root/test/install/account.mjs" login "$work/data" "$port"
test "$(jq -er .mode "$deployment/.dockge2/active.json")" = release
test "$(jq -er .previous.mode "$deployment/.dockge2/operation.json")" = legacy
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');db.prepare('UPDATE setting SET value=? WHERE key=?').run('after','upgradeMarker');db.close()"
"$deployment/.dockge2/update" --rollback --restore-data --yes
node "$root/test/install/account.mjs" login "$work/data" "$port"
container=$(docker ps -q --filter "label=com.docker.compose.project=$project")
test "$(docker inspect "$container" --format '{{.Image}}')" = "$old_id"
docker exec "$container" node -e "const DB=require('better-sqlite3');const db=new DB('/app/data/dockge.db');if(db.prepare('SELECT value FROM setting WHERE key=?').get('upgradeMarker').value!=='before')process.exit(1);if(db.pragma('integrity_check')[0].integrity_check!=='ok')process.exit(2);db.close()"
echo "Verified $arch: published unmanaged 0.0.10 import, owner login, digest identity and data rollback."
cleanup
trap - EXIT
docker image rm "$image" "$old_image"
