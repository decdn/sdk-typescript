// Namespace pointers
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway/pointer.rs):
// an owner-signed EIP-712 record
//
//   Pointer(uint256 namespaceId,bytes32 root,uint64 seq)
//
// under the domain {name: "decdn-pointer", version: "1", chainId,
// verifyingContract: PublisherRegistry}. The gateway takes a 65-byte
// `r‖s‖v` signature with a low `s` only.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { DecdnClient } from "./client.js";
import { DecdnError } from "./errors.js";
import { fromHex, isHash, toHex } from "./hex.js";
import { errorOf, parseWithBigInts, send } from "./http.js";
import { parseUri, SCHEME } from "./uri.js";

/** The chain a pointer is signed for: the EIP-712 domain of `PUT /_pointer`. */
export interface PointerDomain {
  chainId: bigint | number;
  /** The `PublisherRegistry` contract address. */
  publisherRegistry: string;
}

/** A pointer from a namespace to the bundle whose manifest hash is `root`. */
export interface Pointer {
  namespace: bigint;
  /** The bundle's manifest hash, 64 hex characters. */
  root: string;
  seq: bigint;
}

/** The EIP-712 typed data of a pointer, in the shape viem's `signTypedData` takes. */
export interface PointerTypedData {
  domain: {
    name: "decdn-pointer";
    version: "1";
    chainId: bigint;
    verifyingContract: string;
  };
  types: { Pointer: { name: string; type: string }[] };
  primaryType: "Pointer";
  message: { namespaceId: bigint; root: string; seq: bigint };
}

/** Anything that signs EIP-712 typed data: a viem account, or a wallet behind the same call shape. */
export interface TypedDataSigner {
  signTypedData(typedData: PointerTypedData): Promise<string>;
}

/** A signer: a typed-data signer, or a raw secp256k1 key (`0x` hex or bytes). */
export type PointerSigner =
  TypedDataSigner | { privateKey: string | Uint8Array };

const N = secp256k1.Point.CURVE().n;
const U64_MAX = (1n << 64n) - 1n;
const enc = new TextEncoder();

function word(n: bigint): Uint8Array {
  return fromHex(n.toString(16).padStart(64, "0")) ?? new Uint8Array(32);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const DOMAIN_TYPE = keccak_256(
  enc.encode(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
const POINTER_TYPE = keccak_256(
  enc.encode("Pointer(uint256 namespaceId,bytes32 root,uint64 seq)"),
);

function bad(message: string): DecdnError {
  return new DecdnError("CONFIG", message);
}

function address(s: string): Uint8Array {
  const bytes = /^0x[0-9a-fA-F]{40}$/.test(s) ? fromHex(s.slice(2)) : undefined;
  if (bytes === undefined) throw bad(`not an address: ${s}`);
  return bytes;
}

function checked(p: Pointer): Uint8Array {
  if (p.namespace < 1n || p.namespace > U64_MAX)
    throw bad("a namespace id is a u64 of at least 1");
  if (p.seq < 0n || p.seq > U64_MAX) throw bad("a pointer seq is a u64");
  const root = p.root.startsWith("0x") ? p.root.slice(2) : p.root;
  const bytes = isHash(root) ? fromHex(root) : undefined;
  if (bytes === undefined) throw bad(`not a manifest hash: ${p.root}`);
  return bytes;
}

/** The typed data a wallet signs for `pointer`. */
export function pointerTypedData(
  domain: PointerDomain,
  pointer: Pointer,
): PointerTypedData {
  const root = checked(pointer);
  address(domain.publisherRegistry);
  return {
    domain: {
      name: "decdn-pointer",
      version: "1",
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.publisherRegistry,
    },
    types: {
      Pointer: [
        { name: "namespaceId", type: "uint256" },
        { name: "root", type: "bytes32" },
        { name: "seq", type: "uint64" },
      ],
    },
    primaryType: "Pointer",
    message: {
      namespaceId: pointer.namespace,
      root: `0x${toHex(root)}`,
      seq: pointer.seq,
    },
  };
}

function digest(domain: PointerDomain, pointer: Pointer): Uint8Array {
  const root = checked(pointer);
  const separator = keccak_256(
    concat(
      DOMAIN_TYPE,
      keccak_256(enc.encode("decdn-pointer")),
      keccak_256(enc.encode("1")),
      word(BigInt(domain.chainId)),
      concat(new Uint8Array(12), address(domain.publisherRegistry)),
    ),
  );
  const struct = keccak_256(
    concat(POINTER_TYPE, word(pointer.namespace), root, word(pointer.seq)),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), separator, struct));
}

/** The EIP-712 signing hash of `pointer`, `0x` + 64 hex. */
export function pointerSigningHash(
  domain: PointerDomain,
  pointer: Pointer,
): string {
  return `0x${toHex(digest(domain, pointer))}`;
}

/** A 65-byte `r‖s‖v` signature with a low `s` and `v` of 27 or 28, as the gateway takes it. */
function normalised(signature: string): string {
  const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (!/^[0-9a-fA-F]{130}$/.test(hex))
    throw new DecdnError("CONFIG", "the signer returned no 65-byte signature");
  const r = hex.slice(0, 64);
  let s = BigInt(`0x${hex.slice(64, 128)}`);
  let parity = parseInt(hex.slice(128), 16);
  parity = parity >= 27 ? parity - 27 : parity;
  if (parity !== 0 && parity !== 1)
    throw new DecdnError("CONFIG", "the signature's v is not 0, 1, 27 or 28");
  if (s > N / 2n) {
    s = N - s;
    parity ^= 1;
  }
  return `0x${r.toLowerCase()}${s.toString(16).padStart(64, "0")}${(27 + parity).toString(16)}`;
}

/** Sign `pointer` for `domain` with `signer`. */
export async function signPointer(
  domain: PointerDomain,
  pointer: Pointer,
  signer: PointerSigner,
): Promise<string> {
  if ("privateKey" in signer) {
    const key =
      typeof signer.privateKey === "string"
        ? fromHex(
            signer.privateKey.startsWith("0x")
              ? signer.privateKey.slice(2)
              : signer.privateKey,
          )
        : signer.privateKey;
    if (key === undefined || key.length !== 32)
      throw bad("a private key is 32 bytes");
    const sig = secp256k1.sign(digest(domain, pointer), key, {
      prehash: false,
      lowS: true,
      format: "recovered",
    });
    return normalised(`${toHex(sig.subarray(1))}${toHex(sig.subarray(0, 1))}`);
  }
  return normalised(
    await signer.signTypedData(pointerTypedData(domain, pointer)),
  );
}

/** The lowercase address that signed `pointer` with `signature`; `UNPROCESSABLE` for a malformed or high-`s` one. */
export function recoverPointerSigner(
  domain: PointerDomain,
  pointer: Pointer,
  signature: string,
): string {
  const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const bytes = /^[0-9a-fA-F]{130}$/.test(hex) ? fromHex(hex) : undefined;
  const v = bytes?.[64];
  const malformed = () =>
    new DecdnError("UNPROCESSABLE", "the pointer signature is malformed");
  if (bytes === undefined || v === undefined || (v !== 27 && v !== 28))
    throw malformed();
  if (BigInt(`0x${hex.slice(64, 128)}`) > N / 2n) throw malformed();
  try {
    const recovered = concat(Uint8Array.of(v - 27), bytes.subarray(0, 64));
    const key = secp256k1.recoverPublicKey(recovered, digest(domain, pointer), {
      prehash: false,
    });
    const point = secp256k1.Point.fromBytes(key).toBytes(false);
    return `0x${toHex(keccak_256(point.subarray(1)).subarray(12))}`;
  } catch {
    throw malformed();
  }
}

/** What `pointer.set` stored. */
export interface PointerSet {
  namespace: bigint;
  /** The bundle's manifest hash. */
  root: string;
  seq: bigint;
  /** The namespace's host on the gateway. */
  url: string;
}

/** Namespace pointers on a public gateway. */
export class PointerApi {
  /** @internal */
  constructor(private readonly client: DecdnClient) {}

  /**
   * Sign a pointer from `namespace` to the bundle `root` (`decdn:<hash>/` or
   * its manifest hash) and `PUT` it. `seq` defaults to the current Unix
   * second; the gateway takes only a `seq` above the one it holds from the
   * same signer. The signer must own the namespace on the `PublisherRegistry`
   * of `open({ pointer })`.
   */
  async set(args: {
    namespace: bigint | number;
    root: string;
    seq?: bigint | number;
    signer: PointerSigner;
    signal?: AbortSignal;
  }): Promise<PointerSet> {
    const domain = this.client.pointerDomain;
    if (this.client.context !== "public")
      throw bad("namespace pointers live on a public gateway");
    if (domain === undefined) {
      throw bad(
        "pointer.set needs open({ pointer: { chainId, publisherRegistry } })",
      );
    }
    let root = args.root.startsWith("0x") ? args.root.slice(2) : args.root;
    if (root.startsWith(SCHEME)) {
      const uri = parseUri(root);
      if (uri.kind !== "bundle") {
        throw new DecdnError(
          "BAD_URI",
          "a pointer names a bundle: pass `decdn:<hash>/`, the manifest hash with its trailing slash",
        );
      }
      root = uri.hash;
    } else if (!isHash(root)) {
      throw new DecdnError("BAD_URI", `not a manifest hash: ${args.root}`);
    }
    const pointer: Pointer = {
      namespace: BigInt(args.namespace),
      root: root.toLowerCase(),
      seq:
        args.seq === undefined
          ? BigInt(Math.floor(Date.now() / 1000))
          : BigInt(args.seq),
    };
    const signature = await signPointer(domain, pointer, args.signer);
    const init: RequestInit = {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: `{"namespace":${pointer.namespace},"root":"0x${pointer.root}","seq":${pointer.seq},"signature":"${signature}"}`,
    };
    if (args.signal !== undefined) init.signal = args.signal;
    const response = await send(
      this.client.fetch,
      `${this.client.origin}/_pointer`,
      init,
    );
    if (response.status < 200 || response.status > 299)
      throw await errorOf(response);
    return parseWithBigInts(await response.text(), [
      "namespace",
      "seq",
    ]) as PointerSet;
  }
}
