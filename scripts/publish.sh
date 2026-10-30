#!/usr/bin/env bash
# Publishes `@decdn/client` to npm from a signed `v<version>` tag, then makes
# the tag's GitHub release, its notes the tag's CHANGELOG.md section, the npm
# link and the gateway floor.
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
# `npm install @decdn/client` keeps resolving the latest release, and its
# GitHub release is a prerelease, never the latest.
#
# Environment:
#   DECDN_SIGNING_KEY   key the tag is expected to be signed by (default: any
#                       key in KEYS, vendored from decdn/decdn)
#   DECDN_NPM_DRY_RUN   set to 1/true/yes to run every check but the npm login,
#                       and `pnpm publish --dry-run` unless npm has the
#                       version, uploading nothing and printing the release
#                       notes instead of releasing
#
# An npm version is immutable and can never be published again, even after
# `npm unpublish`. A re-run skips the upload when npm already has the version,
# and the GitHub release when it exists, so it finishes a run whose GitHub
# step failed.
set -euo pipefail

TAG="${1:?tag required, e.g. v0.1.0}"
SIGNING_KEY="${DECDN_SIGNING_KEY:-}"
REPO=decdn/sdk-typescript

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

for tool in git gh gpg node npm corepack; do
  command -v "$tool" >/dev/null || die "$tool not found on PATH"
done

if [[ -z "$DRY_RUN" ]]; then
  npm whoami >/dev/null 2>&1 ||
    die "not logged in to npm; run \`npm login\` as a member of the @decdn org"
fi
# The account's role on $REPO, asked before npm is touched: without write
# access the GitHub release would fail only after the upload. A fine-grained
# token's own grant is not part of the answer.
push=$(GH_PROMPT_DISABLED=1 gh api "repos/$REPO" --jq .permissions.push 2>&1) ||
  die "gh cannot read $REPO ($push); run \`gh auth login\` with write access to it"
[[ "$push" == true ]] || die "gh's account has no write access to $REPO"

REPO_ROOT=$(git rev-parse --show-toplevel) || die "not inside a git repository"
KEYS_FILE="$REPO_ROOT/KEYS"
[[ -f "$KEYS_FILE" ]] || die "KEYS not found at $KEYS_FILE"

# A gpg home containing ONLY the published maintainer keys, as in decdn's
# publish-crates.sh: verifying against your own keyring only proves you can
# read a signature you already trust.
KEYS_HOME=$(mktemp -d)
chmod 700 "$KEYS_HOME"
# The release notes and the probes' answers.
SCRATCH=$(mktemp -d)
WORKTREE=""
cleanup() {
  local rc=$? err
  rm -rf "$KEYS_HOME" "$SCRATCH"
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

# The release notes: the tag's CHANGELOG.md section without its heading, then
# where to get the package and the gateway it needs. A prerelease has no
# section (its commits fall into the next release's), so its notes are the
# footer alone; a release without one stops here, before anything is uploaded.
FLOOR=$(node -p 'require("./package.json").decdn?.gatewayFloor ?? ""') ||
  die "cannot read package.json at $TAG"
[[ "$FLOOR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "package.json at $TAG has decdn.gatewayFloor '$FLOOR', not X.Y.Z"
NOTES="$SCRATCH/notes.md"
awk -v head="## [$VERSION] " '
  index($0, head) == 1 { inside = 1; next }
  inside && /^## \[/ { exit }
  inside && NF { while (blanks > 0) { print ""; blanks-- }; started = 1; print; next }
  inside && started { blanks++ }
' CHANGELOG.md >"$NOTES" || die "cannot read CHANGELOG.md at $TAG"
RULE=""
if [[ -s "$NOTES" ]]; then
  RULE=$'\n---\n\n'
elif [[ "$DIST_TAG" == latest ]]; then
  die "CHANGELOG.md at $TAG has no '## [$VERSION]' section"
fi
INSTALL="$NAME"
[[ "$DIST_TAG" == latest ]] || INSTALL="$NAME@$DIST_TAG"
cat >>"$NOTES" <<EOF
${RULE}npm: [\`$NAME@$VERSION\`](https://www.npmjs.com/package/$NAME/v/$VERSION) (\`npm install $INSTALL\`). Browser pages and public gateways need \`decdn gateway\` [v$FLOOR](https://github.com/decdn/decdn/releases/tag/v$FLOOR) or later.
EOF

# HUSKY=0: install and publish run `prepare`, and husky's `git config` from a
# worktree would rewrite core.hooksPath in the maintainer's own checkout.
pnpm() { HUSKY=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }
echo "==> Install, lint, test, build"
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build

PUBLISH=(publish --access public --no-git-checks --tag "$DIST_TAG")
RELEASE=(release create "$TAG" --repo "$REPO" --verify-tag --title "$TAG" --notes-file "$NOTES")
[[ "$DIST_TAG" == latest ]] || RELEASE+=(--prerelease --latest=false)
# npm refuses a version it already has, so when it has this one the upload is
# skipped and the run goes on to the GitHub release, as after a run whose
# GitHub step failed. Only npm's 404 means it does not: any other failure to
# ask stops here, before the upload.
ON_NPM=""
if npm view "$NAME@$VERSION" version >"$SCRATCH/npm.out" 2>"$SCRATCH/npm.err"; then
  [[ "$(<"$SCRATCH/npm.out")" == "$VERSION" ]] && ON_NPM=1
elif ! grep -q 'code E404' "$SCRATCH/npm.err"; then
  cat "$SCRATCH/npm.err" >&2
  die "cannot ask npm whether it has $NAME@$VERSION"
fi
# `gh release view` answers a draft too: a draft is not a release, and one for
# this tag stops the run, before the upload.
HAS_RELEASE=""
if draft=$(GH_PROMPT_DISABLED=1 gh release view "$TAG" --repo "$REPO" \
  --json isDraft --jq .isDraft 2>"$SCRATCH/gh.err"); then
  [[ "$draft" == false ]] ||
    die "$REPO has a draft release for $TAG: publish or delete it, then run again"
  HAS_RELEASE=1
elif ! grep -qx 'release not found' "$SCRATCH/gh.err"; then
  cat "$SCRATCH/gh.err" >&2
  die "cannot ask GitHub whether $REPO has the release $TAG"
fi

if [[ -n "$DRY_RUN" ]]; then
  echo "==> Dry run"
  if [[ -n "$ON_NPM" ]]; then
    echo "==> $NAME@$VERSION is already on npm; it would not be published again"
  else
    pnpm "${PUBLISH[@]}" --dry-run
  fi
  if [[ -n "$HAS_RELEASE" ]]; then
    echo "==> $REPO already has the release $TAG; it would be left as is"
  else
    echo "==> The GitHub release would be: gh ${RELEASE[*]}"
  fi
  echo "--- notes ---"
  cat "$NOTES"
  echo "-------------"
  echo "==> Dry run of $NAME@$VERSION passed; nothing was uploaded or released"
  exit 0
fi

if [[ -n "$ON_NPM" ]]; then
  echo "==> $NAME@$VERSION is already on npm; not publishing it again"
  echo "    the release adopts npm's upload: $(npm view "$NAME@$VERSION" dist.integrity)"
else
  echo "==> Publishing $NAME@$VERSION"
  pnpm "${PUBLISH[@]}"
  echo "==> Published. Check: npm view $NAME@$VERSION"
fi

if [[ -n "$HAS_RELEASE" ]]; then
  echo "==> $REPO already has the release $TAG; left as is"
  exit 0
fi
echo "==> Creating the GitHub release $TAG"
GH_PROMPT_DISABLED=1 gh "${RELEASE[@]}" || die \
  "npm has $NAME@$VERSION, but the GitHub release failed (gh's error above).
Once it is fixed, run \`scripts/publish.sh $TAG\` again: the upload is skipped."
echo "==> Released. Check: gh release view $TAG --repo $REPO"
