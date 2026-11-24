import { describe, expect, it } from "vitest";
import { DecdnClient, DecdnError } from "../../src/index.js";
import { EXPIRY_MARGIN_SECS, FakeGateway } from "../fake-gateway.js";
import capability from "../fixtures/capability.json" with { type: "json" };
import { dcap } from "../support/dcap.js";

async function open(fake: FakeGateway) {
  return DecdnClient.open({ gatewayUrl: fake.url, fetch: fake.fetch });
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

const POOL_A = `0x${"aa".repeat(32)}`;
const POOL_B = `0x${"bb".repeat(32)}`;

describe("loopback API", () => {
  it("names the pending key, registers a capability that claims it, and lists it", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const c = await open(fake);
    const { address } = await c.loopback.delegate();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((await c.loopback.delegate()).address).toBe(address);
    fake.pending = capability.signer.toLowerCase();
    const registered = await c.loopback.registerCapability({
      capability: capability.token,
      scope: "any",
    });
    expect({ ...registered, signer: registered.signer.toLowerCase() }).toEqual({
      signer: capability.signer,
      pool: capability.poolId,
      expiry: BigInt(capability.expiry),
    });
    expect((await c.loopback.delegate()).address.toLowerCase()).not.toBe(
      capability.signer,
    );
    const listed = await c.loopback.capabilities();
    expect(
      listed.map((l) => ({ ...l, signer: l.signer.toLowerCase() })),
    ).toEqual([
      {
        cap: BigInt(capability.spendingCap),
        expiry: BigInt(capability.expiry),
        pool: capability.poolId,
        signer: capability.signer,
        spent: false,
      },
    ]);
    const put = fake.seen.find((s) => s.method === "PUT");
    expect(put?.headers.get("content-type")).toBe("application/json");
    for (const s of fake.seen) {
      expect(s.headers.get("x-decdn-host")).toBeNull();
    }
  });

  it("sends a namespace scope as given, and reads its namespaces back as bigints", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const bodies: string[] = [];
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: async (input, init) => {
        if (init?.method === "PUT") bodies.push(String(init.body));
        return fake.fetch(input, init);
      },
    });
    const { address } = await c.loopback.delegate();
    const big = (1n << 64n) - 1n;
    const signature = `0x${"ab".repeat(65)}`;
    const token = dcap({ pool: POOL_A, signer: address });
    const registered = await c.loopback.registerCapability({
      capability: token,
      scope: { namespaces: [7, big], signature },
    });
    expect(bodies).toEqual([
      `{"capability":"${token}","scope":{"namespaces":[7,${big}],"signature":"${signature}"}}`,
    ]);
    expect(registered.namespaces).toEqual([7n, big]);
    const any = await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_B, signer: address }),
      scope: "any",
    });
    expect(any).not.toHaveProperty("namespaces");
    expect(
      (await c.loopback.capabilities()).map((l) => [l.pool, l.namespaces]),
    ).toEqual([
      [POOL_A, [7n, big]],
      [POOL_B, undefined],
    ]);
    expect(Object.keys((await c.loopback.capabilities())[1] ?? {})).toEqual([
      "cap",
      "expiry",
      "pool",
      "signer",
      "spent",
    ]);
  });

  it("holds capabilities from several pools on one key, one per pool", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const c = await open(fake);
    const { address } = await c.loopback.delegate();
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_A, signer: address }),
      scope: "any",
    });
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_B, signer: address }),
      scope: "any",
    });
    expect(
      await code(
        c.loopback.registerCapability({
          capability: dcap({ pool: POOL_A, signer: address, cap: 5n }),
          scope: "any",
        }),
      ),
    ).toBe("CONFLICT");
    expect((await c.loopback.capabilities()).map((l) => l.pool)).toEqual([
      POOL_A,
      POOL_B,
    ]);
  });

  it("maps the API's refusals", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const c = await open(fake);
    // A key the gateway does not hold.
    expect(
      await code(
        c.loopback.registerCapability({
          capability: capability.token,
          scope: "any",
        }),
      ),
    ).toBe("CONFLICT");
    const { address } = await c.loopback.delegate();
    for (const bad of [
      "dcap1:AAAA",
      dcap({ pool: POOL_A, signer: address, cap: 0n }),
      dcap({
        pool: POOL_A,
        signer: address,
        expiry:
          BigInt(Math.floor(Date.now() / 1000)) + EXPIRY_MARGIN_SECS - 10n,
      }),
    ]) {
      expect(
        await code(
          c.loopback.registerCapability({ capability: bad, scope: "any" }),
        ),
        bad,
      ).toBe("UNPROCESSABLE");
    }
    const good = dcap({ pool: POOL_A, signer: address });
    const signature = `0x${"ab".repeat(65)}`;
    for (const body of [
      `{"capability":"${good}"}`,
      `{"capability":"${good}","scope":"*"}`,
      `{"capability":"${good}","scope":null}`,
      `{"capability":"${good}","scope":"any","extra":1}`,
      `{"capability":"${good}","scope":{"namespaces":[],"signature":"${signature}"}}`,
      `{"capability":"${good}","scope":{"namespaces":["7"],"signature":"${signature}"}}`,
      `{"capability":"${good}","scope":{"namespaces":[1.5],"signature":"${signature}"}}`,
      `{"capability":"${good}","scope":{"namespaces":[18446744073709551616],"signature":"${signature}"}}`,
      `{"capability":"${good}","scope":{"namespaces":[7],"signature":"0xab"}}`,
      `{"capability":"${good}","scope":{"namespaces":[7]}}`,
      `{"capability":"${good}","scope":{"namespaces":[7],"signature":"${signature}","x":1}}`,
    ]) {
      const r = await fake.fetch(`${fake.url}/_capability`, {
        method: "PUT",
        body,
      });
      expect(r.status, body).toBe(422);
    }
    expect(fake.capabilities).toHaveLength(0);
    // The gateway reads a scope signature's length only once it holds the key.
    const unheld = await fake.fetch(`${fake.url}/_capability`, {
      method: "PUT",
      body: `{"capability":"${capability.token}","scope":{"namespaces":[7],"signature":"0xab"}}`,
    });
    expect(unheld.status).toBe(409);
    const seen = fake.seen.length;
    for (const scope of [
      undefined,
      { namespaces: [0.5], signature },
      { namespaces: [], signature },
      { namespaces: [0n], signature },
      { namespaces: [-1], signature },
      { namespaces: [1n << 64n], signature },
      { namespaces: [true], signature },
      { namespaces: ["7"], signature },
      { namespaces: [null], signature },
      { namespaces: [undefined], signature },
      { namespaces: ["x"], signature },
      { namespaces: [{}], signature },
      { namespaces: [7n] },
      { namespaces: [7n], signature: "0xab" },
      { namespaces: [7n], signature: `0x${"zz".repeat(65)}` },
    ]) {
      expect(
        await code(
          c.loopback.registerCapability({
            capability: good,
            scope: scope as unknown as "any",
          }),
        ),
        JSON.stringify(scope, (_k, v: unknown) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      ).toBe("CONFIG");
    }
    expect(fake.seen).toHaveLength(seen);
    const preflight = await fake.fetch(`${fake.url}/_delegate`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  const SIGNER = `0x${"11".repeat(20)}`;
  const answers = {
    delegate: {
      path: "/_delegate",
      call: (c: DecdnClient) => c.loopback.delegate(),
      good: { address: SIGNER },
      missing: "address",
      wrong: { address: 7 },
    },
    registerCapability: {
      path: "/_capability",
      call: (c: DecdnClient) =>
        c.loopback.registerCapability({ capability: "dcap1:x", scope: "any" }),
      good: { signer: SIGNER, pool: POOL_A, expiry: 9 },
      missing: "pool",
      wrong: { signer: SIGNER, pool: POOL_A, expiry: "9" },
    },
    capabilities: {
      path: "/_capability",
      call: (c: DecdnClient) => c.loopback.capabilities(),
      good: [{ signer: SIGNER, pool: POOL_A, cap: 1, expiry: 9, spent: false }],
      missing: "spent",
      wrong: [
        {
          signer: SIGNER,
          pool: POOL_A,
          cap: 1,
          expiry: 9,
          spent: false,
          namespaces: [7, "8"],
        },
      ],
    },
  };

  async function refusal(
    body: string,
    call: (c: DecdnClient) => Promise<unknown>,
  ): Promise<DecdnError> {
    const c = await DecdnClient.open({
      gatewayUrl: "http://127.0.0.1:8484",
      fetch: () => Promise.resolve(new Response(body)),
    });
    try {
      await call(c);
    } catch (e) {
      expect(e).toBeInstanceOf(DecdnError);
      return e as DecdnError;
    }
    throw new Error("resolved");
  }

  it.each(Object.entries(answers))(
    "reports %s's answer outside the contract as HTTP, with the body",
    async (_name, a) => {
      const missing = JSON.stringify(a.good, (key, value: unknown) =>
        key === a.missing ? undefined : value,
      );
      for (const body of [
        "<h1>another server</h1>",
        missing,
        JSON.stringify(a.wrong),
      ]) {
        const e = await refusal(body, a.call);
        expect(e.code).toBe("HTTP");
        expect(e.message).toMatch(
          `the gateway's answer to ${a.path} is not the JSON its contract names: `,
        );
        expect(e.body).toBe(body);
      }
      expect(
        await a.call(
          await DecdnClient.open({
            gatewayUrl: "http://127.0.0.1:8484",
            fetch: () => Promise.resolve(new Response(JSON.stringify(a.good))),
          }),
        ),
      ).toBeDefined();
    },
  );

  it("is offered on a loopback client alone", async () => {
    const fake = new FakeGateway({ mode: "public" });
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: fake.fetch,
    });
    await expect(c.loopback.delegate()).rejects.toMatchObject({
      code: "CONFIG",
      message:
        "the SDK offers the delegate and capability API on a loopback client alone: open one on a localhost or loopback-address URL",
    });
    expect(fake.seen).toHaveLength(0);
  });
});

describe("loopback payment", () => {
  it("pays with the first usable capability in registration order, and moves on from a spent one", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const [one, two, three] = ["one", "two", "three"].map((s) =>
      fake.addBlob(s),
    );
    const c = await open(fake);
    const first = (await c.loopback.delegate()).address;
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_A, signer: first }),
      scope: "any",
    });
    const second = (await c.loopback.delegate()).address;
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_B, signer: second }),
      scope: "any",
    });
    await (await c.get(`decdn:${one}`)).bytes();
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_A]);
    fake.drained.add(POOL_A);
    await (await c.get(`decdn:${two}`)).bytes();
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_A, POOL_B]);
    expect(
      (await c.loopback.capabilities()).map((l) => [l.pool, l.spent]),
    ).toEqual([
      [POOL_A, true],
      [POOL_B, false],
    ]);
    fake.drained.add(POOL_B);
    expect(await code(c.get(`decdn:${three}`))).toBe("PAYMENT_REQUIRED");
    // A blob the cache holds whole needs no capability.
    expect(await (await c.get(`decdn:${one}`)).text()).toBe("one");
    expect(fake.paid).toHaveLength(2);
  });

  it("pays with a namespace-scoped capability only for content that names one of its namespaces", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const [one, two] = ["one", "two"].map((s) => fake.addBlob(s));
    const c = await open(fake);
    const { address } = await c.loopback.delegate();
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_A, signer: address }),
      scope: { namespaces: [7n], signature: `0x${"ab".repeat(65)}` },
    });
    expect(await code(c.get(`decdn:${one}`))).toBe("PAYMENT_REQUIRED");
    expect(await code(c.get(`decdn:${one}?ns=9`))).toBe("PAYMENT_REQUIRED");
    expect(await (await c.get(`decdn:${one}?ns=7`)).text()).toBe("one");
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_A]);
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_B, signer: address }),
      scope: "any",
    });
    expect(await (await c.get(`decdn:${two}`)).text()).toBe("two");
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_A, POOL_B]);
  });

  it("pays a request that names a namespace with a capability scoped to it before an earlier any one", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const [one, two] = ["one", "two"].map((s) => fake.addBlob(s));
    const c = await open(fake);
    const first = (await c.loopback.delegate()).address;
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_A, signer: first }),
      scope: "any",
    });
    const second = (await c.loopback.delegate()).address;
    await c.loopback.registerCapability({
      capability: dcap({ pool: POOL_B, signer: second }),
      scope: { namespaces: [7n], signature: `0x${"ab".repeat(65)}` },
    });
    expect((await c.loopback.capabilities()).map((l) => l.pool)).toEqual([
      POOL_A,
      POOL_B,
    ]);
    await (await c.get(`decdn:${one}?ns=7`)).bytes();
    await (await c.get(`decdn:${two}`)).bytes();
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_B, POOL_A]);
  });

  it("skips a capability inside the expiry margin", async () => {
    const fake = new FakeGateway({ mode: "loopback" });
    const blob = fake.addBlob("paid bytes");
    fake.capabilities.push(
      {
        signer: "0x01",
        pool: POOL_A,
        cap: 1n,
        expiry: BigInt(Math.floor(Date.now() / 1000)) + 60n,
        spent: false,
      },
      {
        signer: "0x02",
        pool: POOL_B,
        cap: 1n,
        expiry: 1_900_000_000n,
        spent: false,
      },
    );
    const c = await open(fake);
    await (await c.get(`decdn:${blob}`)).bytes();
    expect(fake.paid.map((r) => r.pool)).toEqual([POOL_B]);
  });
});
