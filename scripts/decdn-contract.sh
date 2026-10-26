#!/usr/bin/env bash
# Runs this repo's contract suite against a real `decdn gateway`, through
# decdn's own harness (`crates/e2e/tests/gateway_sdk.rs`), at a decdn release
# tag or at any decdn ref.
#
#   --tag vX.Y.Z  decdn at that signed release tag, with the release's own
#                 signed linux-x86_64 `decdn` and `decdn-node` binaries
#                 (verified against KEYS and SHA256SUMS). Only the harness
#                 test binary is compiled.
#   --ref REF     decdn at any branch, tag or commit, built from source: for
#                 a gateway that is not released yet.
#
# Usage:  scripts/decdn-contract.sh (--tag vX.Y.Z | --ref REF) [--decdn-dir DIR]
#
# DIR (default: a fresh temp dir) holds the decdn checkout; an existing
# checkout there is reused. Needs git, gpg, curl, cargo, cargo-nextest, anvil,
# forge and node on PATH, and this repo's dependencies installed
# (`pnpm install --frozen-lockfile --ignore-scripts`).
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
need_harness() {
  [[ -f "$DIR/crates/e2e/tests/gateway_sdk.rs" ]] ||
    die "decdn at $TARGET has no crates/e2e/tests/gateway_sdk.rs: the contract harness ships from v0.3.0"
}
usage() { die "usage: scripts/decdn-contract.sh (--tag vX.Y.Z | --ref REF) [--decdn-dir DIR]"; }

TAG=""
REF=""
DIR=""
while (( $# > 0 )); do
  case "$1" in
    --tag) (( $# >= 2 )) || usage; TAG="$2"; shift 2 ;;
    --ref) (( $# >= 2 )) || usage; REF="$2"; shift 2 ;;
    --decdn-dir) (( $# >= 2 )) || usage; DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done
if [[ -n "$TAG" && -n "$REF" ]] || [[ -z "$TAG" && -z "$REF" ]]; then
  die "pass exactly one of --tag or --ref"
fi
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'
if [[ -n "$TAG" && ! "$TAG" =~ ^v${SEMVER}$ ]]; then
  die "the tag must be v<major>.<minor>.<patch>[-<prerelease>], got '$TAG'"
fi
if [[ -n "$REF" && ( "$REF" == -* || -z "${REF// /}" ) ]]; then
  die "not a git ref: '$REF'"
fi

# ---- preconditions -------------------------------------------------------

for tool in git cargo cargo-nextest anvil forge node; do
  command -v "$tool" >/dev/null || die "$tool not found on PATH"
done
if [[ -n "$TAG" ]]; then
  for tool in gpg curl sha256sum tar; do
    command -v "$tool" >/dev/null || die "$tool not found on PATH"
  done
  [[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] ||
    die "--tag runs the release's linux-x86_64 binaries; use --ref on this machine"
fi

SDK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$SDK_DIR/node_modules/vitest/vitest.mjs" ]] ||
  die "install this repo's dependencies first: pnpm install --frozen-lockfile --ignore-scripts"

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
if [[ -z "$DIR" ]]; then
  DIR="$WORK/decdn"
fi

# ---- decdn at the tag or ref ---------------------------------------------

TARGET="${TAG:-$REF}"
# `git init` + fetch rather than clone: a CI cache may already have restored
# `target/` into DIR.
if [[ ! -e "$DIR/.git" ]]; then
  mkdir -p "$DIR"
  git init --quiet "$DIR"
  git -C "$DIR" remote add origin https://github.com/decdn/decdn
fi
git -C "$DIR" fetch --quiet --force --tags origin || die "cannot fetch decdn into $DIR"
if [[ -n "$TAG" ]]; then
  git -C "$DIR" fetch --quiet --force origin "refs/tags/$TAG:refs/tags/$TAG" ||
    die "decdn has no tag $TAG"
  git -C "$DIR" checkout --quiet --detach "refs/tags/$TAG^{commit}"
else
  git -C "$DIR" fetch --quiet origin "$REF" || die "decdn has no ref $REF"
  git -C "$DIR" checkout --quiet --detach FETCH_HEAD
fi
git -C "$DIR" submodule update --quiet --init --recursive ||
  die "cannot check out decdn's submodules"

# ---- the binaries the harness runs ---------------------------------------

if [[ -n "$TAG" ]]; then
  # The tag and the archives must be the ones a maintainer signed: only the
  # keys in KEYS, as scripts/publish.sh checks its own tags.
  export GNUPGHOME="$WORK/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --quiet --import "$SDK_DIR/KEYS" 2>/dev/null || die "KEYS is not a valid OpenPGP keyring"
  git -C "$DIR" verify-tag "$TAG" 2>/dev/null || die "$TAG is not signed by a key in KEYS"
  VERSION="${TAG#v}"
  BIN="$WORK/bin"
  mkdir "$BIN"
  BASE="https://github.com/decdn/decdn/releases/download/$TAG"
  ARCHIVES=("decdn-$VERSION-x86_64-unknown-linux-gnu.tar.gz" "decdn-node-$VERSION-x86_64-unknown-linux-gnu.tar.gz")
  for file in SHA256SUMS SHA256SUMS.asc "${ARCHIVES[@]}"; do
    curl --fail --silent --show-error --location --output "$BIN/$file" "$BASE/$file" ||
      die "cannot download $file from the $TAG release"
  done
  gpg --quiet --verify "$BIN/SHA256SUMS.asc" "$BIN/SHA256SUMS" 2>/dev/null ||
    die "SHA256SUMS of $TAG is not signed by a key in KEYS"
  # Exactly the two archives, each listed: `--ignore-missing` alone would pass
  # an archive SHA256SUMS does not name. The tag check leaves dots the only
  # ERE metacharacter in a name.
  for archive in "${ARCHIVES[@]}"; do
    grep -E "^[0-9a-f]{64}  ${archive//./\\.}\$" "$BIN/SHA256SUMS" >> "$BIN/wanted" ||
      die "SHA256SUMS of $TAG does not list $archive"
  done
  (cd "$BIN" && sha256sum --quiet --check wanted) || die "a $TAG archive does not match SHA256SUMS"
  for archive in "${ARCHIVES[@]}"; do
    tar -xzf "$BIN/$archive" -C "$BIN"
  done
  [[ -x "$BIN/decdn" && -x "$BIN/decdn-node" ]] || die "the $TAG archives hold no decdn and decdn-node"
  export DECDN_CLI_BIN="$BIN/decdn" DECDN_NODE_BIN="$BIN/decdn-node"
  unset GNUPGHOME
  echo "==> decdn $TAG, signed release binaries"
else
  need_harness
  echo "==> decdn $REF ($(git -C "$DIR" rev-parse --short HEAD)), built from source"
  (cd "$DIR" && cargo build --quiet -p decdn-cli -p decdn-node)
fi

# ---- the run -------------------------------------------------------------

need_harness

(cd "$DIR/contracts" && forge build --quiet)
cd "$DIR"
DECDN_SDK_DIR="$SDK_DIR" cargo nextest run -p decdn-e2e --features anvil-e2e,sdk-e2e \
  --test gateway_sdk --test-threads 2 --no-tests=fail
