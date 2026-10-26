#!/usr/bin/env bash
# Checks the package as npm would ship it: publint on `package.json` and the
# packed files, and arethetypeswrong on how each entry point's types resolve.
# Run after `pnpm build`.
#
# `.` must resolve under every resolution attw knows. `./node` is exported
# under the `node` condition, with a type-only fallback for TypeScript's
# `bundler` resolution, which does not set `node`. It must resolve under
# node16 (ESM and CJS) and bundler; only node10, which does not read
# `exports`, is ignored.
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

echo "==> attw: ./node (node16, bundler)"
# attw exits non-zero on any problem; the JSON is what decides. Output that is
# not attw's JSON fails jq, and so the script.
problems=$({ pnpm exec attw --pack . --entrypoints ./node --format json || true; } |
  jq -c '[.analysis.problems[] | select(.resolutionKind != "node10")]')
if [[ "$problems" != "[]" ]]; then
  pnpm exec attw --pack . --entrypoints ./node || true
  die "./node does not resolve under node16 and bundler: $problems"
fi
echo "./node resolves under node16 (ESM and CJS) and bundler"
