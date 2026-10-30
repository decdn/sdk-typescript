// The SDK against a public gateway: the fake by default, the real binary
// when decdn's contract run runs this file with DECDN_CONTRACT:
// https://github.com/decdn/decdn/blob/main/crates/e2e/src/sdk_contract.rs
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  blake3Hex,
  DecdnError,
  hashToBase32,
  type DecdnClient,
} from "../../src/index.js";
import { contract, type Contract } from "./fixture.js";

let c: Contract;
let client: DecdnClient;
const run = await contract("public");

beforeAll(async () => {
  if (run === undefined) return;
  c = run;
  client = await c.open();
});

afterAll(async () => {
  await run?.close();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    return (e as DecdnError).code;
  }
  return "resolved";
}

describe.skipIf(run === undefined)("public gateway contract", () => {
  it("streams a blob from the bare host, verified, readable by any origin", async () => {
    const r = await client.get(`decdn:${c.blob}`);
    expect(r.status).toBe(200);
    expect(r.verified).toBe(true);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(blake3Hex(await r.bytes())).toBe(c.blob);
  });

  it("verifies an entry fetched through its site", async () => {
    const r = await client.get(`decdn:${c.bundle}/a.txt`);
    expect(r.verified).toBe(true);
    expect(r.contentType).toBe("text/plain; charset=utf-8");
    expect(r.contentLength).toBe(c.files["a.txt"]?.length);
    expect(await r.bytes()).toEqual(c.files["a.txt"]);
  });

  it("verifies a page by its entry hash, unrewritten", async () => {
    const r = await client.get(`decdn:${c.bundle}/index.html`);
    expect(r.verified).toBe(true);
    expect(await r.bytes()).toEqual(c.files["index.html"]);
  });

  it("rewrites the page on its site", async () => {
    const r = await client.get(`decdn:${c.bundle}/index.html`, {
      verify: false,
    });
    expect(r.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(await r.text()).toContain(`/_decdn/${c.blob}`);
  });

  it("serves a window of a sized entry as 206", async () => {
    const r = await client.get(`decdn:${c.bundle}/data.bin`, {
      range: { offset: 1000, length: 5000 },
    });
    expect(r.status).toBe(206);
    expect(r.verified).toBe("skipped");
    const size = c.files["data.bin"]?.length ?? 0;
    expect(r.contentRange).toEqual({ offset: 1000, length: 5000, size });
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(await r.bytes()).toEqual(c.files["data.bin"]?.subarray(1000, 6000));
  });

  it("refuses a window past the end with the size", async () => {
    const size = c.files["a.txt"]?.length ?? 0;
    const e = await client
      .get(`decdn:${c.bundle}/a.txt`, { range: { offset: size } })
      .catch((e: unknown) => e);
    expect((e as DecdnError).code).toBe("RANGE_NOT_SATISFIABLE");
    expect((e as DecdnError).size).toBe(size);
  });

  it("answers HEAD on an entry from the manifest", async () => {
    const m = await client.manifest(c.bundle);
    const entry = m.entries.find((e) => e.path === "data.bin");
    expect(await client.head(`decdn:${c.bundle}/data.bin`)).toEqual({
      size: entry?.size,
      hash: entry?.hash,
      contentType: "application/octet-stream",
    });
  });

  it("reads the manifest the bundle hash names", async () => {
    const m = await client.manifest(`decdn:${c.bundle}/`);
    expect(m.hash).toBe(c.bundle);
    expect(m.entries.map((e) => e.path).sort()).toEqual(
      Object.keys(c.files).sort(),
    );
  });

  it("answers a ranged preflight from any origin", async () => {
    const site = client.siteUrl(`decdn:${c.bundle}/data.bin`);
    const r = await c.fetch(site, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "range",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(r.headers.get("access-control-allow-headers")).toBe("range");
    expect(r.headers.get("access-control-expose-headers")).toContain(
      "Content-Range",
    );
  });

  it("answers a pointer preflight on the bare host only", async () => {
    const preflight = {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    };
    const bare = await c.fetch(`${c.gatewayUrl}/_pointer`, preflight);
    expect(bare.status).toBe(204);
    expect(bare.headers.get("access-control-allow-methods")).toBe("PUT");
    expect(bare.headers.get("access-control-allow-headers")).toBe(
      "content-type",
    );
    const site = new URL(client.siteUrl(`decdn:${c.bundle}/`));
    const off = await c.fetch(`${site.origin}/_pointer`, preflight);
    expect(off.status).toBe(404);
  });

  it("lets any origin read a refusal", async () => {
    const size = c.files["a.txt"]?.length ?? 0;
    const r = await c.fetch(client.siteUrl(`decdn:${c.bundle}/a.txt`), {
      headers: { origin: "https://app.example", range: `bytes=${size}-` },
    });
    expect(r.status).toBe(416);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-expose-headers")).toContain(
      "Content-Range",
    );
  });

  it("refuses an unknown host", async () => {
    const r = await c.fetch("http://evil.example/", {});
    expect(r.status).toBe(403);
  });

  it("redirects a bundle on the bare host to its site", async () => {
    const r = await c.fetch(`${c.gatewayUrl}/${c.bundle}/a.txt`, {
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `${new URL(c.gatewayUrl).protocol}//${hashToBase32(c.bundle)}.${new URL(c.gatewayUrl).host}/a.txt`,
    );
  });

  it("stores a pointer the namespace's owner signs, and its host serves the bundle", async () => {
    const p = c.pointer;
    if (p === undefined) throw new Error("the fixture has no pointer");
    const signer = { privateKey: p.privateKey };
    const set = await client.pointer.set({
      namespace: p.namespace,
      root: `decdn:${c.bundle}/`,
      signer,
    });
    expect(set.root).toBe(c.bundle);
    expect(set.url).toBe(client.namespaceUrl(p.namespace));
    const page = await c.fetch(`${set.url}a.txt`, {});
    expect(page.status).toBe(200);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(c.files["a.txt"]);
    const replay = await client.pointer
      .set({ namespace: p.namespace, root: c.bundle, seq: set.seq, signer })
      .catch((e: unknown) => e as DecdnError);
    expect((replay as DecdnError).code).toBe("CONFLICT");
    expect((replay as DecdnError).seq).toBe(set.seq);
    expect(
      await code(
        client.pointer.set({
          namespace: p.namespace,
          root: c.bundle,
          seq: set.seq + 1n,
          signer: { privateKey: `0x${"33".repeat(32)}` },
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});
