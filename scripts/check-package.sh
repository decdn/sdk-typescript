#!/usr/bin/env bash
# Checks the package as npm would ship it: publint on `package.json` and the
# packed files, and arethetypeswrong on how the entry point's types resolve
# under every resolution attw knows. Run after `pnpm build`.
#
# Usage:  scripts/check-package.sh
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f dist/index.js ]] || die "no dist/: run \`pnpm build\` first"

echo "==> publint"
pnpm exec publint --strict

echo "==> attw"
pnpm exec attw --pack .
