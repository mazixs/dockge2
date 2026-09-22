#!/usr/bin/env bash
set -euo pipefail
echo 'Publishing is performed only by .github/workflows/release.yml for a v* tag.' >&2
echo 'Set package.json/package-lock.json to the version, commit, and push that reviewed tag.' >&2
echo 'For a prerelease use vX.Y.Z-rc.N. Local image builds must omit --push.' >&2
exit 1
