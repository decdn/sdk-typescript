# Changelog

All notable changes to `@decdn/client` are documented in this file, one entry
per PR. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`@decdn/client`, a TypeScript client over the decdn gateway.** A
  pure-TypeScript package for Node.js 20.19+ and browsers that speaks HTTP to
  a public or loopback `decdn gateway`, or runs in a page on a site origin.
  It hashes every whole blob and bundle entry it fetches with BLAKE3 as it
  streams (entries against their verified manifest), maps every gateway
  refusal to a typed error with its `Retry-After` and fallback `decdn:` URI,
  drives the loopback delegate and capability API, and signs namespace
  pointers (EIP-712, raw key or any typed-data signer). Browser and public
  use need the gateway release that answers every origin.

### Fixed

- **Site pages reach a loopback gateway named by URL.** On a site origin,
  `open({ gatewayUrl })` with a loopback URL gives a `loopback` client for the
  delegate and capability API, instead of a `site` client that refuses it.
- **A page's own paths keep their query.** `get("/app.js?v=2")` on a site
  requests `/app.js?v=2`, and carries no `?ns=`: the site's host names the
  namespace.
- **An entry served as HTML or CSS under another name comes by its hash.**
  The client knows by name which entries a site rewrites. When a site, or a
  server in front of it, answers any other verified entry with HTML or CSS,
  the client fetches it again by its entry hash and verifies it, keeping the
  site's `contentType`.
- **Aborts surface as aborts.** Aborting a `get` while its body streams
  rejects with the signal's reason, not `TRUNCATED`; `retry: true` does not
  wait out `Retry-After` once the signal aborts, and leaves no listener on it.
- **A body past its bound fails.** A whole entry longer than its manifest
  size, or a window longer than the range asked for, ends with `TRUNCATED`.
- **A failed manifest read leaves a newer one cached.** After an eviction,
  a failing read of a hash keeps the read of it that replaced it.
- **Pointer integers are checked.** A `chainId` that is not a uint256 of at
  least 1, and a `number` namespace, seq or chain id that is not a safe
  integer, fail with `CONFIG`, not a signature for another domain or a
  `RangeError`.
- **`@decdn/client/node` has types under `moduleResolution: "bundler"`.**
  TypeScript's `bundler` resolution, the default in Vite and Next.js
  templates, does not set the `node` condition; a type-only `types` fallback
  after the `node` branch gives it declarations without
  `customConditions: ["node"]`. The entry point has JavaScript only under
  `node`: a browser bundle that imports it type-checks but fails to build.
