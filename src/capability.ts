// `dcap1:` capability tokens, as crates/incentive/src/capability_grant.rs
// writes them: `dcap1:` + base64url (no padding) of the postcard encoding of
// `{pool_id: [u8;32], signer: [u8;20], spending_cap: u64, expiry: u64,
// owner_signature: Vec<u8>}`. Postcard writes a byte string as a varint
// length and the bytes, and an integer as a LEB128 varint.
import { DecdnError } from "./errors.js";
import { toHex } from "./hex.js";

const PREFIX = "dcap1:";
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A pool owner's spending grant to a delegate signer. */
export interface Capability {
  /** The on-chain pool, `0x` + 64 hex. */
  poolId: string;
  /** The delegate voucher-signing address, `0x` + 40 hex. */
  signer: string;
  /** Cumulative spend ceiling in USDC base units. */
  spendingCap: bigint;
  /** Unix-seconds expiry. */
  expiry: bigint;
  /** The owner's raw EIP-712 signature, `0x` + hex. */
  ownerSignature: string;
}

function bad(message: string): DecdnError {
  return new DecdnError("BAD_CAPABILITY", message);
}

function fromBase64Url(body: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of body) {
    const v = B64URL.indexOf(c);
    if (v < 0) throw bad("capability token body is not valid base64url");
    buffer = ((buffer << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  if (body.length % 4 === 1 || (buffer & ((1 << bits) - 1)) !== 0) {
    throw bad("capability token body is not valid base64url");
  }
  return new Uint8Array(out);
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = this.bytes[this.at++];
      if (b === undefined) throw truncated();
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (value >= 1n << 64n) throw truncated();
        return value;
      }
    }
    throw truncated();
  }

  bytesOf(len?: number): Uint8Array {
    const n = Number(this.varint());
    if (len !== undefined && n !== len) throw truncated();
    if (this.at + n > this.bytes.length) throw truncated();
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  done(): boolean {
    return this.at === this.bytes.length;
  }
}

function truncated(): DecdnError {
  return bad("capability token payload is malformed (truncated or corrupt)");
}

/** Decode a `dcap1:` token. Throws `BAD_CAPABILITY` for anything else. */
export function parseCapability(token: string): Capability {
  if (!token.startsWith(PREFIX)) {
    throw bad("not a dcap1 capability token (missing the `dcap1:` prefix)");
  }
  const r = new Reader(fromBase64Url(token.slice(PREFIX.length)));
  const capability: Capability = {
    poolId: `0x${toHex(r.bytesOf(32))}`,
    signer: `0x${toHex(r.bytesOf(20))}`,
    spendingCap: r.varint(),
    expiry: r.varint(),
    ownerSignature: `0x${toHex(r.bytesOf())}`,
  };
  if (!r.done()) throw truncated();
  return capability;
}
