// The SDK against a loopback gateway with its token: the fake by default,
// the real binary when decdn's contract run runs this file with
// DECDN_CONTRACT:
// https://github.com/decdn/decdn/blob/main/crates/e2e/src/sdk_contract.rs
// The tests run in order: the fixture's capability is issued to the
// gateway's pending key, and content is refused until it is registered.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  blake3Hex,
  DecdnClient,
  DecdnError,
  parseCapability,
} from "../../src/index.js";
import pinnedCapability from "../fixtures/capability.json" with { type: "json" };
import { contract, shippedAfter, type Contract } from "./fixture.js";

let c: Contract;
let client: DecdnClient;
/** A client with no token: the API takes none. */
let anonymous: DecdnClient;
const run = await contract("loopback");

beforeAll(async () => {
  if (run === undefined) return;
  c = run;
  client = await c.open();
  anonymous = await DecdnClient.open({
    gatewayUrl: c.gatewayUrl,
    fetch: c.fetch,
  });
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

const grant = () => parseCapability(c.capability ?? "");

// Pending-key capabilities ship after decdn v0.3.1. A release at or before
// it speaks the scoped capability API this SDK does not, so the suite skips
// against it; scripts/decdn-contract.sh leaves the loopback journey out of
// those releases' runs, since their harness fails a skipped test.
describe.skipIf(run === undefined || !shippedAfter("0.3.1"))(
  "loopback gateway contract (pending-key capabilities, after decdn v0.3.1)",
  () => {
    it("names its one pending key on every call, with no token", async () => {
      const first = await anonymous.loopback.delegate();
      const again = await anonymous.loopback.delegate();
      expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(again.address).toBe(first.address);
      expect(first.address.toLowerCase()).toBe(grant().signer.toLowerCase());
    });

    it("refuses content no capability pays for, as plain text", async () => {
      const e = await failure(client.get(`decdn:${c.blob}`));
      expect(e.code).toBe("PAYMENT_REQUIRED");
      expect(e.body).toBe(
        "the gateway holds no capability that can pay: register one with PUT /_capability",
      );
      expect(e.fallbackUri).toBeUndefined();
    });

    it("refuses a registration with a field besides the capability", async () => {
      const r = await c.fetch(`${c.gatewayUrl}/_capability`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: c.capability, scope: "*" }),
      });
      expect(r.status).toBe(422);
      await r.arrayBuffer();
    });

    it("refuses a capability for a key it does not hold", async () => {
      // The pinned grant's signer is no key the gateway holds; the gateway
      // checks the key before the chain.
      const e = await failure(
        anonymous.loopback.registerCapability({
          capability: pinnedCapability.token,
        }),
      );
      expect(e.code).toBe("CONFLICT");
    });

    it("registers the capability, which claims the pending key", async () => {
      const registered = await anonymous.loopback.registerCapability({
        capability: c.capability ?? "",
      });
      const g = grant();
      expect({
        ...registered,
        signer: registered.signer.toLowerCase(),
        pool: registered.pool.toLowerCase(),
      }).toEqual({
        signer: g.signer.toLowerCase(),
        pool: g.poolId.toLowerCase(),
        expiry: g.expiry,
      });
      const next = await anonymous.loopback.delegate();
      expect(next.address.toLowerCase()).not.toBe(g.signer.toLowerCase());
    });

    it("lists the capability it holds, with no token", async () => {
      const g = grant();
      const held = await anonymous.loopback.capabilities();
      const mine = held.find(
        (h) => h.signer.toLowerCase() === g.signer.toLowerCase(),
      );
      expect(Object.keys(mine ?? {}).sort()).toEqual([
        "cap",
        "expiry",
        "pool",
        "signer",
        "spent",
      ]);
      expect(mine).toMatchObject({
        cap: g.spendingCap,
        expiry: g.expiry,
        spent: false,
      });
      expect(mine?.pool.toLowerCase()).toBe(g.poolId.toLowerCase());
    });

    it("refuses a second capability from the same pool on one key", async () => {
      const e = await failure(
        client.loopback.registerCapability({
          capability: c.capability ?? "",
        }),
      );
      expect(e.code).toBe("CONFLICT");
    });

    it("answers no cross-origin request to its API", async () => {
      for (const path of ["/_delegate", "/_capability"]) {
        const r = await c.fetch(`${c.gatewayUrl}${path}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.example",
            "access-control-request-method": "GET",
          },
        });
        expect(r.status, path).toBe(403);
        expect(r.headers.get("access-control-allow-origin"), path).toBeNull();
        expect(await r.text(), path).toBe("no cross-origin access\n");
      }
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

    it("refuses a wrong token", async () => {
      const wrong = await c.open({ token: "00".repeat(32) });
      expect((await failure(wrong.get(`decdn:${c.blob}`))).code).toBe(
        "UNAUTHORIZED",
      );
    });
  },
);
