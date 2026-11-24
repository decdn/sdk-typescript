// `dcap1:` tokens for tests, in the layout `parseCapability` reads
// (src/capability.ts), with a dummy owner signature.

function varint(n: bigint): number[] {
  const out: number[] = [];
  do {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    out.push(n === 0n ? b : b | 0x80);
  } while (n !== 0n);
  return out;
}

/** A `dcap1:` token for `pool` (`0x` + 64 hex) issued to `signer` (`0x` + 40 hex). */
export function dcap(args: {
  pool: string;
  signer: string;
  cap?: bigint;
  expiry?: bigint;
}): string {
  const hex = (s: string) => [...Buffer.from(s.slice(2), "hex")];
  const bytes = [
    32,
    ...hex(args.pool),
    20,
    ...hex(args.signer),
    ...varint(args.cap ?? 1_000_000n),
    ...varint(args.expiry ?? 1_900_000_000n),
    65,
    ...new Array<number>(65).fill(1),
  ];
  return `dcap1:${Buffer.from(bytes).toString("base64url")}`;
}
