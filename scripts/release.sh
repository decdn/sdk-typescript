#!/usr/bin/env bash
# Cuts a release of `@decdn/client` on main, in the manner of `cargo release`:
# bumps `version` with `pnpm version`, writes the CHANGELOG.md section with
# git-cliff, then makes a signed release commit and a signed `vX.Y.Z` tag and
# pushes both. There is no release PR. Publishing is the next, separate step,
# `scripts/publish.sh vX.Y.Z`: an npm version is immutable, so nothing is
# uploaded before the tag is on origin and a human runs it.
#
#   scripts/release.sh [auto|patch|minor|major|X.Y.Z]
#                      [--execute] [--no-verify] [--allow-unconventional]
#
# Without --execute it is a dry run: it prints the new tag and the diff it would
# commit, and changes no file. The level defaults to `auto`, the bump git-cliff
# derives (cliff.toml) from the conventional commits since the last `v*` tag.
# Before 1.0, a feature (or, from 0.1 on, a breaking change) bumps the minor and
# any other commit kept in the changelog bumps the patch. The section is
# git-cliff's rendering of those commits, under a `## [X.Y.Z] — YYYY-MM-DD`
# heading. A commit there that git-cliff cannot parse as a Conventional Commit
# would be dropped without a word, so the script has git-cliff list them
# (require_conventional) and refuses them unless --allow-unconventional.
#
# The first release (no tag yet, package.json at the 0.0.0 placeholder) names
# its level and releases the changelog's hand-written `## [Unreleased]` section
# instead: without a previous tag, git-cliff would render the whole history.
#
# Every release needs the decdn gateway release package.json names as its floor
# (`decdn.gatewayFloor`) to be published: an SDK whose floor names an unreleased
# gateway does not ship (RELEASING.md).
#
# --execute runs `pnpm lint`, `pnpm test`, `pnpm build` and
# scripts/check-package.sh on the result unless --no-verify: a tag that fails
# its checks burns the version. If any of that or the commit fails, the files
# are restored. Run it on an up-to-date, clean main, with git configured to sign
# (user.signingkey), and with a bypass of the main ruleset (its PR rule and its
# required status checks): the release commit goes straight to main.
set -euo pipefail

usage() {
  echo "usage: $0 [auto|patch|minor|major|X.Y.Z] [--execute] [--no-verify] [--allow-unconventional]" >&2
  exit 2
}
die() { echo "release: $*" >&2; exit 1; }

level="" execute=0 verify=1 allow_unconventional=0
for arg in "$@"; do
  case "$arg" in
    --execute) execute=1 ;;
    --no-verify) verify=0 ;;
    --allow-unconventional) allow_unconventional=1 ;;
    -*) usage ;;
    *)
      [[ -z "$level" ]] || usage
      level="$arg" ;;
  esac
done
level="${level:-auto}"
[[ "$level" =~ ^(auto|patch|minor|major|[0-9]+\.[0-9]+\.[0-9]+)$ ]] || usage

for tool in git node pnpm gh; do
  command -v "$tool" >/dev/null || die "$tool not found on PATH"
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
prefix="v"
manifest="package.json"
changelog="CHANGELOG.md"
# What the release commit changes.
files=("$manifest" "$changelog")
[[ -f "$manifest" && -f "$changelog" ]] || die "$manifest or $changelog is missing"

tmp="$(mktemp -d)"
written=0 committed=0 pushed=0 reported=0
cleanup() {
  # Once --execute has written the files, any failure before the release commit
  # exists puts them back. Nothing is restored before that: a refusal never
  # touches the maintainer's own edits.
  if ((written == 1 && committed == 0)); then
    git checkout -q -- "${files[@]}" \
      || echo "release: could not restore ${files[*]}: run git checkout -- ${files[*]}" >&2
  fi
  # Stopped (Ctrl-C, say) between the release commit and the end of the push.
  if ((committed == 1 && pushed == 0 && reported == 0)); then
    echo "release: stopped after the release commit, before the push finished. Check what origin has:" >&2
    echo "  git ls-remote origin refs/heads/main refs/tags/$tag" >&2
    echo "then, if it has neither, undo locally: git tag -d $tag; git reset --hard origin/main" >&2
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "$branch" == "main" ]] || die "releases are cut on main, not '${branch:-a detached HEAD}'"
status="$(git status --porcelain)" || die "git status failed"
[[ -z "$status" ]] || die "the working tree is not clean (git status)"
git fetch --quiet --tags origin main || die "git fetch origin failed"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || die "main is not origin/main: pull or push first"
if ((execute == 1)); then
  [[ -n "$(git config user.signingkey || true)" ]] \
    || die "git has no user.signingkey: the release commit and tag are signed"
  # Sign a throwaway commit object now, not after the checks: an unusable key
  # would otherwise fail only at the release commit.
  git commit-tree -S -p HEAD -m "release.sh signing check" "HEAD^{tree}" >/dev/null 2>"$tmp/sign.err" \
    || { cat "$tmp/sign.err" >&2; die "git cannot sign with user.signingkey"; }
fi

# <key>: a string field of package.json, or nothing.
pkg() { node -e 'const v = process.argv[1].split(".").reduce((o, k) => o?.[k], require("./package.json")); if (typeof v === "string") console.log(v)' "$1"; }
[[ "$(pkg name)" == "@decdn/client" ]] || die "$manifest does not name @decdn/client"
current="$(pkg version)"
[[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$manifest has version '${current}', not X.Y.Z"
floor="$(pkg decdn.gatewayFloor)"
[[ "$floor" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$manifest has decdn.gatewayFloor '${floor}', not X.Y.Z"
# A draft release is not published: its binaries are not signed yet.
draft="$(GH_PROMPT_DISABLED=1 gh api "repos/decdn/decdn/releases/tags/v$floor" --jq .draft 2>/dev/null || true)"
[[ "$draft" == "false" ]] \
  || die "the gateway floor, decdn v$floor, is not a published release (gh api repos/decdn/decdn/releases/tags/v$floor): release decdn first or lower decdn.gatewayFloor"

ver_gt() { [[ "$1" != "$2" && "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }
tag_re="^${prefix}[0-9]+\.[0-9]+\.[0-9]+$"
# <tag names on stdin>: the highest X.Y.Z among the release tags, or nothing.
highest() { { grep -E "$tag_re" || (($? == 1)); } | sed "s/^$prefix//" | sort -V | tail -n1; }
# The last release is origin's highest tag. A different local one (a tag left
# by a failed push, say) would move git-cliff's boundary, so it is refused.
remote_tags="$(git ls-remote --tags --refs origin "refs/tags/${prefix}*")" || die "git ls-remote origin failed"
remote_tags="$(awk '{sub(/^refs\/tags\//, "", $2); print $2}' <<<"$remote_tags")"
local_tags="$(git tag --list "${prefix}*")" || die "git tag failed"
prev="$(highest <<<"$remote_tags")"
local_prev="$(highest <<<"$local_tags")"
[[ "$local_prev" == "$prev" ]] \
  || die "the highest local tag, $prefix${local_prev:-?}, is not origin's (${prev:+$prefix}${prev:-none}): delete it with git tag -d"
today="$(date -u +%F)"

# --- version and section -----------------------------------------------------
if [[ -z "$prev" ]]; then
  # First release: the hand-written [Unreleased] section becomes the release's.
  [[ "$current" == "0.0.0" ]] || die "no ${prefix}X.Y.Z tag yet, but $manifest is $current, not the 0.0.0 placeholder"
  case "$level" in
    auto) die "the first release names its level: minor for 0.1.0" ;;
    patch) version="0.0.1" ;;
    minor) version="0.1.0" ;;
    major) version="1.0.0" ;;
    *) version="$level" ;;
  esac
  ver_gt "$version" "0.0.0" || die "$version is not above 0.0.0"
  grep -qx '## \[Unreleased\]' "$changelog" \
    || die "$changelog has no '## [Unreleased]' section for the first release"
  awk -v h="## [$version] — $today" '$0 == "## [Unreleased]" {print h; next} {print}' \
    "$changelog" > "$tmp/changelog"
  awk -v h="## [$version] — $today" '
    $0 == h {on=1; next}
    on && (/^## \[/ || /^<!--/ || /^\[[^]]+\]: /) {exit}
    on' "$tmp/changelog" > "$tmp/section"
  grep -q '^- ' "$tmp/section" || die "$changelog: the [Unreleased] section has no '- ' entries"
else
  command -v git-cliff >/dev/null || die "git-cliff is not installed (cargo install git-cliff)"
  cliff_version="$(git-cliff --version)" || die "git-cliff --version failed"
  cliff_version="$(awk '{print $2}' <<<"$cliff_version")"
  # 2.9 added require_conventional, which the unconventional-commit refusal
  # below needs.
  ver_gt "2.9.0" "$cliff_version" && die "git-cliff 2.9 or later is required, not ${cliff_version:-unknown}"
  [[ "$current" == "$prev" ]] \
    || die "$manifest is $current, but the last tag is $prefix$prev: fix the manifest first"
  if grep -q '^## \[Unreleased\]' "$changelog"; then
    die "$changelog has an [Unreleased] section: sections are generated since the first release, so turn its entries into commit subjects or drop it"
  fi

  # Every run is --unreleased: the commits since the last tag. (git-cliff's
  # require_conventional would otherwise judge the whole history.)
  cliff() {
    git-cliff --config "$repo/cliff.toml" --tag-pattern "$tag_re" --unreleased "$@" 2>"$tmp/cliff.err" \
      || { cat "$tmp/cliff.err" >&2; die "git-cliff failed"; }
  }
  # git-cliff drops a commit it cannot parse as a Conventional Commit
  # (cliff.toml, filter_unconventional) and only says so in a log line, so the
  # bump and the section would leave it out unseen: an empty scope, say, or a
  # body right under the subject. With require_conventional it fails instead,
  # naming each one.
  if ! GIT_CLIFF__GIT__REQUIRE_CONVENTIONAL=true git-cliff --config "$repo/cliff.toml" --tag-pattern "$tag_re" \
      --unreleased --bumped-version >/dev/null 2>"$tmp/cliff.err"; then
    esc="$(printf '\033')"
    sed "s/$esc\[[0-9;]*m//g" "$tmp/cliff.err" > "$tmp/cliff.plain" # git-cliff colours its log even off a tty
    grep -q 'UnconventionalCommitsError' "$tmp/cliff.plain" || { cat "$tmp/cliff.err" >&2; die "git-cliff failed"; }
    echo "release: git-cliff cannot parse these commits as Conventional Commits, so the changelog and the bump leave them out:" >&2
    # "Commit <hash> is not conventional:", then the message, one "| " line per line.
    awk '/Commit [0-9a-f]+ is not conventional:/ {match($0, /Commit [0-9a-f]+/); h=substr($0, RSTART+7, RLENGTH-7); next}
         h != "" && sub(/^[[:space:]]*\| /, "") {print "  " h " " $0; h=""}' "$tmp/cliff.plain" >&2
    ((allow_unconventional == 1)) || die "refusing; re-run with --allow-unconventional to release without them"
  fi
  case "$level" in
    auto) bumped="$(cliff --bumped-version)" ;;
    patch|minor|major) bumped="$(cliff --bump "$level" --bumped-version)" ;;
    *) bumped="$prefix$level" ;;
  esac
  [[ "$bumped" =~ $tag_re ]] || die "git-cliff proposed '$bumped', not a ${prefix}X.Y.Z tag"
  version="${bumped#"$prefix"}"
  # Squeeze git-cliff's blank lines and trim the ends.
  cliff --strip all | cat -s | sed '/./,$!d' | sed '${/^$/d;}' > "$tmp/section"
  bad="$(grep '^### ' "$tmp/section" | grep -vxE '### (Added|Changed|Deprecated|Removed|Fixed|Security)' || true)"
  [[ -z "$bad" ]] || die "git-cliff rendered a heading that is not a Keep a Changelog kind: $bad (fix cliff.toml's commit_parsers)"
  if [[ "$version" == "$prev" ]] || ! grep -q '^- ' "$tmp/section"; then
    die "nothing to release: no commit since $prefix$prev makes a changelog entry (ci, test, style, build and release commits do not, nor, with --allow-unconventional, unconventional ones)"
  fi
  ver_gt "$version" "$prev" || die "$version is not above the last release, $prev"
  awk -v h="## [$version] — $today" -v s="$tmp/section" '
    !done && /^## \[/ {
      print h; print ""
      while ((getline l < s) > 0) print l
      print ""; done=1
    }
    {print}
    END {
      if (!done) {
        print ""; print h; print ""
        while ((getline l < s) > 0) print l
      }
    }' "$changelog" > "$tmp/changelog"
fi
tag="$prefix$version"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"
! grep -qx "$tag" <<<"$remote_tags" || die "tag $tag already exists on origin"

# Formatted as prettier formats it, so the diff below is what the commit holds:
# `pnpm lint` checks it, and the pre-commit hook would rewrite it otherwise.
pnpm exec prettier --stdin-filepath "$changelog" < "$tmp/changelog" > "$tmp/changelog.fmt" \
  || die "prettier failed on the new $changelog"
mv "$tmp/changelog.fmt" "$tmp/changelog"
# What `pnpm version` writes: package.json re-serialised, two-space indented.
node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); p.version = process.argv[2]; process.stdout.write(JSON.stringify(p, null, 2) + "\n")' \
  "$manifest" "$version" > "$tmp/manifest" || die "could not set the version in $manifest"

show_diff() { # <file> <new copy>
  local rc=0
  diff -u --label "a/$1" --label "b/$1" "$1" "$2" || rc=$?
  ((rc <= 1)) || die "diff failed on $1"
}
echo "release @decdn/client: ${prev:+$prefix$prev -> }$tag"
echo
show_diff "$manifest" "$tmp/manifest"
show_diff "$changelog" "$tmp/changelog"
echo

if ((execute == 0)); then
  echo "dry run: no file changed. --execute would run:"
  echo "  pnpm version $version --no-git-tag-version"
  ((verify == 1)) && echo "  pnpm lint && pnpm test && pnpm build && scripts/check-package.sh"
  echo "  git commit -S -m 'chore(release): $tag' -- ${files[*]}"
  echo "  git tag -s $tag -m '@decdn/client $version'"
  echo "  git push --atomic origin main $tag"
  exit 0
fi

# --- execute -----------------------------------------------------------------
written=1
# Before the changelog is written: `pnpm version` refuses a dirty tree.
pnpm version "$version" --no-git-tag-version >/dev/null || die "pnpm version $version failed: nothing was committed"
[[ "$(pkg version)" == "$version" ]] || die "pnpm version left $manifest at $(pkg version), not $version: nothing was committed"
cp "$tmp/changelog" "$changelog"
if ((verify == 1)); then
  pnpm lint || die "pnpm lint failed: nothing was committed"
  pnpm test || die "pnpm test failed: nothing was committed"
  pnpm build || die "pnpm build failed: nothing was committed"
  scripts/check-package.sh || die "scripts/check-package.sh failed: nothing was committed"
fi
# The checks write dist/ only, which git ignores; anything else is theirs to
# explain before a release commit.
status="$(git status --porcelain -- . ":(exclude)$manifest" ":(exclude)$changelog")"
[[ -z "$status" ]] || die "the checks left changes besides ${files[*]}: nothing was committed"$'\n'"$status"

git commit --quiet -S -m "chore(release): $tag" -- "${files[@]}" \
  || die "git commit failed (a commit hook, or signing): nothing was committed"
committed=1
git tag -s "$tag" -m "@decdn/client $version" \
  || { reported=1; die "tagging failed after the release commit. To undo: git reset --hard origin/main"; }
if ! git push --atomic origin "HEAD:refs/heads/main" "refs/tags/$tag"; then
  # --atomic makes a rejected push all-or-nothing, but a dropped connection can
  # leave it unknown: look before suggesting an undo.
  if seen="$(git ls-remote origin refs/heads/main "refs/tags/$tag")" \
     && ! grep -q "refs/tags/$tag$" <<<"$seen" \
     && ! grep -q "^$(git rev-parse HEAD)[[:space:]]refs/heads/main$" <<<"$seen"; then
    echo "release: the push failed; nothing reached origin. To undo locally:" >&2
    echo "  git tag -d $tag && git reset --hard origin/main" >&2
  else
    echo "release: the push failed, and origin may have the release commit or $tag:" >&2
    echo "  check git ls-remote origin before undoing anything" >&2
  fi
  reported=1
  exit 1
fi
pushed=1
echo "tagged $tag and pushed it with the release commit. Publish it:"
echo "  DECDN_NPM_DRY_RUN=1 scripts/publish.sh $tag"
echo "  scripts/publish.sh $tag"
