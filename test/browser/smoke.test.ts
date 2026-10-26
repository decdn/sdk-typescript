// The SDK in a real browser against a public (fake) gateway on another
// origin: CORS, streamed bodies and hashing as Chromium does them.
import { describe, expect, inject, it } from "vitest";
import { DecdnClient, DecdnError } from "../../src/index.js";

const gw = inject("gateway");

describe("browser", () => {
  it("runs on another origin than the gateway", async () => {
    expect(location.origin).not.toBe(gw.url);
    const c = await DecdnClient.open({ gatewayUrl: gw.url });
    expect(c.context).toBe("public");
  });

  it("streams a blob cross-origin and verifies it", async () => {
    const c = await DecdnClient.open({ gatewayUrl: gw.url });
    const r = await c.get(`decdn:${gw.blob}`);
    expect(r.verified).toBe(true);
    expect(await r.text()).toBe(gw.blobText);
  });

  it("reads a window of an entry from its site, with the exposed headers", async () => {
    const c = await DecdnClient.open({ gatewayUrl: gw.url });
    const r = await c.get(`decdn:${gw.bundle}/data.bin`, {
      range: { offset: 100, length: 50 },
    });
    expect(r.status).toBe(206);
    expect(r.contentRange).toEqual({
      offset: 100,
      length: 50,
      size: gw.data.length,
    });
    expect([...(await r.bytes())]).toEqual(gw.data.slice(100, 150));
  });

  it("verifies an entry through its site against the manifest", async () => {
    const c = await DecdnClient.open({ gatewayUrl: gw.url });
    const r = await c.get(`decdn:${gw.bundle}/data.bin`);
    expect(r.verified).toBe(true);
    expect(r.contentLength).toBe(gw.data.length);
    expect([...(await r.bytes())]).toEqual(gw.data);
  });

  it("fails altered bytes with HASH_MISMATCH", async () => {
    const c = await DecdnClient.open({ gatewayUrl: gw.url });
    const r = await c.get(`decdn:${gw.tampered}`);
    const e = await r.bytes().catch((e: unknown) => e);
    expect(e).toBeInstanceOf(DecdnError);
    expect((e as DecdnError).code).toBe("HASH_MISMATCH");
  });
});
