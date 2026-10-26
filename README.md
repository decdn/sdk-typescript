# @decdn/client

TypeScript client for [deCDN](https://github.com/decdn/decdn), for Node.js
20.19+ and evergreen browsers. It speaks HTTP to a `decdn gateway`, which pays
for every pull and verifies it, and it hashes the bytes again with BLAKE3
wherever it holds a whole blob named by its hash. No native code, no iroh, no
wallet library.

```sh
pnpm add @decdn/client
```

| Gateway                                                  | Where it runs                                                     | Who pays                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| Public (`decdn gateway --public-url https://decdn.link`) | Node or any web page                                              | The operator's pool, within a daily allowance     |
| Loopback (`decdn gateway`, `http://127.0.0.1:8484`)      | Node with the gateway token, or a page on one of its site origins | The capability registered for the requesting host |

The gateway's HTTP contract is
[appendix-gateway](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md);
bundles and their manifests are
[appendix-bundles](https://github.com/decdn/decdn/blob/main/adr/appendix-bundles.md).

## Compatibility

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

## Verification

`get` takes `verify: "auto" | true | false` (default `"auto"`, or the
client's own default from `open`). `response.verified` says what happened:

| Request                     | `verified`  | How                                                                                                              |
| --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| A blob by hash              | `true`      | The whole body hashes to the URI's hash.                                                                         |
| A bundle entry              | `true`      | The client reads the bundle manifest (once per client, itself verified) and the body hashes to the entry's hash. |
| A page or stylesheet entry  | `true`      | A site rewrites HTML and CSS as it serves them, so the client fetches these by their entry hash instead.         |
| A `range` of a bundle entry | `"skipped"` | A window does not hash to anything. A blob has no declared size, so a range on one is refused with `CONFIG`.     |
| A bundle's index or listing | `"skipped"` | The gateway renders it.                                                                                          |
| Any, with `verify: false`   | `false`     | Nothing is hashed and no manifest is read.                                                                       |

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
| `HASH_MISMATCH`, `TRUNCATED`                                                                               | The body does not hash to its hash, or ends early                                                           |                                 |
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

## Helpers

`parseUri` and `formatUri` follow the Rust client's `decdn:` grammar
exactly. `hashToBase32` and `base32ToHash` convert a hash to its site label.
`blake3Hex` and `createBlake3` hash. `parseManifest` reads a v1 manifest.
`client.manifest`, `client.resolve`, `client.head`, `client.siteUrl` and
`client.namespaceUrl` read and name content without fetching it whole.
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
([`gateway_sdk.rs`](https://github.com/decdn/decdn/blob/main/crates/e2e/tests/gateway_sdk.rs)),
so the two cannot drift apart. See [CONTRIBUTING.md](CONTRIBUTING.md).
Releases are cut from signed `v*` tags ([RELEASING.md](RELEASING.md)).
