#!/usr/bin/env bash
# The steps of the `Publish` workflow (.github/workflows/publish.yml), which
# publishes `@decdn/client` from a signed `v<version>` tag to npm, through npm
# trusted publishing, and then makes the tag's GitHub release:
#
#   scripts/publish.sh verify vX.Y.Z
#       The tag is signed by a key in KEYS on origin/main, origin has the same
#       tag, and the clean checkout is at it.
#   scripts/publish.sh notes vX.Y.Z
#       Prints the GitHub release notes: the tag's CHANGELOG.md section, then
#       the npm link and the gateway floor. Checks package.json first.
#   scripts/publish.sh npm vX.Y.Z TARBALL [--dry-run]
#       Uploads the packed tarball, unless npm has the version already, as
#       this tarball; a version npm has from any other tarball stops it.
#   scripts/publish.sh github vX.Y.Z NOTES
#       Makes the GitHub release, unless it exists.
#
# `verify` and `notes` read the checkout this script is in, so the workflow
# checks out the tag first.
#
# A prerelease (`v0.2.0-rc.1`) publishes under the `next` dist-tag, so
# `npm install @decdn/client` keeps resolving the latest release, and its
# GitHub release is a prerelease, never the latest.
#
# An npm version is immutable and can never be published again, even after
# `npm unpublish`. `npm` skips the upload when npm has this tarball, and
# `github` skips the release when it exists, so a re-run of the workflow
# finishes a run that failed partway.
set -euo pipefail

NAME=@decdn/client
REPO=decdn/sdk-typescript

die() { echo "error: $*" >&2; exit 1; }
usage() {
  echo "usage: $0 verify|notes TAG | npm TAG TARBALL [--dry-run] | github TAG NOTES" >&2
  exit 2
}

(($# >= 2)) || usage
CMD="$1" TAG="$2"
shift 2

# Semver without build metadata: npm drops `+build`, so two tags would name
# one version.
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'
[[ "$TAG" =~ ^v${SEMVER}$ ]] ||
  die "the tag must be v<major>.<minor>.<patch>[-<prerelease>], got '$TAG'"
VERSION="${TAG#v}"
DIST_TAG=latest
[[ "$VERSION" == *-* ]] && DIST_TAG=next

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool not found on PATH"
  done
}

SCRATCH=""
scratch() {
  SCRATCH=$(mktemp -d)
  trap 'rm -rf "$SCRATCH"' EXIT
}

# ---- verify ----------------------------------------------------------------

verify() {
  (($# == 0)) || usage
  need git gpg
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  scratch

  # --force: `git fetch --tags` keeps a stale local tag otherwise.
  git fetch --quiet --tags --force origin ||
    die "cannot reach origin to confirm the tag"
  git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null ||
    die "tag $TAG does not exist"

  # KEYS from origin/main, not from the tagged tree: a tag that carried its own
  # KEYS would vouch for itself. The scratch keyring holds only those keys, so
  # no other key on the machine can pass.
  mkdir -m 700 "$SCRATCH/gnupg"
  git show origin/main:KEYS >"$SCRATCH/KEYS" ||
    die "cannot read KEYS from origin/main"
  gpg --homedir "$SCRATCH/gnupg" --batch --import "$SCRATCH/KEYS" >/dev/null 2>&1 ||
    die "KEYS on origin/main is not a valid OpenPGP keyring"
  echo "==> Verifying $TAG"
  GNUPGHOME="$SCRATCH/gnupg" git verify-tag "$TAG" ||
    die "$TAG is not signed by a key in KEYS on origin/main"

  local commit remote dirty
  commit=$(git rev-parse "refs/tags/${TAG}^{commit}") ||
    die "cannot resolve $TAG to a commit"
  # `^{}` asks the remote for the commit an annotated (signed) tag peels to.
  remote=$(git ls-remote origin "refs/tags/${TAG}^{}" | awk '{print $1}') ||
    die "cannot list $TAG on origin"
  [[ -n "$remote" ]] || die "tag $TAG is not on origin: push it first"
  [[ "$commit" == "$remote" ]] ||
    die "local tag $TAG ($commit) differs from origin's ($remote)"
  [[ "$(git rev-parse HEAD)" == "$commit" ]] ||
    die "the checkout is not at $TAG ($commit): check the tag out first"
  dirty=$(git status --porcelain) || die "git status failed"
  [[ -z "$dirty" ]] ||
    die "the checkout at $TAG is not clean: npm would get what is on disk"
  echo "==> $TAG is $commit, signed by a key in KEYS"
}

# ---- notes -----------------------------------------------------------------

notes() {
  (($# == 0)) || usage
  need node
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  local name version floor section rule install
  read -r name version floor < <(node -p '
    const p = require("./package.json");
    [p.name, p.version, p.decdn?.gatewayFloor ?? "-"].join(" ")') ||
    die "cannot read package.json"
  [[ "$name" == "$NAME" ]] || die "the package at $TAG is $name, not $NAME"
  [[ "$version" == "$VERSION" ]] ||
    die "package.json is at $version, but the tag says $VERSION"
  [[ "$floor" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "package.json at $TAG has decdn.gatewayFloor '$floor', not X.Y.Z"

  # The section without its heading. A prerelease has none (its commits fall
  # into the next release's), so its notes are the footer alone; a release
  # without one stops here, before anything is uploaded.
  section=$(awk -v head="## [$VERSION] " '
    index($0, head) == 1 { inside = 1; next }
    inside && /^## \[/ { exit }
    inside && NF { while (blanks > 0) { print ""; blanks-- }; started = 1; print; next }
    inside && started { blanks++ }
  ' CHANGELOG.md) || die "cannot read CHANGELOG.md at $TAG"
  rule=""
  if [[ -n "$section" ]]; then
    rule=$'\n\n---\n\n'
  elif [[ "$DIST_TAG" == latest ]]; then
    die "CHANGELOG.md at $TAG has no '## [$VERSION]' section"
  fi
  install="$NAME"
  [[ "$DIST_TAG" == latest ]] || install="$NAME@$DIST_TAG"
  printf '%s%s%s\n' "$section" "$rule" \
    "npm: [\`$NAME@$VERSION\`](https://www.npmjs.com/package/$NAME/v/$VERSION) (\`npm install $install\`). Browser pages and public gateways need \`decdn gateway\` [v$floor](https://github.com/decdn/decdn/releases/tag/v$floor) or later."
}

# ---- npm -------------------------------------------------------------------

publish_npm() {
  (($# >= 1 && $# <= 2)) || usage
  local tarball="$1" dry=""
  if (($# == 2)); then
    [[ "$2" == --dry-run ]] || usage
    dry=1
  fi
  need npm node tar
  scratch
  [[ -f "$tarball" ]] || die "no tarball at $tarball"

  # The tarball is what npm gets: it must be this tag's package.
  local packed
  packed=$(tar -xzOf "$tarball" package/package.json |
    node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(p.name + "@" + p.version)') ||
    die "cannot read package/package.json in $tarball"
  [[ "$packed" == "$NAME@$VERSION" ]] ||
    die "$tarball holds $packed, not $NAME@$VERSION"

  # npm refuses a version it already has, so when it has this one the upload
  # is skipped, as after a run whose GitHub step failed, provided npm's copy is
  # this tarball: the pack is byte-reproducible, so a version that came from
  # anywhere else stops the run before the GitHub release vouches for it. npm
  # answers a version it lacks with a 404 (or, before npm 11, with nothing);
  # any other answer, or failure to ask, stops here, before the upload.
  if npm view "$NAME@$VERSION" version >"$SCRATCH/npm.out" 2>"$SCRATCH/npm.err"; then
    local answer
    answer=$(<"$SCRATCH/npm.out")
    if [[ "$answer" == "$VERSION" ]]; then
      local theirs ours
      theirs=$(npm view "$NAME@$VERSION" dist.integrity) ||
        die "cannot ask npm for $NAME@$VERSION's integrity"
      ours=$(node -e '
        const h = require("crypto").createHash("sha512");
        h.update(require("fs").readFileSync(process.argv[1]));
        console.log("sha512-" + h.digest("base64"))' "$tarball") ||
        die "cannot hash $tarball"
      [[ "$theirs" == "$ours" ]] ||
        die "npm has $NAME@$VERSION, but not this tarball (npm: $theirs; $TAG: $ours)"
      echo "==> $NAME@$VERSION is already on npm, as this tarball; not publishing it again"
      return 0
    fi
    [[ -z "$answer" ]] ||
      die "npm answered '$answer' when asked for $NAME@$VERSION"
  elif ! grep -q 'code E404' "$SCRATCH/npm.err"; then
    cat "$SCRATCH/npm.err" >&2
    die "cannot ask npm whether it has $NAME@$VERSION"
  fi

  # --ignore-scripts: the upload runs no code from the package.
  local args=(publish "$tarball" --access public --tag "$DIST_TAG" --ignore-scripts)
  if [[ -n "$dry" ]]; then
    echo "==> Dry run: $NAME@$VERSION (dist-tag $DIST_TAG)"
    npm "${args[@]}" --dry-run
    return 0
  fi
  echo "==> Publishing $NAME@$VERSION (dist-tag $DIST_TAG)"
  npm "${args[@]}"
  echo "==> Published. Check: npm view $NAME@$VERSION"
}

# ---- github ----------------------------------------------------------------

publish_github() {
  (($# == 1)) || usage
  local notes="$1"
  need gh
  scratch
  [[ -s "$notes" ]] || die "no release notes at $notes"

  # `gh release view` answers a draft too: a draft is not a release, and one
  # for this tag stops the run.
  local draft
  if draft=$(GH_PROMPT_DISABLED=1 gh release view "$TAG" --repo "$REPO" \
    --json isDraft --jq .isDraft 2>"$SCRATCH/gh.err"); then
    [[ "$draft" == false ]] ||
      die "$REPO has a draft release for $TAG: publish or delete it, then run again"
    echo "==> $REPO already has the release $TAG; left as is"
    return 0
  elif ! grep -qx 'release not found' "$SCRATCH/gh.err"; then
    cat "$SCRATCH/gh.err" >&2
    die "cannot ask GitHub whether $REPO has the release $TAG"
  fi

  local args=(release create "$TAG" --repo "$REPO" --verify-tag --title "$TAG" --notes-file "$notes")
  [[ "$DIST_TAG" == latest ]] || args+=(--prerelease --latest=false)
  echo "==> Creating the GitHub release $TAG"
  GH_PROMPT_DISABLED=1 gh "${args[@]}"
  echo "==> Released. Check: gh release view $TAG --repo $REPO"
}

case "$CMD" in
  verify) verify "$@" ;;
  notes) notes "$@" ;;
  npm) publish_npm "$@" ;;
  github) publish_github "$@" ;;
  *) usage ;;
esac
