# Releasing @decdn/client

Releases are cut locally by `scripts/release.sh` and published from its signed
tag by `scripts/publish.sh`, which uploads to npm and makes the GitHub
release. CI builds and tests, but holds no
npm token and publishes nothing: a `push`-triggered workflow runs the workflow
definition from the pushed ref, so a token reachable from a workflow would be
reachable from any tag anyone with push access could craft.

The SDK speaks HTTP to a `decdn gateway`. It has its own semver; the gateway
release it needs is a compatibility floor, not a shared version.

## One-time setup

npm gives a scoped name to whoever owns the scope. Before the first release,
confirm that the `decdn` npm organisation exists and owns the `@decdn` scope,
and that you are a member with publish rights to it (`npm org ls decdn`). Add
a second maintainer, so the package outlives one account. Log in with
`npm login` and `gh auth login`; `publish.sh` uses both sessions, and the gh
account needs write access to `decdn/sdk-typescript` to make the GitHub
release.

`KEYS` holds the maintainer keys a release tag may be signed by. It is a
verbatim copy of [decdn's `KEYS`](https://github.com/decdn/decdn/blob/main/KEYS):
a key added or revoked there is added or revoked here in the same sitting.

## Cutting a version

A version is cut on `main`, with no release PR, by
[`scripts/release.sh`](scripts/release.sh), a wrapper around `pnpm version` and
[git-cliff](https://git-cliff.org) in the manner of `cargo release`. Publishing
is the separate step after it:

```bash
scripts/release.sh                    # dry run: the new tag and the diff
scripts/release.sh --execute          # bump, changelog, check, commit, tag, push
DECDN_NPM_DRY_RUN=1 scripts/publish.sh v0.2.0   # rehearse, print the notes
scripts/publish.sh v0.2.0                       # npm, then GitHub release
```

The argument is the level: `auto` (the default), `patch`, `minor`, `major` or
an explicit `X.Y.Z`. Without `--execute`, `release.sh` prints the new tag and
the diff it would commit, and changes no file. It:

1. **Checks the tree, the key and the floor.** It runs on a clean `main` equal
   to `origin/main`, with every local `vX.Y.Z` tag on origin, and
   `package.json` at the last release's version. With `--execute`, it signs a
   throwaway commit and verifies it against `KEYS` alone, as `publish.sh`
   verifies the tag. It refuses unless the decdn release `decdn.gatewayFloor`
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
  sign, or one `publish.sh` would refuse, fails before anything is pushed.
- A bypass of the `main` ruleset (an org admin), because the release commit
  goes straight to `main`, where the ruleset's pull-request rule and required
  status checks apply to a direct push too.
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
publish it, then set `version` back to the last release in the next PR:
`release.sh` refuses a `package.json` that is not at the last `vX.Y.Z` tag.
Prerelease tags are not changelog boundaries, so the commits up to the
prerelease fall into the next release's generated section.

`publish.sh` refuses a tag that is not `v<semver>`, verifies the tag against
`KEYS` (and against `DECDN_SIGNING_KEY` when set) and against `origin`, checks
that gh's account can write to `decdn/sdk-typescript`, checks the tag out into
a detached worktree, checks that `package.json` names `@decdn/client` at the
tag's version and that `CHANGELOG.md` has its section, and runs install,
lint, tests and the build there before `pnpm publish --access public`. It
then makes the tag's GitHub release, titled with the tag, its notes the tag's
`CHANGELOG.md` section followed by the npm link and the gateway floor
(`decdn.gatewayFloor`). A prerelease (`v0.2.0-rc.1`) goes to the `next`
dist-tag, so a plain install keeps the latest release; its GitHub release is a
prerelease, never the latest, and with no changelog section its notes are the
npm link and floor alone. A draft release for the tag stops the script before
the upload: publish or delete it first.

**An npm version is published once.** It is immutable: it can never be
published again, even after `npm unpublish`. A broken release is fixed by the
next patch version and `npm deprecate` on the broken one. Running
`publish.sh` again skips the upload when npm has the version and the GitHub
release when it exists, so it finishes a run whose GitHub step failed; an
existing release's notes are left as they are.

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
