# @decdn/client

TypeScript client for [deCDN](https://github.com/decdn/decdn), for Node.js 20.19+
and evergreen browsers. It speaks HTTP to a `decdn gateway`, which pays for and
verifies every pull, and verifies the bytes again with BLAKE3 where it can.

```sh
pnpm add @decdn/client
```

## Pure helpers

```ts
import {
  parseUri,
  formatUri,
  hashToBase32,
  base32ToHash,
  blake3Hex,
  parseManifest,
  parseCapability,
} from "@decdn/client";

const uri = parseUri("decdn:<64 hex>/docs/index.html?ns=42");
// { hash, kind: "entry", path: "docs/index.html", namespace: 42n }
formatUri(uri); // the canonical string
hashToBase32(uri.hash); // the 52-character site label
```

`parseUri` accepts exactly the grammar of the Rust client's `decdn:` URIs.
`parseManifest` reads a v1 bundle manifest, and checks its hash when given one.
`parseCapability` decodes a `dcap1:` token from `decdn pool assign`.

Every failure is a `DecdnError` with a stable `code`.
