#!/usr/bin/env bash
# Same pinned trust root as the released bootstrap; used only on CI runners.
set -euo pipefail
: "${RUNNER_TEMP:?Use this helper on an isolated CI runner}"
file="$RUNNER_TEMP/cosign"
curl --proto '=https' --proto-redir '=https' -fsSL --max-time 180 \
    https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64 -o "$file"
printf '%s  %s\n' 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 "$file" | sha256sum --check --status
chmod 700 "$file"
echo "$RUNNER_TEMP" >> "$GITHUB_PATH"
