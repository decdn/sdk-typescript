import { describe, expect, it } from "vitest";
import { base32ToHash, blake3Hex, hashToBase32 } from "../../src/index.js";

// BLAKE3 of the empty input and of "abc", from the reference test vectors.
const EMPTY =
  "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
const ABC = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";

describe("blake3Hex", () => {
  it("matches the reference vectors", () => {
    expect(blake3Hex(new Uint8Array())).toBe(EMPTY);
    expect(blake3Hex(new TextEncoder().encode("abc"))).toBe(ABC);
  });
});

describe("site labels", () => {
  it("encode a hash as 52 lowercase base32 characters and back", () => {
    for (const hash of ["00".repeat(32), "ff".repeat(32), EMPTY, ABC]) {
      const label = hashToBase32(hash);
      expect(label).toMatch(/^[a-z2-7]{52}$/);
      expect(base32ToHash(label)).toBe(hash);
    }
  });

  it("match the gateway's label for a known hash", () => {
    // RFC 4648 base32 of 32 zero bytes, unpadded.
    expect(hashToBase32("00".repeat(32))).toBe("a".repeat(52));
    expect(hashToBase32("ff".repeat(32))).toBe(`${"7".repeat(51)}q`);
  });

  it("decode only a canonical label", () => {
    const label = hashToBase32(ABC);
    for (const bad of [
      label.toUpperCase(),
      label.slice(0, 51),
      `${label}a`,
      `${label.slice(0, 51)}1`,
      // Nonzero trailing bits: a second spelling of the same hash.
      `${"7".repeat(51)}r`,
    ]) {
      expect(base32ToHash(bad), bad).toBeUndefined();
    }
  });
});
