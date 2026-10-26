#!/usr/bin/env bash
# Checks the package as npm would ship it: publint on `package.json` and the
# packed files, and arethetypeswrong on how each entry point's types resolve.
# Run after `pnpm build`.
#
# `.` must resolve under every resolution attw knows. `./node` is exported
# only under the `node` condition, which node10 and TypeScript's `bundler`
# resolution do not set, so it must resolve under node16 only.
#
# Usage:  scripts/check-package.sh
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f dist/index.js && -f dist/node.js ]] || die "no dist/: run \`pnpm build\` first"

echo "==> publint"
pnpm exec publint --strict

echo "==> attw: ."
pnpm exec attw --pack . --exclude-entrypoints ./node

echo "==> attw: ./node (node16)"
# attw exits non-zero on any problem; the JSON is what decides. Output that is
# not attw's JSON fails jq, and so the script.
problems=$({ pnpm exec attw --pack . --entrypoints ./node --format json || true; } |
  jq -c '[.analysis.problems[] | select(.resolutionKind | IN("node10", "bundler") | not)]')
if [[ "$problems" != "[]" ]]; then
  pnpm exec attw --pack . --entrypoints ./node --profile node16 || true
  die "./node does not resolve under node16: $problems"
fi
echo "./node resolves under node16 (ESM and CJS)"
