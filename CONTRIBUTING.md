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
against the real binary in decdn's `anvil-e2e-sdk` CI job
([`gateway_sdk.rs`](https://github.com/decdn/decdn/blob/main/crates/e2e/tests/gateway_sdk.rs)),
which checks out this repo's `main`. So:

- A gateway change the SDK can observe lands in decdn together with a PR here
  that updates the fake and the suite. Until that PR merges, decdn's
  `anvil-e2e-sdk` fails.
- A change here that the real gateway does not do fails `anvil-e2e-sdk` on
  the next decdn run. Run it locally before merging a contract change:

  ```bash
  # in a decdn checkout, with anvil and forge on PATH
  cargo build -p decdn-cli -p decdn-node
  DECDN_SDK_DIR=/path/to/sdk-typescript \
    cargo nextest run -p decdn-e2e --features anvil-e2e,sdk-e2e --test gateway_sdk
  ```

The fixtures in `test/fixtures` are pinned on the Rust side too
(`a_fixed_grant_encodes_to_a_pinned_token`,
`a_fixed_pointer_signs_to_a_pinned_signature`): change both together.

## Releases

See [RELEASING.md](RELEASING.md).
