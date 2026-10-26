# Contributing to @decdn/client

The SDK is a pure-TypeScript client over the `decdn gateway`'s HTTP contract
([appendix-gateway](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md)).
The contract, not this repo, is the source of truth: when the SDK and the
gateway disagree, the gateway's spec decides.

## Setup

Node.js 20.19+ and pnpm (`corepack enable`, or the version in
`packageManager`):

```bash
pnpm install --frozen-lockfile
pnpm lint            # eslint, prettier --check, tsc --noEmit
pnpm test            # unit tests, script tests, contract suite against the fake gateway
pnpm build           # dist/: ESM + CJS bundles and declarations
pnpm exec playwright install chromium-headless-shell
pnpm test:browser    # Chromium smoke run against the fake gateway
```

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/).
A user-visible change adds a `CHANGELOG.md` entry by hand.

## The fake gateway and the contract run

`test/fake-gateway.ts` reproduces the gateway's statuses, headers and JSON
bodies. The contract suite (`test/contract`) runs against it here, and
against the real binary in two places: decdn's `SDK contract` workflow runs
it at the commit decdn pins (`.github/sdk-typescript.sha` in decdn, through
[`gateway_sdk.rs`](https://github.com/decdn/decdn/blob/main/crates/e2e/tests/gateway_sdk.rs)),
and this repo's `Release gateways` workflow runs it against released decdn
gateways (below). So:

- A gateway change the SDK can observe needs a PR here first, which updates
  the fake and the suite. The decdn PR then moves its pin to that commit, in
  the same change as the gateway.
- A contract change here must pass against the real gateway before it merges.
  `scripts/decdn-contract.sh --ref <decdn ref>` runs it locally against any
  decdn branch, and `--tag` against a release.

The fixtures in `test/fixtures` are pinned on the Rust side too
(`a_fixed_grant_encodes_to_a_pinned_token`,
`a_fixed_pointer_signs_to_a_pinned_signature`): change both together.

## Release gateways

The `Release gateways` workflow (`.github/workflows/gateway-releases.yml`)
runs the contract suite against released decdn gateways: the floor in
`package.json` (`decdn.gatewayFloor`) and the latest release. It runs on a
change to the SDK, the suite or the fake, weekly, and on dispatch, where a
decdn branch or commit can be added. Each run goes through
`scripts/decdn-contract.sh`, which you can run locally on Linux x86_64, with
`git`, `gpg`, `curl`, `cargo`, `cargo-nextest`, `anvil` and `forge` on `PATH`:

```bash
pnpm install --frozen-lockfile --ignore-scripts
scripts/decdn-contract.sh --tag v0.3.0     # a release: signed binaries, verified against KEYS
scripts/decdn-contract.sh --ref main       # any decdn ref, built from source
```

The script runs decdn's harness from the same tag or ref, so the fixture file
it writes (`DECDN_CONTRACT`) is a contract between that harness and this
suite: a suite change must still accept what the floor's harness writes, or
raise the floor.

## Releases

See [RELEASING.md](RELEASING.md).
