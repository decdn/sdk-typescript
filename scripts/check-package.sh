#!/usr/bin/env bash
# Checks the package as npm would ship it: publint on `package.json` and the
# packed files, and arethetypeswrong on how each entry point's types resolve.
# Run after `pnpm build`.
#
# `.` must resolve under every resolution attw knows. `./node` has JavaScript
# only under the `node` condition, with a type-only fallback for TypeScript's
# `bundler` resolution, which does not set `node`. Its types must resolve to
# `dist/node.d.cts` under node16 from CJS and to `dist/node.d.ts` under node16
# from ESM and bundler; only node10, which does not read `exports`, is ignored.
#
# Usage:  scripts/check-package.sh
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f dist/index.js && -f dist/node.js ]] || die "no dist/: run \`pnpm build\` first"
command -v jq >/dev/null || die "jq is required"

echo "==> publint"
pnpm exec publint --strict

echo "==> attw: ."
pnpm exec attw --pack . --exclude-entrypoints ./node

echo "==> attw: ./node (node16, bundler)"
# attw exits 1 when it finds problems (node10's are expected) and above 1 when
# it cannot check the package; the JSON decides only in the first case. A
# resolution that is missing or lands on another file counts as a problem, so
# an attw that stops reporting one fails here rather than passing.
rc=0
json=$(pnpm exec attw --pack . --entrypoints ./node --format json) || rc=$?
((rc <= 1)) || die "attw could not check ./node (exit $rc)"
problems=$(jq -c '
  .analysis as $a
  | if ($a.problems | type) != "array" then error("no .analysis.problems") else . end
  | {"node16-cjs": "node.d.cts", "node16-esm": "node.d.ts", "bundler": "node.d.ts"}
  | [to_entries[]
      | .key as $kind
      | ("/dist/" + .value) as $want
      | ($a.entrypoints["./node"].resolutions[$kind].resolution.fileName // "nothing") as $got
      | select($got | endswith($want) | not)
      | "\($kind) types resolve to \($got), not \($want)"]
    + [$a.problems[] | select(.resolutionKind != "node10") | tojson]
' <<<"$json") || die "attw's JSON for ./node is not in the shape this script reads"
if [[ "$problems" != "[]" ]]; then
  pnpm exec attw --pack . --entrypoints ./node --profile node16 || true
  die "./node does not resolve under node16 or bundler: $problems"
fi
echo "./node resolves under node16 (ESM and CJS); its types resolve under bundler"
