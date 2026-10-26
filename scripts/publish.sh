#!/usr/bin/env bash
# Publishes `@decdn/client` to npm from a signed `v<version>` tag.
#
# Like decdn's publish-crates.sh, this is a human step with no counterpart in
# Actions: there is no npm token in Actions secrets, and a `push`-triggered
# workflow runs the workflow definition from the pushed ref, so a token
# reachable from a workflow would be reachable from any tag anyone with push
# access could craft.
#
# Usage:  scripts/publish.sh v0.1.0
#
# A prerelease (`v0.2.0-rc.1`) publishes under the `next` dist-tag, so
# `npm install @decdn/client` keeps resolving the latest release.
#
# Environment:
#   DECDN_SIGNING_KEY   key the tag is expected to be signed by (default: any
#                       key in KEYS, vendored from decdn/decdn)
#   DECDN_NPM_DRY_RUN   set to 1/true/yes to run every check and
#                       `pnpm publish --dry-run`, uploading nothing
#
# NOT freely re-runnable: an npm version is immutable and can never be
# published again, even after `npm unpublish`.
set -euo pipefail

TAG="${1:?tag required, e.g. v0.1.0}"
SIGNING_KEY="${DECDN_SIGNING_KEY:-}"

die() { echo "error: $*" >&2; exit 1; }

# `1`/`true`/`yes` enable, `0`/`false`/`no`/empty do not, anything else is a
# typo and stops the script — the same rule as publish-crates.sh.
enabled() {
  local name="$1" value="${2:-}"
  case "${value,,}" in
    ''|0|false|no) return 1 ;;
    1|true|yes)    return 0 ;;
    *) die "$name must be 1/true/yes or 0/false/no, got '$value'" ;;
  esac
}

# Semver without build metadata: npm drops `+build`, so two tags would name
# one version.
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'
[[ "$TAG" =~ ^v${SEMVER}$ ]] ||
  die "the tag must be v<major>.<minor>.<patch>[-<prerelease>], got '$TAG'"
VERSION="${TAG#v}"
DIST_TAG=latest
[[ "$VERSION" == *-* ]] && DIST_TAG=next

DRY_RUN=""
if enabled DECDN_NPM_DRY_RUN "${DECDN_NPM_DRY_RUN:-}"; then
  DRY_RUN=1
fi

# ---- preconditions -------------------------------------------------------

for tool in git gpg node npm corepack; do
  command -v "$tool" >/dev/null || die "$tool not found on PATH"
done

if [[ -z "$DRY_RUN" ]]; then
  npm whoami >/dev/null 2>&1 ||
    die "not logged in to npm; run \`npm login\` as a member of the @decdn org"
fi

REPO_ROOT=$(git rev-parse --show-toplevel) || die "not inside a git repository"
KEYS_FILE="$REPO_ROOT/KEYS"
[[ -f "$KEYS_FILE" ]] || die "KEYS not found at $KEYS_FILE"

# A gpg home containing ONLY the published maintainer keys, as in decdn's
# publish-crates.sh: verifying against your own keyring only proves you can
# read a signature you already trust.
KEYS_HOME=$(mktemp -d)
chmod 700 "$KEYS_HOME"
WORKTREE=""
cleanup() {
  local rc=$? err
  rm -rf "$KEYS_HOME"
  if [[ -n "${WORKTREE:-}" && -d "${WORKTREE:-}" ]]; then
    err=$(git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>&1) || {
      echo "warning: could not remove the worktree at $WORKTREE: $err" >&2
      echo "         run \`git worktree prune\` to clear the stale entry" >&2
    }
  fi
  return $rc
}
trap cleanup EXIT

gpg --homedir "$KEYS_HOME" --import "$KEYS_FILE" >/dev/null 2>&1 ||
  die "KEYS is not a valid OpenPGP keyring"

# ---- the tag must be the one that was pushed, signed ---------------------

# --force: `git fetch --tags` keeps a stale local tag otherwise.
git fetch --tags --force origin >/dev/null 2>&1 ||
  die "cannot reach origin to confirm the tag"
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null ||
  die "tag $TAG does not exist"

echo "==> Verifying $TAG"
GNUPGHOME="$KEYS_HOME" git verify-tag "$TAG" ||
  die "$TAG is not signed by a key published in KEYS"

if [[ -n "$SIGNING_KEY" ]]; then
  # Primary key fingerprints, compared whole (see decdn's publish-crates.sh for
  # why a VALIDSIG grep is vacuous and why the subkey field is the wrong one).
  sig_fpr=$(GNUPGHOME="$KEYS_HOME" git verify-tag --raw "$TAG" 2>&1 |
    awk '$2 == "VALIDSIG" {print (NF >= 12 ? $NF : $3); exit}')
  [[ -n "$sig_fpr" ]] || die "could not read the signature fingerprint from $TAG"
  mapfile -t want_fprs < <(
    gpg --homedir "$KEYS_HOME" --list-keys --with-colons "$SIGNING_KEY" 2>/dev/null |
      awk -F: '/^pub:/ {want = 1} /^fpr:/ && want {print $10; want = 0}'
  )
  case ${#want_fprs[@]} in
    0) die "DECDN_SIGNING_KEY '$SIGNING_KEY' matches no key published in KEYS" ;;
    1) ;;
    *) die "DECDN_SIGNING_KEY '$SIGNING_KEY' is ambiguous — it matches ${#want_fprs[@]} keys in KEYS.
Use a full fingerprint." ;;
  esac
  [[ "$sig_fpr" == "${want_fprs[0]}" ]] ||
    die "$TAG is signed by $sig_fpr, not by $SIGNING_KEY (${want_fprs[0]})"
fi

LOCAL_COMMIT=$(git rev-parse "refs/tags/${TAG}^{commit}")
# `^{}` asks the remote for the commit an annotated (signed) tag peels to.
REMOTE_COMMIT=$(git ls-remote origin "refs/tags/${TAG}^{}" | awk '{print $1}')
[[ -n "$REMOTE_COMMIT" ]] || die "tag $TAG is not on origin: push it first"
[[ "$LOCAL_COMMIT" == "$REMOTE_COMMIT" ]] || die \
  "local tag $TAG ($LOCAL_COMMIT) differs from origin's ($REMOTE_COMMIT).
npm would receive code that was never tagged there. Reconcile the tags first."

# ---- build and publish from the tagged tree ------------------------------

# A detached worktree at the tag, not the current checkout: the working copy
# may carry uncommitted edits, and pnpm would upload whatever is on disk.
WORKTREE=$(mktemp -d)
rmdir "$WORKTREE"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$TAG" >/dev/null 2>&1 ||
  die "could not create a worktree at $TAG"
cd "$WORKTREE"

read -r NAME PKG_VERSION < <(node -p 'const p = require("./package.json"); p.name + " " + p.version') ||
  die "cannot read package.json at $TAG"
[[ "$NAME" == "@decdn/client" ]] || die "the package at $TAG is $NAME, not @decdn/client"
[[ "$PKG_VERSION" == "$VERSION" ]] ||
  die "package.json is at $PKG_VERSION, but the tag says $VERSION"
echo "==> $NAME@$VERSION (dist-tag $DIST_TAG)"

# HUSKY=0: install and publish run `prepare`, and husky's `git config` from a
# worktree would rewrite core.hooksPath in the maintainer's own checkout.
pnpm() { HUSKY=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }
echo "==> Install, lint, test, build"
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build

PUBLISH=(publish --access public --no-git-checks --tag "$DIST_TAG")
if [[ -n "$DRY_RUN" ]]; then
  echo "==> Dry run"
  pnpm "${PUBLISH[@]}" --dry-run
  echo "==> Dry run of $NAME@$VERSION passed; nothing was uploaded"
  exit 0
fi

echo "==> Publishing $NAME@$VERSION"
pnpm "${PUBLISH[@]}"
echo "==> Published. Check: npm view $NAME@$VERSION"
