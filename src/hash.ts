import { blake3 } from "@noble/hashes/blake3.js";
import { toHex } from "./hex.js";

/** The BLAKE3 hash of `bytes`, as 64 lowercase hex characters. */
export function blake3Hex(bytes: Uint8Array): string {
  return toHex(blake3(bytes));
}

/** An incremental BLAKE3 hasher, for bytes that arrive in chunks. */
export interface Blake3Hasher {
  update(chunk: Uint8Array): void;
  /** The hash of every chunk so far, as 64 lowercase hex characters. */
  hex(): string;
}

/** A new incremental BLAKE3 hasher. */
export function createBlake3(): Blake3Hasher {
  const state = blake3.create();
  return {
    update(chunk) {
      state.update(chunk);
    },
    hex() {
      return toHex(state.digest());
    },
  };
}
