// What the contract suite runs against. With `DECDN_CONTRACT` set to a JSON
// file, written by decdn's
// https://github.com/decdn/decdn/blob/main/crates/e2e/tests/gateway_sdk.rs,
// a real `decdn gateway` serving the content the file describes; without it,
// the fake gateway over
// HTTP, serving the same shapes. Every request goes through `hostFetch` to
// the listener, with the URL's host as `Host`.
import { readFileSync } from "node:fs";
import {
  DecdnClient,
  parseCapability,
  type PointerDomain,
} from "../../src/index.js";
import { FakeGateway } from "../fake-gateway.js";
import capabilityFixture from "../fixtures/capability.json" with { type: "json" };
import pointerFixture from "../fixtures/pointer.json" with { type: "json" };
import { hostFetch } from "../support/host-fetch.js";

/** The fixture file's shape: every byte string hex, every u64 decimal. */
interface FixtureFile {
  mode: "public" | "loopback";
  /** The URL the SDK opens: `http://decdn.test` (public) or `http://127.0.0.1:<port>`. */
  gatewayUrl: string;
  /** `host:port` every request connects to. */
  connect: string;
  token?: string;
  host?: string;
  /** A `dcap1:` issued to a delegate the gateway holds, not yet registered (loopback). */
  capability?: string;
  /** The bundle's manifest hash, and its files. */
  bundle: string;
  files: Record<string, string>;
  /** A raw blob, and its bytes. */
  blob: string;
  blobBytes: string;
  /** A namespace the key owns on the registry (public). */
  pointer?: {
    chainId: string;
    publisherRegistry: string;
    namespace: string;
    privateKey: string;
  };
}

export interface Contract {
  real: boolean;
  mode: "public" | "loopback";
  gatewayUrl: string;
  fetch: typeof fetch;
  token?: string;
  host?: string;
  capability?: string;
  bundle: string;
  files: Record<string, Uint8Array>;
  blob: string;
  blobBytes: Uint8Array;
  pointer?: PointerDomain & { namespace: bigint; privateKey: string };
  /** A client on the gateway with the fixture's credentials. */
  open(extra?: Parameters<typeof DecdnClient.open>[0]): Promise<DecdnClient>;
  close(): Promise<void>;
}

const fromHex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

/** Deterministic bytes, distinct per seed (xorshift32). */
function bytes(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function fake(
  mode: "public" | "loopback",
): Promise<FixtureFile & { close(): Promise<void> }> {
  const gw = new FakeGateway({
    mode,
    host: mode === "public" ? "decdn.test" : "127.0.0.1:8484",
  });
  const blobBytes = bytes(64 * 1024, 0x0b10b);
  const blob = gw.addBlob(blobBytes);
  const files: Record<string, Uint8Array> = {
    "a.txt": new TextEncoder().encode("hello from the sdk contract\n"),
    "index.html": new TextEncoder().encode(
      `<a href="decdn:${blob}">blob</a>\n`,
    ),
    "data.bin": bytes(256 * 1024, 0xda7a),
  };
  const manifest = gw.addBundle(files);
  const listener = await gw.listen();
  const file: FixtureFile = {
    mode,
    gatewayUrl: gw.url,
    connect: listener.address,
    bundle: manifest.hash,
    files: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [
        k,
        Buffer.from(v).toString("hex"),
      ]),
    ),
    blob,
    blobBytes: Buffer.from(blobBytes).toString("hex"),
  };
  if (mode === "public") {
    gw.pointerDomain = {
      chainId: pointerFixture.chainId,
      publisherRegistry: pointerFixture.publisherRegistry,
    };
    gw.owners.set(7n, pointerFixture.address.toLowerCase());
    file.pointer = {
      chainId: String(pointerFixture.chainId),
      publisherRegistry: pointerFixture.publisherRegistry,
      namespace: "7",
      privateKey: pointerFixture.privateKey,
    };
  } else {
    file.token = gw.token;
    file.host = "example.com";
    file.capability = capabilityFixture.token;
    gw.delegates.set(
      parseCapability(capabilityFixture.token).signer.toLowerCase(),
      undefined,
    );
  }
  return { ...file, close: listener.close };
}

/** The gateway the contract suite runs against in `mode`, or `undefined` when a real run is in the other mode. */
export async function contract(
  mode: "public" | "loopback",
): Promise<Contract | undefined> {
  const path = process.env.DECDN_CONTRACT;
  let file: FixtureFile;
  let close = async () => {};
  if (path !== undefined && path !== "") {
    file = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
    if (file.mode !== mode) return undefined;
  } else {
    const f = await fake(mode);
    file = f;
    close = f.close;
  }
  const fetch = hostFetch(file.connect);
  const out: Contract = {
    real: path !== undefined && path !== "",
    mode,
    gatewayUrl: file.gatewayUrl,
    fetch,
    bundle: file.bundle,
    files: Object.fromEntries(
      Object.entries(file.files).map(([k, v]) => [k, fromHex(v)]),
    ),
    blob: file.blob,
    blobBytes: fromHex(file.blobBytes),
    open: (extra = {}) =>
      DecdnClient.open({
        gatewayUrl: file.gatewayUrl,
        fetch,
        ...(file.token === undefined ? {} : { token: file.token }),
        ...(file.host === undefined ? {} : { host: file.host }),
        ...(out.pointer === undefined ? {} : { pointer: out.pointer }),
        ...extra,
      }),
    close,
  };
  if (file.token !== undefined) out.token = file.token;
  if (file.host !== undefined) out.host = file.host;
  if (file.capability !== undefined) out.capability = file.capability;
  if (file.pointer !== undefined) {
    out.pointer = {
      chainId: BigInt(file.pointer.chainId),
      publisherRegistry: file.pointer.publisherRegistry,
      namespace: BigInt(file.pointer.namespace),
      privateKey: file.pointer.privateKey,
    };
  }
  return out;
}
