import { describe, expect, it } from "vitest";
import { DecdnClient, DecdnError } from "../../src/index.js";
import { FakeGateway } from "../fake-gateway.js";
import capability from "../fixtures/capability.json" with { type: "json" };

const TOKEN = "cd".repeat(32);

async function open(fake: FakeGateway, token: string | null = TOKEN) {
  return DecdnClient.open({
    gatewayUrl: fake.url,
    fetch: fake.fetch,
    ...(token === null ? {} : { token, host: "example.com" }),
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    return (e as DecdnError).code;
  }
  return "resolved";
}

describe("loopback API", () => {
  it("mints a delegate, registers its capability, and lists it", async () => {
    const fake = new FakeGateway({ mode: "loopback", token: TOKEN });
    const c = await open(fake);
    const { address } = await c.loopback.delegate();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    fake.delegates.set(capability.signer.toLowerCase(), undefined);
    const registered = await c.loopback.registerCapability({
      capability: capability.token,
      scope: "example.com",
    });
    expect({ ...registered, signer: registered.signer.toLowerCase() }).toEqual({
      signer: capability.signer,
      scope: "example.com",
      expiry: BigInt(capability.expiry),
    });
    const listed = await c.loopback.capabilities();
    expect(
      listed.map((l) => ({ ...l, signer: l.signer.toLowerCase() })),
    ).toEqual([
      {
        signer: capability.signer,
        pool: capability.poolId,
        scope: "example.com",
        origin: null,
        cap: BigInt(capability.spendingCap),
        expiry: BigInt(capability.expiry),
        spent: false,
      },
    ]);
    const put = fake.seen.find((s) => s.method === "PUT");
    expect(put?.headers.get("content-type")).toBe("application/json");
    expect(put?.headers.get("x-decdn-token")).toBe(TOKEN);
  });

  it("maps the API's refusals", async () => {
    const fake = new FakeGateway({ mode: "loopback", token: TOKEN });
    const c = await open(fake);
    expect(
      await code(
        c.loopback.registerCapability({
          capability: capability.token,
          scope: "example.com",
        }),
      ),
    ).toBe("CONFLICT");
    expect(
      await code(
        c.loopback.registerCapability({
          capability: "dcap1:AAAA",
          scope: "example.com",
        }),
      ),
    ).toBe("UNPROCESSABLE");
    const anonymous = await open(fake, null);
    expect(await code(anonymous.loopback.capabilities())).toBe("UNAUTHORIZED");
    expect(await code(anonymous.loopback.delegate())).toBe("FORBIDDEN");
  });

  it("is a loopback gateway's alone", async () => {
    const fake = new FakeGateway({ mode: "public" });
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: fake.fetch,
    });
    expect(await code(c.loopback.delegate())).toBe("CONFIG");
    expect(fake.seen).toHaveLength(0);
  });
});
