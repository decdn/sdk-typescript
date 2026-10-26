// Site labels: a bundle's manifest hash as RFC 4648 base32, lowercase and
// unpadded (52 characters, inside the 63-character DNS label limit), as the
// gateway writes them (crates/cli/src/commands/gateway/site.rs).
import { DecdnError } from "./errors.js";
import { fromHex, isHash, toHex } from "./hex.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LABEL_LEN = 52;

/** The site label of a 64-hex-character hash. */
export function hashToBase32(hash: string): string {
  const bytes = isHash(hash) ? fromHex(hash) : undefined;
  if (bytes === undefined)
    throw new DecdnError("BAD_URI", `not a 64-hex-character hash: ${hash}`);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * The hash a canonical site label encodes, as 64 lowercase hex characters, or
 * `undefined` for anything else: the wrong length, uppercase, or nonzero
 * trailing bits (a second spelling the gateway refuses).
 */
export function base32ToHash(label: string): string | undefined {
  if (label.length !== LABEL_LEN || !/^[a-z2-7]+$/.test(label))
    return undefined;
  const out = new Uint8Array(32);
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (const c of label) {
    buffer = ((buffer << 5) | ALPHABET.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return undefined;
  return toHex(out);
}
