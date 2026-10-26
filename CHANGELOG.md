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

- **`@decdn/client/node` has types under `moduleResolution: "bundler"`.**
  TypeScript's `bundler` resolution, the default in Vite and Next.js
  templates, does not set the `node` condition; a type-only `types` fallback
  after the `node` branch gives it declarations without
  `customConditions: ["node"]`. The entry point has JavaScript only under
  `node`: a browser bundle that imports it type-checks but fails to build.
