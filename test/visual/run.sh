#!/usr/bin/env bash
# The references are taken in the Playwright image, the same one CI uses: a browser on the
# host rasterises text a few pixels apart and fills the glyphs the panel's fonts lack from
# its own fallback fonts. The tag follows @playwright/test in package.json, and
# test/backend/playwright-image.test.ts keeps this file, ci.yml and package.json in step.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"

cd "$(dirname "$0")/../.."

# CI=1 gives one worker, as in CI: parallel shots share the machine and drift in timing
exec docker run --rm --init --ipc=host \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 \
    -v "$PWD:/work" -w /work \
    "$IMAGE" npx playwright test --config playwright-visual.config.ts "$@"
