// The SDK against a loopback gateway with its token: the fake by default,
// the real binary when decdn's contract run runs this file with
// DECDN_CONTRACT:
// https://github.com/decdn/decdn/blob/main/crates/e2e/tests/gateway_sdk.rs
// The tests run in order: content is refused until the capability is
// registered.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  blake3Hex,
  DecdnClient,
  DecdnError,
  parseCapability,
} from "../../src/index.js";
import { contract, type Contract } from "./fixture.js";

let c: Contract;
let client: DecdnClient;
const run = await contract("loopback");

beforeAll(async () => {
  if (run === undefined) return;
  c = run;
  client = await c.open();
});

afterAll(async () => {
  await run?.close();
});

async function failure(p: Promise<unknown>): Promise<DecdnError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    return e as DecdnError;
  }
  throw new Error("resolved");
}

describe.skipIf(run === undefined)("loopback gateway contract", () => {
  it("refuses content no capability pays for, as plain text", async () => {
    const e = await failure(client.get(`decdn:${c.blob}`));
    expect(e.code).toBe("PAYMENT_REQUIRED");
    expect(e.body).toBe(`no capability covers ${c.host}`);
    expect(e.fallbackUri).toBeUndefined();
  });

  it("registers a capability for the host", async () => {
    const capability = c.capability ?? "";
    const registered = await client.loopback.registerCapability({
      capability,
      scope: c.host ?? "",
    });
    const grant = parseCapability(capability);
    expect(registered.signer.toLowerCase()).toBe(grant.signer.toLowerCase());
    expect(registered.scope).toBe(c.host);
    expect(registered.expiry).toBe(grant.expiry);
  });

  it("lists the capability it holds", async () => {
    const grant = parseCapability(c.capability ?? "");
    const held = await client.loopback.capabilities();
    const mine = held.find(
      (h) => h.signer.toLowerCase() === grant.signer.toLowerCase(),
    );
    expect(mine).toMatchObject({
      scope: c.host,
      origin: null,
      cap: grant.spendingCap,
      expiry: grant.expiry,
    });
    expect(mine?.pool.toLowerCase()).toBe(grant.poolId.toLowerCase());
  });

  it("refuses the same capability twice", async () => {
    const e = await failure(
      client.loopback.registerCapability({
        capability: c.capability ?? "",
        scope: c.host ?? "",
      }),
    );
    expect(e.code).toBe("CONFLICT");
  });

  it("streams a blob with the token, verified", async () => {
    const r = await client.get(`decdn:${c.blob}`);
    expect(r.verified).toBe(true);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(blake3Hex(await r.bytes())).toBe(c.blob);
  });

  it("verifies entries on the bare host, a page byte-exact", async () => {
    for (const path of ["a.txt", "index.html", "data.bin"]) {
      const r = await client.get(`decdn:${c.bundle}/${path}`);
      expect(r.verified, path).toBe(true);
      expect(await r.bytes(), path).toEqual(c.files[path]);
    }
  });

  it("serves a window of a sized entry", async () => {
    const r = await client.get(`decdn:${c.bundle}/data.bin`, {
      range: { offset: 10, length: 20 },
    });
    expect(r.status).toBe(206);
    expect(await r.bytes()).toEqual(c.files["data.bin"]?.subarray(10, 30));
  });

  it("answers head from the manifest", async () => {
    const info = await client.head(`decdn:${c.bundle}/a.txt`);
    expect(info.size).toBe(c.files["a.txt"]?.length);
    expect(info.contentType).toBe("text/plain; charset=utf-8");
  });

  it("refuses a wrong token and a host no capability covers", async () => {
    const wrong = await c.open({ token: "00".repeat(32) });
    expect((await failure(wrong.get(`decdn:${c.blob}`))).code).toBe(
      "UNAUTHORIZED",
    );
    const other = await c.open({ host: "other.example" });
    expect((await failure(other.get(`decdn:${c.blob}`))).code).toBe(
      "PAYMENT_REQUIRED",
    );
  });

  it("mints a delegate", async () => {
    const { address } = await client.loopback.delegate();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("answers the API only to the token or a page", async () => {
    const anonymous = await DecdnClient.open({
      gatewayUrl: c.gatewayUrl,
      fetch: c.fetch,
    });
    const e = await failure(anonymous.loopback.capabilities());
    expect(e.code).toBe("UNAUTHORIZED");
  });
});
