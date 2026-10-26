/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The bytes of an even-length hex string, or `undefined` if it is not hex. */
export function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Whether `s` is a BLAKE3 hash spelled as 64 hex characters. */
export function isHash(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}
