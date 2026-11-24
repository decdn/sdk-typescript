// The SDK against a loopback gateway: the fake by default, the real binary
// when decdn's contract run runs this file with DECDN_CONTRACT:
// https://github.com/decdn/decdn/blob/main/crates/e2e/src/sdk_contract.rs
// The tests run in order: the fixture's capability is issued to the
// gateway's pending key, and content is refused until it is registered.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  blake3Hex,
  DecdnError,
  hashToBase32,
  parseCapability,
  type DecdnClient,
} from "../../src/index.js";
import pinnedCapability from "../fixtures/capability.json" with { type: "json" };
import { dcap } from "../support/dcap.js";
import { contract, shippedAfter, type Contract } from "./fixture.js";

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

const grant = () => parseCapability(c.capability ?? "");

/** A raw request to the gateway's bare host, with `headers` and nothing else. */
const raw = (path: string, init: RequestInit = {}) =>
  c.fetch(`${c.gatewayUrl}${path}`, { redirect: "manual", ...init });

const ANOTHER_SITE = "a page on another site may not use the gateway\n";
const ANOTHER_ORIGIN = "a page on another origin may not use the gateway\n";
const NO_FETCH_SITE =
  "a browser that sends no Sec-Fetch-Site may not use the gateway\n";

// Pending-key capabilities and the browser-header gate ship after decdn
// v0.3.1. A release at or before it speaks the scoped, token-holding API
// this SDK does not, so the suite skips against it; scripts/decdn-contract.sh
// leaves the loopback journey out of those releases' runs, since their
// harness fails a skipped test.
describe.skipIf(run === undefined || !shippedAfter("0.3.1"))(
  "loopback gateway contract (pending-key capabilities, after decdn v0.3.1)",
  () => {
    it("names its one pending key on every call", async () => {
      const first = await client.loopback.delegate();
      const again = await client.loopback.delegate();
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

    it("refuses a registration with no scope, a scope word other than any, or a field besides them", async () => {
      for (const body of [
        { capability: c.capability },
        { capability: c.capability, scope: "*" },
        { capability: c.capability, scope: "any", extra: 1 },
      ]) {
        const r = await raw("/_capability", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(r.status, JSON.stringify(body)).toBe(422);
        await r.arrayBuffer();
      }
    });

    it("refuses a capability for a key it does not hold", async () => {
      // The pinned grant's signer is no key the gateway holds; the gateway
      // checks the key before the chain.
      const e = await failure(
        client.loopback.registerCapability({
          capability: pinnedCapability.token,
          scope: "any",
        }),
      );
      expect(e.code).toBe("CONFLICT");
    });

    it("registers the capability, which claims the pending key", async () => {
      const registered = await client.loopback.registerCapability({
        capability: c.capability ?? "",
        scope: "any",
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
      const next = await client.loopback.delegate();
      expect(next.address.toLowerCase()).not.toBe(g.signer.toLowerCase());
    });

    it("lists the capability it holds", async () => {
      const g = grant();
      const held = await client.loopback.capabilities();
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
          scope: "any",
        }),
      );
      expect(e.code).toBe("CONFLICT");
    });

    // A namespace scope needs the pool owner's signature, which the real
    // gateway recovers on chain; the fake checks its shape alone, so only
    // the fake runs this.
    if (run?.real === false) {
      it("registers a namespace-scoped capability and lists its namespaces", async () => {
        const g = grant();
        const pool = `0x${"5c".repeat(32)}`;
        const registered = await client.loopback.registerCapability({
          capability: dcap({ pool, signer: g.signer }),
          scope: { namespaces: [7n, 9n], signature: `0x${"ab".repeat(65)}` },
        });
        expect(registered.namespaces).toEqual([7n, 9n]);
        const held = await client.loopback.capabilities();
        const scoped = held.find((h) => h.pool.toLowerCase() === pool);
        expect(Object.keys(scoped ?? {}).sort()).toEqual([
          "cap",
          "expiry",
          "namespaces",
          "pool",
          "signer",
          "spent",
        ]);
        expect(scoped?.namespaces).toEqual([7n, 9n]);
      });
    }

    it("answers no preflight to a page on another origin", async () => {
      for (const path of ["/_delegate", "/_capability"]) {
        const r = await raw(path, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.example",
            "access-control-request-method": "GET",
          },
        });
        expect(r.status, path).toBe(403);
        expect(r.headers.get("access-control-allow-origin"), path).toBeNull();
        expect(await r.text(), path).toBe(ANOTHER_ORIGIN);
      }
    });

    it("streams a blob, verified", async () => {
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

    it("serves a request with no Sec-Fetch headers, no Origin and no browser agent", async () => {
      const r = await raw(`/${c.blob}`);
      expect(r.status).toBe(200);
      expect(blake3Hex(new Uint8Array(await r.arrayBuffer()))).toBe(c.blob);
    });

    it("refuses a page on another site", async () => {
      const r = await raw(`/${c.blob}`, {
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(r.status).toBe(403);
      expect(await r.text()).toBe(ANOTHER_SITE);
    });

    it("refuses a page on another origin, on content and on the API", async () => {
      for (const path of [`/${c.blob}`, "/_delegate"]) {
        const r = await raw(path, {
          headers: { origin: "https://app.example" },
        });
        expect(r.status, path).toBe(403);
        expect(await r.text(), path).toBe(ANOTHER_ORIGIN);
      }
    });

    it("refuses a browser that sends no Sec-Fetch-Site", async () => {
      const r = await raw(`/${c.blob}`, {
        headers: { "user-agent": "Mozilla/5.0" },
      });
      expect(r.status).toBe(403);
      expect(await r.text()).toBe(NO_FETCH_SITE);
    });

    it("checks the site before the origin, and the origin before a missing Sec-Fetch-Site", async () => {
      for (const [headers, body] of [
        [
          { "sec-fetch-site": "cross-site", origin: "https://app.example" },
          ANOTHER_SITE,
        ],
        [
          { origin: "https://app.example", "user-agent": "Mozilla/5.0" },
          ANOTHER_ORIGIN,
        ],
      ] as const) {
        const r = await raw(`/${c.blob}`, { headers });
        expect(r.status, body).toBe(403);
        expect(await r.text()).toBe(body);
      }
    });

    it("lets a top-level navigation from another site through, and refuses a frame's", async () => {
      const link = {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "user-agent": "Mozilla/5.0",
      };
      const opened = await raw(`/${c.blob}`, {
        headers: { ...link, "sec-fetch-dest": "document" },
      });
      expect(opened.status).toBe(200);
      expect(blake3Hex(new Uint8Array(await opened.arrayBuffer()))).toBe(
        c.blob,
      );
      const framed = await raw(`/${c.blob}`, {
        headers: { ...link, "sec-fetch-dest": "iframe" },
      });
      expect(framed.status).toBe(403);
      expect(await framed.text()).toBe(ANOTHER_SITE);
    });

    it("sends a browser's navigation to an entry to its site", async () => {
      const r = await raw(`/${c.bundle}/a.txt`, {
        headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
      });
      expect(r.status).toBeGreaterThanOrEqual(300);
      expect(r.status).toBeLessThan(400);
      const location = new URL(r.headers.get("location") ?? "");
      expect(location.hostname).toBe(`${hashToBase32(c.bundle)}.localhost`);
      expect(location.port).toBe(new URL(c.gatewayUrl).port);
      expect(location.pathname).toBe("/a.txt");
      await r.arrayBuffer();
    });
  },
);
