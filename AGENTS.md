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
pnpm test:browser    # Chromium smoke (needs playwright's chromium-headless-shell)
```

## Rules

- **The fake gateway mirrors the real one.** `test/fake-gateway.ts` must
  match the gateway's statuses, headers and JSON shapes the SDK reads. The
  contract suite in `test/contract` also runs against the real binary in
  decdn's `anvil-e2e-sdk` job, which checks out this repo's `main`; a change
  here the gateway does not do turns decdn's CI red. See CONTRIBUTING.md.
- **Verification is the product.** A whole body named by hash is hashed as
  it streams (`src/verify.ts`); only a window the caller asked for, or a page
  the gateway renders, goes unhashed. Never downgrade `verified` on a
  gateway's say-so.
- **u64 values are `bigint`.** Namespaces, seq, caps and expiries exceed
  2^53; JSON from the gateway goes through `parseWithBigInts` (`src/http.ts`).
- **Pinned vectors.** `test/fixtures/{capability,pointer}.json` are pinned by
  Rust tests in decdn; change both sides together.
- **Present tense.** Comments and docs describe what the code does, not its
  history.
- **Conventional commits**, a hand-written `CHANGELOG.md` entry per
  user-visible PR, releases per RELEASING.md (signed `v*` tags, local
  publish, no npm token in CI).
