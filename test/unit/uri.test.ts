// Cases ported from the Rust client's URI tests
// (https://github.com/decdn/decdn/blob/main/crates/client/src/uri/tests.rs):
// the SDK accepts and rejects exactly what the Rust `decdn:` grammar does.
import { describe, expect, it } from "vitest";
import {
  DecdnError,
  formatUri,
  parseUri,
  type DecdnUri,
} from "../../src/index.js";

const HEX = "ce88d839ce93b3d62c500567602ea372a9b6b043866bdf327e508f7226efe06e";

function badUri(s: string): string {
  try {
    parseUri(s);
  } catch (e) {
    expect(e).toBeInstanceOf(DecdnError);
    expect((e as DecdnError).code).toBe("BAD_URI");
    return (e as DecdnError).message;
  }
  throw new Error(`parsed: ${s}`);
}

describe("parseUri", () => {
  it("parses every target kind", () => {
    expect(parseUri(`decdn:${HEX}`)).toEqual<DecdnUri>({
      hash: HEX,
      kind: "blob",
    });
    expect(parseUri(`decdn:${HEX}/`)).toEqual<DecdnUri>({
      hash: HEX,
      kind: "bundle",
    });
    expect(parseUri(`decdn:${HEX}/a/b.txt`)).toEqual<DecdnUri>({
      hash: HEX,
      kind: "entry",
      path: "a/b.txt",
    });
  });

  it("parses the namespace hint on every target kind", () => {
    for (const suffix of ["", "/", "/a/b.txt"]) {
      expect(parseUri(`decdn:${HEX}${suffix}?ns=42`).namespace).toBe(42n);
    }
  });

  it("round-trips the canonical form", () => {
    for (const s of [
      `decdn:${HEX}`,
      `decdn:${HEX}/`,
      `decdn:${HEX}/a/b.txt`,
      `decdn:${HEX}/a/b.txt?ns=42`,
      `decdn:${HEX}/?ns=1`,
      `decdn:${HEX}/my%20model/weights%5B0%5D.bin`,
      `decdn:${HEX}/caf%C3%A9.txt`,
    ]) {
      const uri = parseUri(s);
      expect(formatUri(uri)).toBe(s);
      expect(parseUri(formatUri(uri))).toEqual(uri);
    }
  });

  it("parses uppercase hex and prints lowercase", () => {
    const uri = parseUri(`decdn:${HEX.toUpperCase()}`);
    expect(uri.hash).toBe(HEX);
    expect(formatUri(uri)).toBe(`decdn:${HEX}`);
  });

  it("decodes percent-encoded segments to the literal manifest path", () => {
    expect(parseUri(`decdn:${HEX}/dir%20one/%5Bx%5D*%3F%7B%7D.bin`).path).toBe(
      "dir one/[x]*?{}.bin",
    );
  });

  it("keeps a namespace beyond 2^53 exact", () => {
    const max = "18446744073709551615";
    expect(parseUri(`decdn:${HEX}?ns=${max}`).namespace).toBe(BigInt(max));
  });

  it("rejects a missing scheme or an authority", () => {
    expect(badUri(HEX)).toMatch(/not a decdn URI/);
    expect(badUri(`decdn://${HEX}`)).toMatch(/no `\/\/`/);
  });

  it("rejects prefixed, short, long or non-hex hashes", () => {
    for (const bad of [
      `decdn:b3:${HEX}`,
      `decdn:0x${HEX}`,
      `decdn:${HEX.slice(0, 63)}`,
      `decdn:${HEX}0`,
      `decdn:${HEX.slice(0, 63)}g`,
    ]) {
      expect(badUri(bad), bad).toMatch(/invalid hash/);
    }
  });

  it("rejects bad namespaces", () => {
    for (const bad of [
      "ns=0",
      "ns=",
      "ns=-1",
      "ns=+1",
      "ns=1.5",
      "ns=x",
      "ns=18446744073709551616",
    ]) {
      expect(badUri(`decdn:${HEX}?${bad}`), bad).toMatch(/invalid namespace/);
    }
  });

  it("rejects an unknown, duplicate or empty query", () => {
    for (const bad of ["ns=1&x=2", "x=1", "ns=1&ns=2", "", "ns"]) {
      expect(badUri(`decdn:${HEX}?${bad}`), bad).toMatch(/invalid query/);
    }
  });

  it("rejects unsafe or malformed entry paths", () => {
    for (const bad of [
      "/../x",
      "/a/../b",
      "/./a",
      "//a",
      "/a//b",
      "/a/",
      "/a%2Fb",
      "/a%00b",
      "/a b",
      "/%zz",
      "/%4",
      "/%FF",
      "/a#b",
    ]) {
      expect(badUri(`decdn:${HEX}${bad}`), bad).toMatch(
        /invalid bundle entry path/,
      );
    }
  });
});

describe("formatUri", () => {
  it("encodes what is not a pchar", () => {
    expect(
      formatUri({ hash: HEX, kind: "entry", path: "dir one/[x]?#%.bin" }),
    ).toBe(`decdn:${HEX}/dir%20one/%5Bx%5D%3F%23%25.bin`);
  });

  it("writes a namespace hint", () => {
    expect(formatUri({ hash: HEX, kind: "bundle", namespace: 7n })).toBe(
      `decdn:${HEX}/?ns=7`,
    );
  });
});
