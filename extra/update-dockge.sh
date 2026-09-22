#!/usr/bin/env bash
# npm is only an optional entry point. The updater itself has no Node dependency.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/install.sh" --update --dir "$PWD" "$@"
