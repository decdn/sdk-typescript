import { describe, expect, it } from "vitest";
import {
  DecdnClient,
  DecdnError,
  pointerSigningHash,
  pointerTypedData,
  recoverPointerSigner,
  signPointer,
  type TypedDataSigner,
} from "../../src/index.js";
import { FakeGateway } from "../fake-gateway.js";
import fixture from "../fixtures/pointer.json" with { type: "json" };

const domain = {
  chainId: fixture.chainId,
  publisherRegistry: fixture.publisherRegistry,
};
const pointer = {
  namespace: BigInt(fixture.namespace),
  root: fixture.root,
  seq: BigInt(fixture.seq),
};
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("pointer EIP-712", () => {
  it("hashes the pointer to the Rust signing hash", () => {
    expect(pointerSigningHash(domain, pointer)).toBe(fixture.signingHash);
  });

  it("signs with a raw key to the Rust signature, byte for byte", async () => {
    expect(
      await signPointer(domain, pointer, { privateKey: fixture.privateKey }),
    ).toBe(fixture.signature);
  });

  it("recovers the owner from the signature", () => {
    expect(recoverPointerSigner(domain, pointer, fixture.signature)).toBe(
      fixture.address.toLowerCase(),
    );
  });

  it("describes the typed data a wallet signs", () => {
    expect(pointerTypedData(domain, pointer)).toEqual({
      domain: {
        name: "decdn-pointer",
        version: "1",
        chainId: BigInt(fixture.chainId),
        verifyingContract: fixture.publisherRegistry,
      },
      types: {
        Pointer: [
          { name: "namespaceId", type: "uint256" },
          { name: "root", type: "bytes32" },
          { name: "seq", type: "uint64" },
        ],
      },
      primaryType: "Pointer",
      message: {
        namespaceId: pointer.namespace,
        root: `0x${fixture.root}`,
        seq: pointer.seq,
      },
    });
  });

  it("normalises a wallet's high-s, 0/1-v signature to low-s, 27/28", async () => {
    const sig = fixture.signature.slice(2);
    const r = sig.slice(0, 64);
    const s = BigInt(`0x${sig.slice(64, 128)}`);
    const v = parseInt(sig.slice(128), 16);
    const high = (N - s).toString(16).padStart(64, "0");
    const flipped = (v === 27 ? 1 : 0).toString(16).padStart(2, "0");
    const wallet: TypedDataSigner = {
      signTypedData: () => Promise.resolve(`0x${r}${high}${flipped}`),
    };
    expect(await signPointer(domain, pointer, wallet)).toBe(fixture.signature);
  });
});

describe("pointer.set", () => {
  function gateway() {
    const fake = new FakeGateway({ mode: "public" });
    fake.pointerDomain = domain;
    fake.owners.set(pointer.namespace, fixture.address.toLowerCase());
    return fake;
  }

  async function open(fake: FakeGateway, withDomain = true) {
    return DecdnClient.open({
      gatewayUrl: fake.url,
      fetch: fake.fetch,
      ...(withDomain ? { pointer: domain } : {}),
    });
  }

  it("PUTs a signed pointer and the namespace host serves the bundle", async () => {
    const fake = gateway();
    const bundle = fake.addBundle({ "index.html": "<p>hi</p>" });
    const c = await open(fake);
    const set = await c.pointer.set({
      namespace: 7n,
      root: `decdn:${bundle.hash}/`,
      seq: 5n,
      signer: { privateKey: fixture.privateKey },
    });
    expect(set).toEqual({
      namespace: 7n,
      root: bundle.hash,
      seq: 5n,
      url: "http://7.decdn.test/",
    });
    expect(fake.seen[0]?.method).toBe("PUT");
    expect(await (await c.get(`decdn:${bundle.hash}/index.html`)).text()).toBe(
      "<p>hi</p>",
    );
    expect(
      await (await fetchVia(fake, "http://7.decdn.test/index.html")).text(),
    ).toBe("<p>hi</p>");
  });

  it("maps a replayed seq to CONFLICT with the held seq", async () => {
    const fake = gateway();
    const bundle = fake.addBundle({ "a.txt": "a" });
    const c = await open(fake);
    const signer = { privateKey: fixture.privateKey };
    await c.pointer.set({ namespace: 7n, root: bundle.hash, seq: 9n, signer });
    const e = await c.pointer
      .set({ namespace: 7n, root: bundle.hash, seq: 9n, signer })
      .catch((e: unknown) => e as DecdnError);
    expect(e).toBeInstanceOf(DecdnError);
    expect((e as DecdnError).code).toBe("CONFLICT");
    expect((e as DecdnError).seq).toBe(9n);
  });

  it("refuses a signer that does not own the namespace", async () => {
    const fake = gateway();
    const bundle = fake.addBundle({ "a.txt": "a" });
    const c = await open(fake);
    const e = await c.pointer
      .set({
        namespace: 7n,
        root: bundle.hash,
        signer: { privateKey: `0x${"33".repeat(32)}` },
      })
      .catch((e: unknown) => e as DecdnError);
    expect((e as DecdnError).code).toBe("FORBIDDEN");
  });

  it("needs the chain and registry, a public gateway, and a bundle root", async () => {
    const fake = gateway();
    const signer = { privateKey: fixture.privateKey };
    const set = (c: DecdnClient, root = fixture.root) =>
      c.pointer
        .set({ namespace: 7n, root, signer })
        .catch((e: unknown) => (e as DecdnError).code);
    expect(await set(await open(fake, false))).toBe("CONFIG");
    const loop = await DecdnClient.open({
      gatewayUrl: "http://127.0.0.1:8484",
      pointer: domain,
    });
    expect(await set(loop)).toBe("CONFIG");
    expect(await set(await open(fake), `decdn:${fixture.root}`)).toBe(
      "BAD_URI",
    );
    expect(fake.seen).toHaveLength(0);
  });

  it("refuses a chain id, namespace or seq that does not encode exactly", async () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as DecdnError).code;
      }
      return "returned";
    };
    for (const chainId of [-1, 0, 1.5, 2 ** 53 + 2, 1n << 256n]) {
      const bad = { ...domain, chainId };
      expect(code(() => pointerSigningHash(bad, pointer))).toBe("CONFIG");
      expect(code(() => pointerTypedData(bad, pointer))).toBe("CONFIG");
    }
    const widest = { ...domain, chainId: (1n << 256n) - 1n };
    expect(pointerSigningHash(widest, pointer)).toMatch(/^0x[0-9a-f]{64}$/);
    const fake = gateway();
    const c = await open(fake);
    const signer = { privateKey: fixture.privateKey };
    const set = (namespace: number, seq?: number) =>
      c.pointer
        .set({
          namespace,
          root: fixture.root,
          signer,
          ...(seq === undefined ? {} : { seq }),
        })
        .catch((e: unknown) => (e as DecdnError).code);
    expect(await set(1.5)).toBe("CONFIG");
    expect(await set(2 ** 53 + 2)).toBe("CONFIG");
    expect(await set(7, 2 ** 53 + 2)).toBe("CONFIG");
    expect(c.namespaceUrl.bind(c, 1.5)).toThrow(DecdnError);
    expect(fake.seen).toHaveLength(0);
  });

  it("defaults seq to the current Unix second", async () => {
    const fake = gateway();
    const bundle = fake.addBundle({ "a.txt": "a" });
    const c = await open(fake);
    const before = BigInt(Math.floor(Date.now() / 1000));
    const set = await c.pointer.set({
      namespace: 7n,
      root: bundle.hash,
      signer: { privateKey: fixture.privateKey },
    });
    expect(set.seq >= before && set.seq <= before + 2n).toBe(true);
  });
});

function fetchVia(fake: FakeGateway, url: string) {
  return fake.fetch(url);
}
