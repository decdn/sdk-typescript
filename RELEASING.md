# Releasing @decdn/client

Releases are cut locally by `scripts/release.sh`, which pushes a signed
`vX.Y.Z` tag. The tag push starts the
[`Publish` workflow](.github/workflows/publish.yml), which verifies the tag,
uploads the package to npm through
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) and makes
the GitHub release. The workflow holds no npm token: npm trades the
workflow's GitHub OIDC token for a short-lived credential, and attaches a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
to the version.

The SDK speaks HTTP to a `decdn gateway`. It has its own semver; the gateway
release it needs is a compatibility floor, not a shared version.

## One-time setup

The `decdn` npm organisation owns the `@decdn` scope and the package; keep a
second maintainer in it, so the package outlives one account. Releases go up
through the `Publish` workflow, and npm refuses tokens for the package, as set
up in [Trusted publishing](#trusted-publishing); a maintainer's interactive
publish with two-factor authentication is the only other way in.

`KEYS` holds the maintainer keys a release tag may be signed by. It is a
verbatim copy of [decdn's `KEYS`](https://github.com/decdn/decdn/blob/main/KEYS):
a key added or revoked there is added or revoked here in the same sitting.

## Cutting a version

A version is cut on `main`, with no release PR, by
[`scripts/release.sh`](scripts/release.sh), a wrapper around `pnpm version` and
[git-cliff](https://git-cliff.org) in the manner of `cargo release`. Its tag
push publishes the release:

```bash
scripts/release.sh                    # dry run: the new tag and the diff
scripts/release.sh --execute          # bump, changelog, check, commit, tag, push
gh run list --workflow publish.yml --branch vX.Y.Z   # Publish: npm, then the GitHub release
```

The argument is the level: `auto` (the default), `patch`, `minor`, `major` or
an explicit `X.Y.Z`. Without `--execute`, `release.sh` prints the new tag and
the diff it would commit, and changes no file. It:

1. **Checks the tree, the key and the floor.** It runs on a clean `main` equal
   to `origin/main`, with every local `vX.Y.Z` tag on origin, and
   `package.json` at the last release's version. With `--execute`, it signs a
   throwaway commit and verifies it against `KEYS` alone, as the `Publish`
   workflow verifies the tag. It refuses unless the decdn release `decdn.gatewayFloor`
   names is published (see below), and tells a release GitHub does not have
   from a `gh` that cannot ask.
2. **Refuses unconventional commits.** git-cliff drops a commit it cannot parse
   as a Conventional Commit, from the changelog and from the bump, and only
   logs a count: an unconventional subject, but also an empty scope
   (`feat(): …`) and a body right under the subject with no blank line. The
   script has git-cliff name every such commit since the last tag
   (`require_conventional`) and stops; `--allow-unconventional` releases
   without them.
3. **Picks the version.** `auto` is the bump git-cliff derives (`cliff.toml`)
   from the commits since the last tag. Before 1.0, a feature bumps the minor,
   and so does a breaking change from 0.1 on (at 0.0.x it bumps the patch); any
   other commit kept in the changelog bumps the patch. It refuses when none of
   them makes a changelog entry, whatever the level.
4. **Writes the changelog section.** It renders the same commits into a dated
   `## [X.Y.Z] — YYYY-MM-DD` section at the top of `CHANGELOG.md`, formatted by
   prettier: `feat` under Added, `fix` under Fixed, `revert` under Removed,
   `security` under Security, and `perf`, `refactor`, `docs`, `chore` and any
   other type under Changed. `ci`, `test`, `style` and `build` commits are left
   out unless breaking (those go under Changed); release commits always are. A
   breaking commit (`!` or a `BREAKING CHANGE:` footer) starts with
   **Breaking:**. An entry is the subject without its type, the scope in bold
   and the first letter capitalised: `fix(site): keep the query (#12)` becomes
   `- **site**: Keep the query (#12)`. PRs are squash-merged with the PR title
   as the subject, so the PR title is the changelog entry.
5. **Bumps and checks** (`--execute` only):
   `pnpm version X.Y.Z --no-git-tag-version`, then `pnpm lint`, `pnpm test`,
   `pnpm build` and `scripts/check-package.sh` (`--no-verify` skips the
   checks). The files it commits are the diff it showed, byte for byte, or it
   stops.
6. **Commits** (`--execute` only) `chore(release): vX.Y.Z` and tags `vX.Y.Z`
   (`@decdn/client X.Y.Z`), both signed, and pushes them with
   `git push --atomic origin main vX.Y.Z`: origin gets both or neither. If a
   check or the commit fails, the files are restored and nothing is committed.
   If tagging or the push fails, or the script is stopped after the commit, it
   says how to undo: after a failed push, once it has checked what origin got;
   when stopped, with the command that checks it. A refusal never touches the
   working tree.

**Prerequisites.**

- [git-cliff](https://git-cliff.org) 2.9 or later, for `require_conventional`
  (`cargo install git-cliff`; CI tests with 2.14.1), and `gh`, logged in.
- `gpg`, and git configured to sign with an OpenPGP key published in `KEYS`
  (`user.signingkey`, `gpg.format` unset or `openpgp`). The script verifies a
  throwaway signature against `KEYS` before the checks, so a key that cannot
  sign, or one the `Publish` workflow would refuse, fails before anything is
  pushed.
- A bypass of the `main` ruleset (an org admin), because the release commit
  goes straight to `main`, where the ruleset's pull-request rule and required
  status checks apply to a direct push too. Org admins are also the only
  accounts the `Releases` ruleset lets create a `v*` tag.
- The repository settings the changelog relies on: squash merges only, with
  the PR title as the squash commit's subject (_Settings → General → Pull
  Requests_), and `pr-title` a required status check.
- CI green on the commit, and a green `Release gateways` run (see below).

**The first release.** `package.json` starts at the `0.0.0` placeholder, and
the first release names its level: `scripts/release.sh minor --execute` cuts
`0.1.0`. Without a tag, git-cliff would render the whole history, so the first
release does not use it: it renames the changelog's hand-written
`## [Unreleased]` section to the dated version instead, so until then a
user-visible PR adds its entry there by hand. After that, no `[Unreleased]`
section is kept: the script refuses one, because every later section is
generated.

**A prerelease** (`v0.2.0-rc.1`) is not cut by `release.sh`. Set `version` to
it in a PR, tag the merged commit by hand with `git tag -s` and push the tag,
which publishes it, then set `version` back to the last release in the next
PR:
`release.sh` refuses a `package.json` that is not at the last `vX.Y.Z` tag.
Prerelease tags are not changelog boundaries, so the commits up to the
prerelease fall into the next release's generated section.

## The `Publish` workflow

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on a
`v*` tag push, or by hand (`workflow_dispatch`, from `main`) with a tag to
publish. Its steps are [`scripts/publish.sh`](scripts/publish.sh)'s:

1. **`prepare`**, with no OIDC access:
   - `publish.sh verify` refuses a tag that is not `v<semver>`, and verifies
     the tag against the `KEYS` on `origin/main` (not the tag's own) and
     against `origin`'s tag. On a push, the tag must still name the pushed
     commit.
   - `publish.sh notes` checks that `package.json` names `@decdn/client` at
     the tag's version and renders the release notes: the tag's
     `CHANGELOG.md` section, then the npm link and the gateway floor
     (`decdn.gatewayFloor`). A release without a section stops here.
   - It runs install, lint, tests, the build and `scripts/check-package.sh`,
     packs the tarball with `pnpm pack`, and dry-runs its upload.
2. **`publish`**, in the `release` environment with `id-token: write`, installs
   and builds nothing: `publish.sh npm` checks that the tarball holds this
   version and uploads it with `npm publish --ignore-scripts`. A prerelease
   goes to the `next` dist-tag, so a plain install keeps the latest release.
   The upload moves its dist-tag, so it stops when the dist-tag already names
   a higher version: a delayed run never hands installs an older release.
3. **`release`**: `publish.sh github` makes the tag's GitHub release, titled
   with the tag, with those notes. A prerelease's release is a prerelease,
   never the latest; with no changelog section, its notes are the npm link
   and floor alone. A draft release for the tag stops it: publish or delete
   the draft, then re-run.

**An npm version is published once.** It is immutable: it can never be
published again, even after `npm unpublish`. A broken release is fixed by the
next patch version and `npm deprecate` on the broken one.

**Re-running** the workflow skips the upload when npm has the version as this
tag's tarball (the pack is byte-reproducible; a version npm has from any other
tarball stops the run) and the GitHub release when it exists, so it finishes a
run that failed partway; an existing release's notes are left as they are.
The tarball artifact lasts a day: after that, re-run all jobs, not the failed
ones. When the workflow file at the tag cannot run, run `Publish` from `main`
with the tag as its input (`gh workflow run publish.yml -f tag=vX.Y.Z`). Only
the workflow file comes from `main`: every job checks out the tag, so
`publish.sh`, the tests and the build are the tag's. A version published by a
dispatch has provenance naming `main`'s commit, not the tag's, so prefer a
re-run of the tag's own run.

## Trusted publishing

npm trusts `publish.yml` for `@decdn/client`. npm matches the workflow by file
name only, and a tag push runs the file as the tag has it, so the limits on
who can publish live in GitHub, outside the file. An org admin sets this up
once:

1. **The `Releases` tag ruleset**, as on decdn/decdn: only org admins create,
   move or delete a `v*` tag. Admins bypass the ruleset's rules, its signature
   rule included, so the signature that counts is the one `publish.sh verify`
   checks against `KEYS` on `origin/main`.

   ```bash
   gh api -X POST repos/decdn/sdk-typescript/rulesets --input - <<'EOF'
   {"name": "Releases", "target": "tag", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
    "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"},
              {"type": "non_fast_forward"}, {"type": "required_signatures"}],
    "bypass_actors": [{"actor_id": null, "actor_type": "OrganizationAdmin", "bypass_mode": "always"}]}
   EOF
   ```

2. **The `release` environment.** Under _Settings → Environments_, it allows
   deployments from the `v*` tag pattern and the `main` branch only, with no
   required reviewers: your signature on the tag is the human gate.

   ```bash
   gh api -X PUT repos/decdn/sdk-typescript/environments/release \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api repos/decdn/sdk-typescript/environments/release/deployment-branch-policies \
     -f name='v*' -f type=tag
   gh api repos/decdn/sdk-typescript/environments/release/deployment-branch-policies \
     -f name=main -f type=branch
   ```

3. **The trusted publisher.** On npmjs.com, under `@decdn/client` → _Settings
   → Trusted publishing_, add GitHub Actions with organisation `decdn`,
   repository `sdk-typescript`, workflow `publish.yml` and environment `release`,
   and allow `npm publish`. npm does not check the fields when you save them,
   and a connection expires unless a publish through it succeeds within two
   days: add it just before a release.

4. **Trusted publishing only.** Once a release has gone up through the
   workflow, set _Settings → Publishing access_ to _Require two-factor
   authentication and disallow tokens_, and revoke any npm token left over, so
   that no token can publish a version.

## The minimum gateway release

The README and `package.json` (`decdn.gatewayFloor`) name the oldest
`decdn gateway` release the SDK works against in the browser and on a public
gateway. Raise both in the same PR as any change that relies on newer gateway
behaviour, and check them before every release: an SDK whose floor names an
unreleased gateway does not ship. The `Release gateways` workflow runs the
contract suite against the floor and the latest decdn release; it is green
before a release. The first floor is
the release that carries
[cross-origin reads](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md#cross-origin-reads).
