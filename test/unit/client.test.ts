import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecdnClient,
  DecdnError,
  hashToBase32,
  type DecdnErrorCode,
} from "../../src/index.js";
import { FakeGateway } from "../fake-gateway.js";

const TOKEN = "cd".repeat(32);

function publicFake(allowanceBytes?: number) {
  const fake = new FakeGateway({
    mode: "public",
    ...(allowanceBytes === undefined ? {} : { allowanceBytes }),
  });
  const bundle = fake.addBundle(
    {
      "a.txt": "abc",
      "index.html": "<p>hi decdn:" + "ee".repeat(32) + "</p>",
      "css/site.css": "a { color: red }",
      "dir one/b.bin": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      "unsized.txt": "no size",
    },
    ["unsized.txt"],
  );
  const blob = fake.addBlob("other bytes");
  return { fake, bundle, blob };
}

async function open(fake: FakeGateway, extra: Record<string, unknown> = {}) {
  return DecdnClient.open({
    gatewayUrl: fake.url,
    fetch: fake.fetch,
    ...extra,
  });
}

async function rejects(
  p: Promise<unknown>,
  code: DecdnErrorCode,
): Promise<DecdnError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    expect((e as DecdnError).code, (e as Error).message).toBe(code);
    return e as DecdnError;
  }
  throw new Error(`resolved, expected ${code}`);
}

function paths(fake: FakeGateway): string[] {
  return fake.seen.map((s) => {
    const u = new URL(s.url);
    return `${s.method} ${u.host}${u.pathname}${u.search}`;
  });
}

/** A fetch that serves the site URL of `a.txt` as `type`, rewritten. */
function servedAs(fake: FakeGateway, type: string): typeof fake.fetch {
  return async (input, init) => {
    const r = await fake.fetch(input, init);
    if (!/^\/a\.txt$/.test(new URL(String(input)).pathname)) return r;
    return new Response("rewritten", { headers: { "content-type": type } });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DecdnClient.open", () => {
  it("picks the context from the gateway URL and token", async () => {
    const { fake } = publicFake();
    expect((await open(fake)).context).toBe("public");
    const loop = new FakeGateway({ mode: "loopback" });
    expect(
      (
        await DecdnClient.open({
          gatewayUrl: "http://127.0.0.1:8484",
          fetch: loop.fetch,
        })
      ).context,
    ).toBe("loopback");
    expect(
      (
        await DecdnClient.open({
          gatewayUrl: "https://gw.example",
          token: TOKEN,
          host: "example.com",
        })
      ).context,
    ).toBe("loopback");
  });

  it("refuses a token without a host, and no gateway outside a site page", async () => {
    await rejects(
      DecdnClient.open({ gatewayUrl: "http://127.0.0.1:8484", token: TOKEN }),
      "CONFIG",
    );
    await rejects(DecdnClient.open({}), "CONFIG");
    await rejects(DecdnClient.open({ gatewayUrl: "not a url" }), "CONFIG");
  });
});

describe("public context", () => {
  it("streams a blob from the bare host and verifies it", async () => {
    const { fake, blob } = publicFake();
    const c = await open(fake);
    const r = await c.get(`decdn:${blob}`);
    expect(r.status).toBe(200);
    expect(r.verified).toBe(true);
    expect(r.contentType).toBe("application/octet-stream");
    expect(r.contentLength).toBe(11);
    expect(await r.text()).toBe("other bytes");
    expect(paths(fake)).toEqual([`GET decdn.test/${blob}`]);
  });

  it("fails a tampered blob with HASH_MISMATCH, as a stream error and on bytes()", async () => {
    const { fake, blob } = publicFake();
    fake.tampered.add(blob);
    const c = await open(fake);
    await rejects((await c.get(`decdn:${blob}`)).bytes(), "HASH_MISMATCH");
    const reader = (await c.get(`decdn:${blob}`)).body.getReader();
    const err = await (async () => {
      for (;;) {
        try {
          if ((await reader.read()).done) return undefined;
        } catch (e) {
          return e;
        }
      }
    })();
    expect((err as DecdnError).code).toBe("HASH_MISMATCH");
  });

  it("still hashes a whole-body request the gateway answers with a window", async () => {
    const { fake, bundle, blob } = publicFake();
    const sized = bundle.entries.find((e) => e.path === "a.txt");
    const unsized = bundle.entries.find((e) => e.path === "unsized.txt");
    fake.partial.add(blob);
    fake.partial.add(sized?.hash ?? "");
    fake.partial.add(unsized?.hash ?? "");
    const c = await open(fake);
    const u = await c.get(`decdn:${bundle.hash}/unsized.txt`);
    expect(u.verified).toBe(true);
    await rejects(u.bytes(), "HASH_MISMATCH");
    for (const uri of [`decdn:${blob}`, `decdn:${bundle.hash}/a.txt`]) {
      const r = await c.get(uri);
      expect(r.verified).toBe(true);
      await rejects(r.bytes(), "TRUNCATED");
    }
  });

  it("fails a body the gateway cuts with TRUNCATED", async () => {
    const { fake, blob } = publicFake();
    fake.truncated.add(blob);
    const c = await open(fake);
    await rejects((await c.get(`decdn:${blob}`)).bytes(), "TRUNCATED");
    await rejects(
      (await c.get(`decdn:${blob}`, { verify: false })).bytes(),
      "TRUNCATED",
    );
  });

  it("fetches an entry through its site and verifies it against the manifest", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const r = await c.get(`decdn:${bundle.hash}/dir%20one/b.bin`);
    expect(r.verified).toBe(true);
    expect(r.contentLength).toBe(8);
    expect([...(await r.bytes())]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const label = hashToBase32(bundle.hash);
    expect(paths(fake)).toEqual([
      `GET decdn.test/${bundle.hash}`,
      `GET ${label}.decdn.test/dir%20one/b.bin`,
    ]);
  });

  it("fetches a page or a stylesheet by its entry hash, unrewritten", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const page = bundle.entries.find((e) => e.path === "index.html");
    const r = await c.get(`decdn:${bundle.hash}/index.html`);
    expect(r.verified).toBe(true);
    expect(await r.text()).toContain("decdn:" + "ee".repeat(32));
    expect(paths(fake)).toEqual([
      `GET decdn.test/${bundle.hash}`,
      `GET decdn.test/${page?.hash}`,
    ]);
  });

  it("fails a tampered entry with HASH_MISMATCH", async () => {
    const { fake, bundle } = publicFake();
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    fake.tampered.add(entry?.hash ?? "");
    const c = await open(fake);
    await rejects(
      (await c.get(`decdn:${bundle.hash}/a.txt`)).bytes(),
      "HASH_MISMATCH",
    );
  });

  it("skips the manifest when verification is off", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake, { verify: false });
    const r = await c.get(`decdn:${bundle.hash}/a.txt`);
    expect(r.verified).toBe(false);
    expect(await r.text()).toBe("abc");
    expect(paths(fake)).toEqual([
      `GET ${hashToBase32(bundle.hash)}.decdn.test/a.txt`,
    ]);
  });

  it("answers a range with 206 and no verification", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const r = await c.get(`decdn:${bundle.hash}/dir%20one/b.bin`, {
      range: { offset: 2, length: 3 },
    });
    expect(r.status).toBe(206);
    expect(r.verified).toBe("skipped");
    expect(r.contentRange).toEqual({ offset: 2, length: 3, size: 8 });
    expect([...(await r.bytes())]).toEqual([3, 4, 5]);
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.headers.get("range")).toBe("bytes=2-4");
    await rejects(
      c.get(`decdn:${bundle.hash}/a.txt`, {
        range: { offset: 1 },
        verify: true,
      }),
      "CONFIG",
    );
  });

  it("refuses a range on a blob before any request", async () => {
    const { fake, blob } = publicFake();
    fake.partial.add(blob);
    const c = await open(fake);
    for (const verify of ["auto", true, false] as const) {
      await rejects(
        c.get(`decdn:${blob}`, { range: { offset: 0, length: 1 }, verify }),
        "CONFIG",
      );
    }
    expect(fake.seen).toHaveLength(0);
  });

  it("keeps one caller's abort out of another's manifest read", async () => {
    const { fake, bundle } = publicFake();
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        setTimeout(() => fake.fetch(input, init).then(resolve, reject), 20);
      });
    const c = await DecdnClient.open({ gatewayUrl: fake.url, fetch: slow });
    const ctrl = new AbortController();
    const a = c.get(`decdn:${bundle.hash}/a.txt`, { signal: ctrl.signal });
    const b = c.get(`decdn:${bundle.hash}/a.txt`);
    ctrl.abort();
    await expect(a).rejects.toThrow();
    expect(await (await b).text()).toBe("abc");
  });

  it("maps a range past the end to RANGE_NOT_SATISFIABLE with the size", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const e = await rejects(
      c.get(`decdn:${bundle.hash}/a.txt`, { range: { offset: 3 } }),
      "RANGE_NOT_SATISFIABLE",
    );
    expect(e.size).toBe(3);
    expect(e.status).toBe(416);
  });

  it("maps a spent allowance to PAYMENT_REQUIRED with the fallback URI", async () => {
    const { fake, blob } = publicFake(0);
    const c = await open(fake);
    const e = await rejects(c.get(`decdn:${blob}?ns=7`), "PAYMENT_REQUIRED");
    expect(e.status).toBe(402);
    expect(e.fallbackUri).toBe(`decdn:${blob}?ns=7`);
    expect(e.retryAfterSecs).toBeGreaterThan(0);
  });

  it("maps a pool that cannot pay to POOL_UNFUNDED", async () => {
    const { fake, blob } = publicFake();
    fake.unfunded.add(blob);
    const c = await open(fake);
    const e = await rejects(c.get(`decdn:${blob}`), "POOL_UNFUNDED");
    expect(e.retryAfterSecs).toBe(60);
    expect(e.fallbackUri).toBe(`decdn:${blob}`);
  });

  it("retries once after Retry-After when asked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fake, blob } = publicFake();
    fake.unfunded.add(blob);
    const c = await open(fake);
    const pending = c.get(`decdn:${blob}`, { retry: true });
    await vi.advanceTimersByTimeAsync(1000);
    fake.unfunded.delete(blob);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await (await pending).text()).toBe("other bytes");
    expect(fake.seen).toHaveLength(2);
  });

  it(
    "does not wait out Retry-After once the caller has aborted",
    { timeout: 1000 },
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const { fake, blob } = publicFake();
      fake.unfunded.add(blob);
      const ac = new AbortController();
      const reason = new Error("stop");
      const c = await DecdnClient.open({
        gatewayUrl: fake.url,
        fetch: async (input, init) => {
          const r = await fake.fetch(input, init);
          ac.abort(reason);
          return r;
        },
      });
      await expect(
        c.get(`decdn:${blob}`, { retry: true, signal: ac.signal }),
      ).rejects.toBe(reason);
      expect(fake.seen).toHaveLength(1);
    },
  );

  it("fails a body aborted mid-stream with the signal's reason", async () => {
    const { fake, blob } = publicFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            signal?.addEventListener("abort", () =>
              controller.error(signal.reason),
            );
          },
        });
        return Promise.resolve(new Response(body));
      },
    });
    const ac = new AbortController();
    const r = await c.get(`decdn:${blob}`, { signal: ac.signal });
    const reading = r.bytes();
    const reason = new Error("stop");
    ac.abort(reason);
    await expect(reading).rejects.toBe(reason);
  });

  it("fails a window that runs past its declared length with TRUNCATED", async () => {
    const { fake, bundle } = publicFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: async (input, init) => {
        if (new Headers(init?.headers).get("range") === null)
          return fake.fetch(input, init);
        return new Response(new Uint8Array(8), {
          status: 206,
          headers: { "content-length": "2", "content-range": "bytes 0-1/8" },
        });
      },
    });
    const r = await c.get(`decdn:${bundle.hash}/dir%20one/b.bin`, {
      range: { offset: 0, length: 2 },
    });
    expect(r.contentLength).toBe(2);
    await rejects(r.bytes(), "TRUNCATED");
  });

  it("fails a whole entry that runs past its manifest size with TRUNCATED", async () => {
    const { fake, bundle } = publicFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: async (input, init) => {
        const r = await fake.fetch(input, init);
        if (!String(input).endsWith("/a.txt")) return r;
        return new Response("abcdef", { headers: r.headers });
      },
    });
    const r = await c.get(`decdn:${bundle.hash}/a.txt`);
    expect(r.verified).toBe(true);
    const e = await rejects(r.bytes(), "TRUNCATED");
    expect(e.message).toContain("3 bytes");
  });

  it("takes a body longer than its Content-Length, as one decoded on the way", async () => {
    const { fake, blob } = publicFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: () =>
        Promise.resolve(
          new Response("decoded, longer than sent", {
            headers: { "content-length": "4", "content-encoding": "gzip" },
          }),
        ),
    });
    const r = await c.get(`decdn:${blob}`, { verify: false });
    expect(await r.text()).toBe("decoded, longer than sent");
  });

  it.each(["text/html; charset=utf-8", "TEXT/CSS"])(
    "fetches an entry by its hash when its site serves it as %s",
    async (type) => {
      const { fake, bundle } = publicFake();
      const c = await DecdnClient.open({
        gatewayUrl: fake.url,
        fetch: servedAs(fake, type),
      });
      const r = await c.get(`decdn:${bundle.hash}/a.txt?ns=9`);
      expect(r.verified).toBe(true);
      expect(r.contentType).toBe(type);
      expect(await r.text()).toBe("abc");
      const entry = bundle.entries.find((e) => e.path === "a.txt");
      expect(paths(fake)).toEqual([
        `GET decdn.test/${bundle.hash}`,
        `GET 9.${hashToBase32(bundle.hash)}.decdn.test/a.txt`,
        `GET decdn.test/${entry?.hash}?ns=9`,
      ]);
    },
  );

  it(
    "fetches by hash without waiting on a page whose clone is kept unread",
    { timeout: 1000 },
    async () => {
      const { fake, bundle } = publicFake();
      const site = servedAs(fake, "text/html");
      const kept: Response[] = [];
      const c = await DecdnClient.open({
        gatewayUrl: fake.url,
        fetch: async (input, init) => {
          const r = await site(input, init);
          kept.push(r.clone());
          return r;
        },
      });
      const r = await c.get(`decdn:${bundle.hash}/a.txt`);
      expect(await r.text()).toBe("abc");
    },
  );

  it("takes a rewritten type as served when verification is off", async () => {
    const { fake, bundle } = publicFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: servedAs(fake, "text/html"),
      verify: false,
    });
    expect(await (await c.get(`decdn:${bundle.hash}/a.txt`)).text()).toBe(
      "rewritten",
    );
    expect(fake.seen).toHaveLength(1);
  });

  it("retries the fetch by hash after Retry-After when asked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fake, bundle } = publicFake();
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    fake.unfunded.add(entry?.hash ?? "");
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: servedAs(fake, "text/html"),
    });
    const pending = c.get(`decdn:${bundle.hash}/a.txt`, { retry: true });
    await vi.advanceTimersByTimeAsync(1000);
    fake.unfunded.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await (await pending).text()).toBe("abc");
    expect(fake.seen).toHaveLength(4);
  });

  it("knows an entry the manifest lacks is not found without asking for it", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    await rejects(c.get(`decdn:${bundle.hash}/missing.txt`), "NOT_FOUND");
    expect(fake.seen).toHaveLength(1);
  });

  it("caches a manifest by hash", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const m = await c.manifest(bundle.hash);
    expect(m.entries.map((e) => e.path)).toContain("a.txt");
    expect(await c.manifest(`decdn:${bundle.hash}/`)).toBe(m);
    expect(fake.seen).toHaveLength(1);
  });

  it("keeps a manifest read again after an evicted read of it fails", async () => {
    const { fake, bundle } = publicFake();
    const other = fake.addBundle({ "b.txt": "b" });
    let fail = () => {};
    const failed = new Promise<void>((resolve) => (fail = resolve));
    let first = true;
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      manifestCacheSize: 1,
      fetch: async (input, init) => {
        if (first && String(input).endsWith(`/${bundle.hash}`)) {
          first = false;
          await failed;
          return new Response("gone\n", { status: 404 });
        }
        return fake.fetch(input, init);
      },
    });
    const a1 = c.manifest(bundle.hash).catch((e: unknown) => e);
    await c.manifest(other.hash);
    const a2 = c.manifest(bundle.hash);
    fail();
    expect(await a1).toBeInstanceOf(DecdnError);
    const m = await a2;
    expect(await c.manifest(bundle.hash)).toBe(m);
    expect(
      fake.seen.filter((s) => s.url.endsWith(`/${bundle.hash}`)),
    ).toHaveLength(1);
  });

  it("refuses a blob that is not a manifest", async () => {
    const { fake, blob } = publicFake();
    const c = await open(fake);
    await rejects(c.manifest(blob), "MALFORMED_MANIFEST");
  });

  it("resolves an entry to its hash and URLs", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    const r = await c.resolve(`decdn:${bundle.hash}/a.txt?ns=9`);
    expect(r).toEqual({
      kind: "entry",
      hash: bundle.hash,
      entry: { path: "a.txt", hash: entry?.hash, size: 3 },
      siteUrl: `http://9.${hashToBase32(bundle.hash)}.decdn.test/a.txt`,
      bareUrl: `http://decdn.test/${bundle.hash}/a.txt?ns=9`,
    });
    await rejects(c.resolve(`decdn:${bundle.hash}/nope`), "NOT_FOUND");
  });

  it("builds site and namespace URLs", async () => {
    const c = await DecdnClient.open({ gatewayUrl: "https://decdn.link" });
    const h = "ab".repeat(32);
    expect(c.siteUrl(`decdn:${h}/`)).toBe(
      `https://${hashToBase32(h)}.decdn.link/`,
    );
    expect(c.siteUrl(`decdn:${h}/my%20dir/x.txt?ns=4`)).toBe(
      `https://4.${hashToBase32(h)}.decdn.link/my%20dir/x.txt`,
    );
    expect(c.namespaceUrl(42n)).toBe("https://42.decdn.link/");
    expect(c.namespaceUrl(42)).toBe("https://42.decdn.link/");
  });

  it("reads an entry's size and hash from HEAD", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    expect(await c.head(`decdn:${bundle.hash}/a.txt`)).toEqual({
      size: 3,
      hash: entry?.hash,
      contentType: "text/plain; charset=utf-8",
    });
    expect(fake.seen.map((s) => s.method)).toEqual(["HEAD"]);
  });

  it("reads a raw blob's size and hash from HEAD", async () => {
    const { fake, blob } = publicFake();
    const c = await open(fake);
    expect(await c.head(`decdn:${blob}`)).toEqual({
      size: 11,
      hash: blob,
      contentType: "application/octet-stream",
    });
    expect(fake.seen.map((s) => s.method)).toEqual(["HEAD"]);
  });

  it("maps a raw blob's HEAD refusals as its GET's", async () => {
    const { fake, blob } = publicFake(0);
    const c = await open(fake);
    await rejects(c.head(`decdn:${blob}`), "PAYMENT_REQUIRED");
    const funded = publicFake();
    funded.fake.unfunded.add(funded.blob);
    const d = await open(funded.fake);
    await rejects(d.head(`decdn:${funded.blob}`), "POOL_UNFUNDED");
  });

  it("serves a bundle as its site index, unverified", async () => {
    const { fake, bundle } = publicFake();
    const c = await open(fake);
    const r = await c.get(`decdn:${bundle.hash}/`);
    expect(r.verified).toBe("skipped");
    expect(await r.text()).toContain("/_decdn/");
  });

  it("maps a failed fetch to NETWORK", async () => {
    const c = await DecdnClient.open({
      gatewayUrl: "https://decdn.test",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await rejects(c.get(`decdn:${"ab".repeat(32)}`), "NETWORK");
  });

  it("rejects a bad URI before any request", async () => {
    const { fake } = publicFake();
    const c = await open(fake);
    await rejects(c.get("decdn:nope"), "BAD_URI");
    expect(fake.seen).toHaveLength(0);
  });
});

describe("loopback context", () => {
  function loopbackFake() {
    const fake = new FakeGateway({ mode: "loopback", token: TOKEN });
    const bundle = fake.addBundle({ "a.txt": "abc", "index.html": "<p>x</p>" });
    const blob = fake.addBlob("loop bytes");
    fake.scopes.push("example.com");
    return { fake, bundle, blob };
  }

  async function openLoop(
    fake: FakeGateway,
    token = TOKEN,
    host = "example.com",
  ) {
    return DecdnClient.open({
      gatewayUrl: fake.url,
      token,
      host,
      fetch: fake.fetch,
    });
  }

  it("sends the token and host and verifies a blob", async () => {
    const { fake, blob } = loopbackFake();
    const c = await openLoop(fake);
    const r = await c.get(`decdn:${blob}`);
    expect(r.verified).toBe(true);
    expect(await r.text()).toBe("loop bytes");
    expect(fake.seen[0]?.headers.get("x-decdn-token")).toBe(TOKEN);
    expect(fake.seen[0]?.headers.get("x-decdn-host")).toBe("example.com");
  });

  it("fetches an entry on the bare host, byte-exact, and verifies it", async () => {
    const { fake, bundle } = loopbackFake();
    const c = await openLoop(fake);
    const r = await c.get(`decdn:${bundle.hash}/index.html`);
    expect(r.verified).toBe(true);
    expect(await r.text()).toBe("<p>x</p>");
    expect(paths(fake)).toEqual([
      `GET 127.0.0.1:8484/${bundle.hash}`,
      `GET 127.0.0.1:8484/${bundle.hash}/index.html`,
    ]);
  });

  it("maps a wrong token to UNAUTHORIZED and an uncovered host to PAYMENT_REQUIRED", async () => {
    const { fake, blob } = loopbackFake();
    await rejects(
      (await openLoop(fake, "00".repeat(32))).get(`decdn:${blob}`),
      "UNAUTHORIZED",
    );
    const e = await rejects(
      (await openLoop(fake, TOKEN, "other.org")).get(`decdn:${blob}`),
      "PAYMENT_REQUIRED",
    );
    expect(e.body).toBe("no capability covers other.org");
    expect(e.fallbackUri).toBeUndefined();
  });

  it("answers HEAD from the manifest, since a loopback gateway refuses HEAD", async () => {
    const { fake, bundle } = loopbackFake();
    const c = await openLoop(fake);
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    expect(await c.head(`decdn:${bundle.hash}/a.txt`)).toEqual({
      size: 3,
      hash: entry?.hash,
      contentType: "text/plain; charset=utf-8",
    });
    expect(fake.seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("does not refetch by hash, where the bare host serves entries unrewritten", async () => {
    const { fake, bundle } = loopbackFake();
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      token: TOKEN,
      host: "example.com",
      fetch: async (input, init) => {
        const r = await fake.fetch(input, init);
        if (!String(input).endsWith("/a.txt")) return r;
        return new Response("abc!", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    await rejects(
      (await c.get(`decdn:${bundle.hash}/a.txt`)).bytes(),
      "TRUNCATED",
    );
    expect(fake.seen).toHaveLength(2);
  });

  it("builds site URLs under localhost on the gateway's port", async () => {
    const { fake, bundle } = loopbackFake();
    const c = await openLoop(fake);
    expect(c.siteUrl(`decdn:${bundle.hash}/a.txt`)).toBe(
      `http://${hashToBase32(bundle.hash)}.localhost:8484/a.txt`,
    );
  });
});

describe("site context", () => {
  function onSite(fake: FakeGateway, host: string) {
    vi.stubGlobal("location", new URL(`http://${host}/`));
    vi.stubGlobal("fetch", fake.fetch);
  }

  it("is detected on a site origin and reads its own entries same-origin", async () => {
    const { fake, bundle } = publicFake();
    onSite(fake, `${hashToBase32(bundle.hash)}.decdn.test`);
    const c = await DecdnClient.open();
    expect(c.context).toBe("site");
    const r = await c.get("/a.txt");
    expect(r.verified).toBe(true);
    expect(await r.text()).toBe("abc");
    const label = hashToBase32(bundle.hash);
    expect(paths(fake)).toEqual([
      `GET ${label}.decdn.test/_decdn/${bundle.hash}`,
      `GET ${label}.decdn.test/a.txt`,
    ]);
  });

  it("reads other content through /_decdn/", async () => {
    const { fake, bundle, blob } = publicFake();
    onSite(fake, `${hashToBase32(bundle.hash)}.decdn.test`);
    const c = await DecdnClient.open();
    expect(await (await c.get(`decdn:${blob}`)).text()).toBe("other bytes");
    expect(paths(fake)).toEqual([
      `GET ${hashToBase32(bundle.hash)}.decdn.test/_decdn/${blob}`,
    ]);
  });

  it("is detected on a namespace host under the configured gateway, where the manifest is unknown", async () => {
    const { fake, bundle } = publicFake();
    fake.pointers.set(7n, bundle.hash);
    onSite(fake, "7.decdn.test");
    const c = await DecdnClient.open({ gatewayUrl: "http://decdn.test" });
    expect(c.context).toBe("site");
    const r = await c.get("/a.txt");
    expect(r.verified).toBe("skipped");
    expect(await r.text()).toBe("abc");
    await rejects(c.manifest(), "CONFIG");
  });

  it("keeps the page's query on its own entries and leaves the namespace to the host", async () => {
    const { fake, bundle } = publicFake();
    const label = hashToBase32(bundle.hash);
    onSite(fake, `7.${label}.decdn.test`);
    const c = await DecdnClient.open();
    expect(await (await c.get("/a.txt?v=2#top")).text()).toBe("abc");
    expect(await (await c.get(`decdn:${bundle.hash}/a.txt`)).text()).toBe(
      "abc",
    );
    expect(paths(fake)).toEqual([
      `GET 7.${label}.decdn.test/_decdn/${bundle.hash}`,
      `GET 7.${label}.decdn.test/a.txt?v=2`,
      `GET 7.${label}.decdn.test/a.txt`,
    ]);
  });

  it("fetches its own entry by hash through /_decdn/ when the site serves it as a rewritten type", async () => {
    const { fake, bundle } = publicFake();
    const label = hashToBase32(bundle.hash);
    onSite(fake, `${label}.decdn.test`);
    vi.stubGlobal("fetch", servedAs(fake, "text/html"));
    const c = await DecdnClient.open();
    const r = await c.get("/a.txt");
    expect(r.verified).toBe(true);
    expect(await r.text()).toBe("abc");
    const entry = bundle.entries.find((e) => e.path === "a.txt");
    expect(paths(fake)).toEqual([
      `GET ${label}.decdn.test/_decdn/${bundle.hash}`,
      `GET ${label}.decdn.test/a.txt`,
      `GET ${label}.decdn.test/_decdn/${entry?.hash}`,
    ]);
  });

  it("opens a loopback gateway named by URL, for its delegate API", async () => {
    const fake = new FakeGateway({ mode: "loopback", token: TOKEN });
    const page = `http://${hashToBase32("ab".repeat(32))}.localhost:8484`;
    vi.stubGlobal("location", new URL(`${page}/`));
    const c = await DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: (input, init) =>
        fake.fetch(input, {
          ...init,
          headers: { ...(init?.headers as object), origin: page },
        }),
    });
    expect(c.context).toBe("loopback");
    expect(c.origin).toBe(new URL(fake.url).origin);
    expect((await c.loopback.delegate()).address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(paths(fake)).toEqual([`GET ${new URL(fake.url).host}/_delegate`]);
  });

  it("opens the gateway a token names, and the site without a gateway URL", async () => {
    const { fake, bundle } = publicFake();
    onSite(fake, `${hashToBase32(bundle.hash)}.decdn.test`);
    const withToken = await DecdnClient.open({
      gatewayUrl: "http://gw.test",
      token: TOKEN,
      host: "example.com",
    });
    expect(withToken.context).toBe("loopback");
    expect(withToken.origin).toBe("http://gw.test");
    const tokenOnly = await DecdnClient.open({
      token: TOKEN,
      host: "example.com",
    });
    expect(tokenOnly.context).toBe("site");
  });

  it("does not take an arbitrary numeric subdomain for a namespace host", async () => {
    const { fake } = publicFake();
    onSite(fake, "7.example.com");
    await rejects(DecdnClient.open(), "CONFIG");
  });
});
