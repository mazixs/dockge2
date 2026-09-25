#!/usr/bin/env bash
# All local tests use temporary files and runners; no Docker daemon is mutated.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
(cd extra/updater && go test -race -count=1 ./...)
go test extra/healthcheck.go extra/healthcheck_test.go
node --test test/install/release.test.mjs test/install/bootstrap.test.mjs test/install/privacy.test.mjs
for script in install.sh extra/update-dockge.sh extra/release-only.sh extra/release/verifier.sh test/install/docker.sh test/install/managed.sh test/install/unmanaged.sh; do bash -n "$script"; done
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# Forwarding of --update to the installed updater is covered by bootstrap.test.mjs
mkdir -p "$work/bin"
if bash install.sh --branch main > "$work/error" 2>&1; then echo 'Legacy branch path was accepted' >&2; exit 1; fi
# A counterfeit verifier must never execute. Docker/Git are not called.
cat > "$work/bin/curl" <<'SH'
#!/bin/bash
while (($#)); do if [[ "$1" == -o ]]; then printf '#!/bin/sh\ntouch "$EXECUTED"\n' > "$2"; exit 0; fi; shift; done
exit 1
SH
cat > "$work/bin/docker" <<'SH'
#!/bin/sh
echo 'Docker must not run before signature validation' >&2
exit 90
SH
chmod +x "$work/bin/"*
if EXECUTED="$work/executed" PATH="$work/bin:$PATH" bash install.sh --dir "$work/new" --version 1.2.3 --yes > "$work/error" 2>&1; then echo 'Bad verifier checksum accepted' >&2; exit 1; fi
test ! -e "$work/executed"
test ! -e "$work/new"
grep -q 'Cosign checksum mismatch' "$work/error"
echo 'Bootstrap and shared updater checks passed.'
