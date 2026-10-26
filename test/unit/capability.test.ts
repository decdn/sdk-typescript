import { describe, expect, it } from "vitest";
import { DecdnError, parseCapability } from "../../src/index.js";
import fixture from "../fixtures/capability.json" with { type: "json" };

function bad(token: string): DecdnError {
  try {
    parseCapability(token);
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    return e as DecdnError;
  }
  throw new Error(`decoded: ${token}`);
}

describe("parseCapability", () => {
  it("decodes the token the Rust encoder pins", () => {
    expect(parseCapability(fixture.token)).toEqual({
      poolId: fixture.poolId,
      signer: fixture.signer,
      spendingCap: BigInt(fixture.spendingCap),
      expiry: BigInt(fixture.expiry),
      ownerSignature: fixture.ownerSignature,
    });
  });

  it("rejects a missing or foreign prefix", () => {
    expect(bad(fixture.token.slice("dcap1:".length)).code).toBe(
      "BAD_CAPABILITY",
    );
    expect(bad("dcap2:whatever").message).toMatch(/dcap1:/);
  });

  it("rejects a body that is not base64url", () => {
    expect(bad("dcap1:not*base64*").message).toMatch(/base64url/);
    expect(bad("dcap1:IBEi=").message).toMatch(/base64url/);
  });

  it("rejects a truncated or padded payload", () => {
    const body = fixture.token.slice("dcap1:".length);
    expect(bad(`dcap1:${body.slice(0, body.length / 2)}`).code).toBe(
      "BAD_CAPABILITY",
    );
    expect(bad(`${fixture.token}AA`).message).toMatch(/malformed/);
  });
});
