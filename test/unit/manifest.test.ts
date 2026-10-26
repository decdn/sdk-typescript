// Cases ported from crates/client/src/bundle/engine/tests.rs
// (`parse_manifest_*`): the SDK accepts the manifests `BundleManifest::parse`
// accepts and refuses the rest.
import { describe, expect, it } from "vitest";
import { blake3Hex, DecdnError, parseManifest } from "../../src/index.js";

const AB = "ab".repeat(32);
const CD = "cd".repeat(32);

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function malformed(bytes: Uint8Array): string {
  try {
    parseManifest(bytes);
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    expect((e as DecdnError).code).toBe("MALFORMED_MANIFEST");
    return (e as DecdnError).message;
  }
  throw new Error("parsed");
}

describe("parseManifest", () => {
  it("accepts v1 with an optional size", () => {
    const m = parseManifest(
      encode({
        version: 1,
        entries: [
          { path: "a.txt", hash: `b3:${AB}`, size: 4 },
          { path: "b", hash: `b3:${CD}` },
        ],
      }),
    );
    expect(m.entries).toEqual([
      { path: "a.txt", hash: AB, size: 4 },
      { path: "b", hash: CD },
    ]);
  });

  it("keeps the blob hash", () => {
    const bytes = new TextEncoder().encode('{"version":1,"entries":[]}');
    expect(parseManifest(bytes).hash).toBe(blake3Hex(bytes));
  });

  it("accepts a chunked entry in order", () => {
    const m = parseManifest(
      encode({
        version: 1,
        entries: [
          {
            path: "m.bin",
            hash: `b3:${"ff".repeat(32)}`,
            size: 100,
            chunks: [
              { hash: `b3:${"c0".repeat(32)}`, size: 60 },
              { hash: `b3:${"c1".repeat(32)}`, size: 40 },
            ],
          },
        ],
      }),
    );
    expect(m.entries[0]?.chunks?.map((c) => c.hash)).toEqual([
      "c0".repeat(32),
      "c1".repeat(32),
    ]);
  });

  it("accepts every hash spelling", () => {
    for (const spelling of [
      `b3:${AB}`,
      `0x${AB}`,
      AB,
      `b3:${AB.toUpperCase()}`,
    ]) {
      const m = parseManifest(
        encode({ version: 1, entries: [{ path: "a", hash: spelling }] }),
      );
      expect(m.entries[0]?.hash, spelling).toBe(AB);
    }
  });

  it("rejects a malformed entry or chunk hash and names the entry", () => {
    for (const bad of [
      "zz",
      "",
      `b3:${AB.slice(0, 62)}`,
      `b3:${AB}ab`,
      `B3:${AB}`,
    ]) {
      const why = malformed(
        encode({
          version: 1,
          entries: [
            { path: "ok", hash: `b3:${AB}` },
            { path: "bad", hash: bad },
          ],
        }),
      );
      expect(why, bad).toContain('bundle entry "bad" has a malformed hash');
    }
    const why = malformed(
      encode({
        version: 1,
        entries: [
          {
            path: "bad",
            hash: `b3:${AB}`,
            size: 4,
            chunks: [
              { hash: `b3:${AB}`, size: 2 },
              { hash: "b3:zz", size: 2 },
            ],
          },
        ],
      }),
    );
    expect(why).toContain('bundle entry "bad" has a malformed chunk 1 hash');
  });

  it("checks the version before the hashes", () => {
    const why = malformed(
      new TextEncoder().encode(
        '{"version":2,"entries":[{"path":"a","hash":"sha256:00"}]}',
      ),
    );
    expect(why).toContain("unsupported bundle version 2");
  });

  it("rejects what is not a manifest", () => {
    for (const bad of [
      "not json",
      "[]",
      "{}",
      '{"version":1}',
      '{"entries":[]}',
      '{"version":"1","entries":[]}',
      '{"version":1,"entries":{}}',
      '{"version":1,"entries":[{"hash":"' + AB + '"}]}',
      '{"version":1,"entries":[{"path":"a","hash":"' + AB + '","size":-1}]}',
      '{"version":1,"entries":[{"path":"a","hash":"' + AB + '","size":1.5}]}',
    ]) {
      malformed(new TextEncoder().encode(bad));
    }
  });

  it("refuses bytes that do not hash to the expected manifest hash", () => {
    const bytes = encode({ version: 1, entries: [] });
    expect(() => parseManifest(bytes, AB)).toThrow(
      expect.objectContaining({ code: "HASH_MISMATCH" }),
    );
    expect(parseManifest(bytes, blake3Hex(bytes)).entries).toEqual([]);
  });
});
