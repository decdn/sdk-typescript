<!-- markdownlint-disable-file MD033 MD041 -->
<p align="center">
  <a href="https://decdn.org">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/decdn/decdn/main/.github/assets/wordmark-dark.svg">
      <img alt="deCDN" src="https://raw.githubusercontent.com/decdn/decdn/main/.github/assets/wordmark-light.svg" width="150">
    </picture>
  </a>
</p>

<h1 align="center">@decdn/client</h1>

<h3 align="center">TypeScript client for deCDN: verified fetches, bundles, loopback capabilities and namespace pointers.</h3>

<p align="center">
  <a href="https://github.com/decdn/sdk-typescript/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/decdn/sdk-typescript/ci.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="https://github.com/decdn/sdk-typescript/actions/workflows/codeql.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/decdn/sdk-typescript/codeql.yml?branch=main&label=CodeQL&logo=github" alt="CodeQL"></a>
  <a href="https://github.com/decdn/sdk-typescript/actions/workflows/gateway-releases.yml"><img src="https://img.shields.io/github/actions/workflow/status/decdn/sdk-typescript/gateway-releases.yml?branch=main&label=gateway%20releases&logo=github" alt="Contract suite against released gateways"></a>
  <a href="https://www.npmjs.com/package/@decdn/client"><img src="https://img.shields.io/npm/v/@decdn/client?logo=npm" alt="npm"></a>
  <a href="https://bundlejs.com/?q=%40decdn%2Fclient"><img src="https://img.shields.io/bundlejs/size/@decdn/client?label=minzip" alt="Bundle size"></a>
  <a href="https://www.npmjs.com/package/@decdn/client"><img src="https://img.shields.io/npm/types/@decdn/client?logo=typescript&logoColor=white" alt="Types: TypeScript"></a>
  <a href="#compatibility"><img src="https://img.shields.io/node/v/@decdn/client?logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="#compatibility"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdecdn%2Fsdk-typescript%2Fmain%2Fpackage.json&query=%24.decdn.gatewayFloor&label=decdn%20gateway&prefix=%E2%89%A5%20v" alt="decdn gateway floor"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://www.conventionalcommits.org"><img src="https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow" alt="Conventional Commits"></a>
  <a href="https://discord.gg/vVbNswKVGX"><img src="https://img.shields.io/badge/chat-Discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<h3 align="center">
  <a href="https://decdn.org">Website</a> ·
  <a href="https://docs.decdn.org">Docs</a> ·
  <a href="https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md">Gateway spec</a> ·
  <a href="https://github.com/decdn/decdn">deCDN</a> ·
  <a href="https://discord.gg/vVbNswKVGX">Discord</a>
</h3>

TypeScript client for [deCDN](https://github.com/decdn/decdn), for Node.js
20.19+ and evergreen browsers. It speaks HTTP to a `decdn gateway`, which pays
for every pull and verifies it, and it hashes the bytes again with BLAKE3
wherever it holds a whole blob named by its hash. No native code, no iroh, no
wallet library.

- **Verified streaming.** A blob, or a whole bundle entry, is hashed with
  BLAKE3 as it streams; a body that does not hash to its name ends with
  `HASH_MISMATCH` instead of `done`. Ranges and rendered pages are
  `"skipped"` ([Verification](#verification)).
- **Bundles.** Entries are checked against the bundle manifest, which is
  itself verified and cached per client.
- **Byte ranges** of sized entries, for large files such as model weights. A
  window does not hash to anything, so its `verified` is `"skipped"`.
- **Pages on a site origin.** `DecdnClient.open()` with no URL works from a
  page on a bundle's site origin (`<hash32>.<host>`); a namespace host needs
  `gatewayUrl`.
- **Loopback gateways.** Mint delegate keys and register capabilities on a
  local `decdn gateway`.
- **Namespace pointers.** Point a `PublisherRegistry` namespace at a bundle on
  a public gateway, signing EIP-712 typed data with a private key or a
  viem-style `signTypedData(typedData)` signer.
- **Small and typed.** ESM, CJS and declarations; runtime dependencies
  `@noble/hashes` and `@noble/curves` only; namespaces, seq, caps and expiries
  are `bigint`.

## Contents

- [Install](#install)
- [Gateways](#gateways)
- [Compatibility](#compatibility)
- [Public gateway](#public-gateway)
- [Loopback gateway (Node)](#loopback-gateway-node)
- [Pages on a site origin](#pages-on-a-site-origin)
- [Verification](#verification)
- [Errors](#errors)
- [Namespace pointers](#namespace-pointers)
- [API at a glance](#api-at-a-glance)
- [Development](#development)
- [License](#license)

## Install

```sh
pnpm add @decdn/client
# or
npm install @decdn/client
# or
yarn add @decdn/client
```

## Gateways

The client talks to one of two kinds of gateway:

| Gateway                                                  | Where it runs                                                     | Who pays                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| Public (`decdn gateway --public-url https://decdn.link`) | Node or any web page                                              | The operator's pool, within a daily allowance     |
| Loopback (`decdn gateway`, `http://127.0.0.1:8484`)      | Node with the gateway token, or a page on one of its site origins | The capability registered for the requesting host |

The gateway's HTTP contract is
[appendix-gateway](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md);
bundles and their manifests are
[appendix-bundles](https://github.com/decdn/decdn/blob/main/adr/appendix-bundles.md).

## Compatibility

Node.js 20.19 or later, and evergreen browsers.

| `@decdn/client` | `decdn gateway`                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1             | v0.3.0 or later for browser pages and public gateways ([cross-origin reads](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md#cross-origin-reads)); any loopback gateway from Node |

CI runs the contract suite against the floor and the latest decdn release, with
each release's signed binaries ([CONTRIBUTING.md](CONTRIBUTING.md#release-gateways)).

## Public gateway

```ts
import { DecdnClient } from "@decdn/client";

const client = await DecdnClient.open({ gatewayUrl: "https://decdn.link" });

// A blob, streamed and hashed as it arrives.
const blob = await client.get("decdn:<64 hex>");
blob.verified; // true
const bytes = await blob.bytes(); // rejects with HASH_MISMATCH on bad bytes

// One file of a bundle, checked against the bundle's manifest.
const page = await client.get("decdn:<manifest hash>/docs/index.html");
const text = await page.text();

// A window of a sized entry: 206, not verifiable.
const part = await client.get("decdn:<manifest hash>/model.bin", {
  range: { offset: 0, length: 1 << 20 },
});
part.contentRange; // { offset, length, size }
```

The same code runs in a browser on any origin: a public gateway answers every
origin, `Range` preflights included.

## Loopback gateway (Node)

A loopback gateway pays with a capability a pool owner issued to one of its
delegate keys. Mint the delegate, have the owner assign it, and register it
for the host your requests name:

```ts
import { DecdnClient } from "@decdn/client";
import { readLoopbackToken } from "@decdn/client/node";

const client = await DecdnClient.open({
  gatewayUrl: "http://127.0.0.1:8484",
  token: await readLoopbackToken(), // ~/.decdn/gateway/token
  host: "example.com", // sent as x-decdn-host
});

const { address } = await client.loopback.delegate();
// The pool owner: decdn pool assign --pool <id> --signer <address> ...
await client.loopback.registerCapability({
  capability: "dcap1:...",
  scope: "example.com",
});

const r = await client.get("decdn:<64 hex>");
```

`client.loopback.capabilities()` lists what the gateway holds. Without a
covering capability a request fails with `PAYMENT_REQUIRED`. A `dcap1:` token
decodes offline with `parseCapability`.

The SDK does not start the gateway. Run it yourself (`decdn gateway`, or the
`decdn/decdn` Docker image). `open()` treats a `localhost`, `127.0.0.1` or
`::1` URL as a loopback gateway; a public gateway you run locally needs
another host name, such as `decdn.localhost`.

## Pages on a site origin

A bundle opened as a website lives on its own origin,
`https://<hash32>.decdn.link/` or `http://<hash32>.localhost:8484/`. A page
there opens the client with no URL:

```ts
const client = await DecdnClient.open();
client.context; // "site"
const style = await client.get("/css/site.css"); // its own bundle, verified
const other = await client.get("decdn:<64 hex>"); // through /_decdn/
```

On a namespace host (`https://<ns>.decdn.link/`), pass the gateway URL so
the host is recognised: `DecdnClient.open({ gatewayUrl: "https://decdn.link" })`.
The bundle there is whatever the pointer names, so the page's own paths are
not verified and `manifest()` needs a hash.

A page on a loopback site origin reaches the gateway's delegate and capability
API with a second client on the gateway itself:
`DecdnClient.open({ gatewayUrl: "http://127.0.0.1:8484" })`. A loopback
`gatewayUrl` opens a `loopback` client from any page; without the token, which
a page cannot send, it reaches that API alone.

## Verification

`get` takes `verify: "auto" | true | false` (default `"auto"`, or the
client's own default from `open`). `response.verified` says what happened:

| Request                     | `verified`  | How                                                                                                                |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| A blob by hash              | `true`      | The whole body hashes to the URI's hash.                                                                           |
| A bundle entry              | `true`      | The client reads the bundle manifest (cached per client, itself verified) and the body hashes to the entry's hash. |
| A page or stylesheet entry  | `true`      | A site rewrites HTML and CSS as it serves them, so the client fetches these by their entry hash instead.           |
| A `range` of a bundle entry | `"skipped"` | A window does not hash to anything. A blob has no declared size, so a range on one is refused with `CONFIG`.       |
| A bundle's index or listing | `"skipped"` | The gateway renders it.                                                                                            |
| Any, with `verify: false`   | `false`     | Nothing is hashed and no manifest is read.                                                                         |

`verify: true` refuses a request that cannot be verified with `CONFIG`.

A verified body is hashed as it streams: `response.body` ends with an error
(`HASH_MISMATCH`, or `TRUNCATED` when the gateway cuts it) instead of `done`,
and `bytes()`, `text()` and `json()` reject. Bytes read before the end are not
yet verified; act on them only once the stream is done.

## Errors

Every failure is a `DecdnError` with a stable `code`:

| Code                                                                                                       | When                                                                                                        | Extra fields                    |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `PAYMENT_REQUIRED`                                                                                         | 402: the allowance is spent, the entry does not fit what is left, or no loopback capability covers the host | `retryAfterSecs`, `fallbackUri` |
| `POOL_UNFUNDED`                                                                                            | 503: the gateway's pool cannot pay                                                                          | `retryAfterSecs`, `fallbackUri` |
| `RANGE_NOT_SATISFIABLE`                                                                                    | 416                                                                                                         | `size`                          |
| `CONFLICT`                                                                                                 | 409: a pointer `seq` that is not newer, a capability already registered                                     | `seq`                           |
| `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `UPSTREAM`, `PAYLOAD_TOO_LARGE`, `UNPROCESSABLE` | 404, 401, 403, 429, 502, 413, 422                                                                           | `status`, `body`                |
| `BAD_URI`                                                                                                  | A `decdn:` URI that does not parse, or 400                                                                  |                                 |
| `HASH_MISMATCH`, `TRUNCATED`                                                                               | The body does not hash to its hash, or is shorter or longer than declared                                   |                                 |
| `MALFORMED_MANIFEST`, `BAD_CAPABILITY`                                                                     | A manifest or `dcap1:` token that does not decode                                                           |                                 |
| `NETWORK`, `CONFIG`, `HTTP`                                                                                | The gateway is unreachable; the client cannot do what was asked; another status                             |                                 |

`fallbackUri` is the canonical `decdn:` URI: fetch it with a paying client of
your own (`decdn get <uri>`), or wait `retryAfterSecs`. The SDK retries
nothing on its own; `get(uri, { retry: true })` waits out one `Retry-After`
and tries once more.

## Namespace pointers

On a public gateway, the owner of a namespace on the `PublisherRegistry`
points it at a bundle, and `https://<ns>.<host>/` serves that bundle:

```ts
const client = await DecdnClient.open({
  gatewayUrl: "https://decdn.link",
  pointer: { chainId: 421614, publisherRegistry: "0x..." },
});
const set = await client.pointer.set({
  namespace: 42n,
  root: "decdn:<manifest hash>/",
  signer: { privateKey: "0x..." }, // or a viem account: anything with signTypedData
});
set.url; // https://42.decdn.link/
```

The pointer is EIP-712 typed data (`pointerTypedData` gives it to a wallet),
`seq` defaults to the current Unix second, and the gateway takes only a `seq`
above the last one it holds from the same signer. The chain id and registry
are the deployment the gateway verifies against.

## API at a glance

| Export                                                                          | What it does                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecdnClient.open(opts?)`                                                       | Opens a client on a public or loopback gateway, or on the site origin a page is served from                                                                           |
| `client.get(uri, opts?)`                                                        | Fetches a blob, a bundle, a bundle entry or a range (or, on a site page, a path of its own bundle) as a `DecdnResponse` (`verified`, `body`, `bytes`, `text`, `json`) |
| `client.head(uri)`                                                              | The size, hash and content type of what a URI names, without its bytes                                                                                                |
| `client.resolve(uri)`                                                           | A URI's kind, hash, bare and site URLs, and its manifest entry (reads the manifest for a bundle or entry)                                                             |
| `client.manifest(hashOrUri?, signal?)`                                          | A bundle's verified manifest, cached per client; on a site page, the page's own bundle when omitted                                                                   |
| `client.siteUrl(uri)`, `client.namespaceUrl(ns)`                                | The site URL of a bundle or entry; the URL a namespace's pointer serves at (`https://<ns>.<host>/`). Neither makes a request                                          |
| `client.loopback.delegate()`                                                    | Mints a delegate key on a loopback gateway, held for 15 minutes unless a capability claims it                                                                         |
| `client.loopback.registerCapability({ capability, scope })`, `.capabilities()`  | Registers a `dcap1:` capability for a scope (`example.com`, `*.example.com` or `*`); lists the capabilities the gateway holds (needs the token)                       |
| `client.pointer.set(args)`                                                      | Signs and publishes a namespace pointer on a public gateway                                                                                                           |
| `pointerTypedData`, `pointerSigningHash`, `signPointer`, `recoverPointerSigner` | The pointer's EIP-712 typed data and signing hash, its signature, and the signer a signature recovers to                                                              |
| `parseUri`, `formatUri`                                                         | Parse and canonically format a `decdn:` URI, following the Rust client's grammar exactly (`BAD_URI` on anything it refuses)                                           |
| `hashToBase32`, `base32ToHash`                                                  | A hash to and from its site label                                                                                                                                     |
| `blake3Hex`, `createBlake3`                                                     | BLAKE3, one-shot and incremental                                                                                                                                      |
| `parseManifest`, `parseCapability`                                              | Decodes a v1 bundle manifest, checking its hash when given one; decodes a `dcap1:` token without checking its signature                                               |
| `DecdnError`                                                                    | Every failure, with a stable `code` ([Errors](#errors))                                                                                                               |
| `readLoopbackToken`, `defaultDataDir`                                           | From `@decdn/client/node`: the loopback gateway's token and data dir (`~/.decdn/gateway`)                                                                             |

Namespaces, sequence numbers, caps and expiries are `bigint`.

## Development

```sh
pnpm install
pnpm lint            # eslint, prettier, tsc
pnpm test            # unit tests and the contract suite against the fake gateway
pnpm test:browser    # Chromium smoke run (pnpm exec playwright install chromium-headless-shell)
pnpm build           # dist/: ESM, CJS and types
```

`test/fake-gateway.ts` reproduces the gateway's HTTP contract. The contract
suite in `test/contract` runs against it by default, and against a real
gateway in decdn's CI
([`sdk_contract.rs`](https://github.com/decdn/decdn/blob/main/crates/e2e/src/sdk_contract.rs)),
so the two cannot drift apart. See [CONTRIBUTING.md](CONTRIBUTING.md).

Releases are cut from signed `v*` tags ([RELEASING.md](RELEASING.md)); the
keys that sign them are in [`KEYS`](KEYS) (`gpg --import KEYS`, then
`git verify-tag vX.Y.Z`).

## License

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE),
at your option.
