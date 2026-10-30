# AGENTS.md

`@decdn/client`: a pure-TypeScript npm package that speaks HTTP to a
`decdn gateway` (public, loopback, or from a page on a site origin), for
Node.js 20.19+ and evergreen browsers. No native code, no iroh.

## Source of truth

The gateway's HTTP contract is
[`decdn/adr/appendix-gateway.md`](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md),
implemented in decdn's `crates/cli/src/commands/gateway.rs`. Every technical
claim in this repo's docs cites decdn's ADRs by absolute GitHub URL. If the
SDK and the gateway disagree, fix the SDK.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint            # eslint + prettier --check + tsc --noEmit
pnpm test            # unit + script + contract (fake gateway) tests
pnpm build           # dist/ via scripts/build.mjs (esbuild ESM/CJS + tsc d.ts)
scripts/check-package.sh  # after the build: publint + arethetypeswrong
pnpm test:browser    # Chromium smoke (needs playwright's chromium-headless-shell)
```

## Rules

- **The fake gateway mirrors the real one.** `test/fake-gateway.ts` must
  match the gateway's statuses, headers and JSON shapes the SDK reads. The
  contract suite in `test/contract` also runs against the real binary: in
  decdn's `SDK contract` workflow, at the commit decdn pins, and here against
  released gateways. A change the gateway does not do fails both. See
  CONTRIBUTING.md.
- **Verification is the product.** A whole body named by hash is hashed as
  it streams (`src/verify.ts`); only a window the caller asked for, or a page
  the gateway renders, goes unhashed. Never downgrade `verified` on a
  gateway's say-so.
- **u64 values are `bigint`.** Namespaces, seq, caps and expiries exceed
  2^53; JSON from the gateway goes through `parseWithBigInts` (`src/http.ts`).
- **Released gateways.** The contract suite also runs against the floor in
  `package.json` (`decdn.gatewayFloor`) and the latest decdn release
  (`scripts/decdn-contract.sh`, `.github/workflows/gateway-releases.yml`).
  The fixture file decdn's harness writes is a contract: a suite change must
  still read what the floor's harness writes, or raise the floor.
- **Pinned vectors.** `test/fixtures/{capability,pointer}.json` are pinned by
  Rust tests in decdn; change both sides together.
- **Present tense.** Comments and docs describe what the code does, not its
  history.
- **Conventional commits** (commitlint checks commit messages in the
  `commit-msg` hook; `.github/workflows/pr-title.yml` checks PR titles). PRs
  are squash-merged, so the PR title is the changelog entry:
  `scripts/release.sh` renders `CHANGELOG.md` sections with git-cliff
  (`cliff.toml`). Never edit `CHANGELOG.md` by hand or add an `[Unreleased]`
  section. Releases per RELEASING.md (`scripts/release.sh` cuts the signed
  `v*` tag on `main`; local publish, no npm token in CI).
