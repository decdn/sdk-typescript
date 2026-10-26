# Releasing @decdn/client

Releases are cut locally from a signed tag. CI builds and tests, but holds no
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
`npm login`; the script uses that session.

`KEYS` holds the maintainer keys a release tag may be signed by. It is a
verbatim copy of [decdn's `KEYS`](https://github.com/decdn/decdn/blob/main/KEYS):
a key added or revoked there is added or revoked here in the same sitting.

## Cutting a version

1. In a PR, set `version` in `package.json`, add the `CHANGELOG.md` entry, and
   check the README's minimum gateway release (see below). Merge it with CI
   green.
2. From `main`, tag that commit **signed** and push the tag:

   ```bash
   git tag -s v0.1.0 -m "@decdn/client 0.1.0"
   git push origin v0.1.0
   ```

3. Rehearse, then publish:

   ```bash
   DECDN_NPM_DRY_RUN=1 scripts/publish.sh v0.1.0
   scripts/publish.sh v0.1.0
   ```

`publish.sh` refuses a tag that is not `v<semver>`, verifies the tag against
`KEYS` (and against `DECDN_SIGNING_KEY` when set) and against `origin`, checks
the tag out into a detached worktree, checks that `package.json` names
`@decdn/client` at the tag's version, and runs install, lint, tests and the
build there before `pnpm publish --access public`. A prerelease
(`v0.2.0-rc.1`) goes to the `next` dist-tag, so a plain install keeps the
latest release.

**This step is not re-runnable.** An npm version is immutable: it can never be
published again, even after `npm unpublish`. A broken release is fixed by the
next patch version and `npm deprecate` on the broken one.

## The minimum gateway release

The README names the oldest `decdn gateway` release the SDK works against in
the browser and on a public gateway. Raise it in the same PR as any change
that relies on newer gateway behaviour, and check it before every release: an
SDK whose floor names an unreleased gateway does not ship. The first floor is
the release that carries
[cross-origin reads](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md#cross-origin-reads).
