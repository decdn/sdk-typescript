// `decdn:` URIs, the grammar of the Rust client
// (https://github.com/decdn/decdn/blob/main/crates/client/src/uri.rs):
//
//   decdn:<hash>[/<path>][?ns=<id>]
//
// `<hash>` is 64 hex characters (no `b3:`/`0x`), a trailing `/` names a
// bundle, `<path>` is a manifest entry path with each segment an RFC 3986
// `pchar`, and `ns` is a decimal namespace id of at least 1.
import { DecdnError } from "./errors.js";
import { isHash } from "./hex.js";

/** The scheme prefix of every `decdn:` URI. */
export const SCHEME = "decdn:";

const U64_MAX = (1n << 64n) - 1n;

/** A parsed `decdn:` URI. */
export interface DecdnUri {
  /** The BLAKE3 hash, 64 lowercase hex characters: of the blob, or of the bundle manifest. */
  hash: string;
  /** What the hash names: a raw blob, a whole bundle, or one entry of a bundle. */
  kind: "blob" | "bundle" | "entry";
  /** The decoded manifest path of an entry. */
  path?: string;
  /** The namespace routing hint, never `0n`. */
  namespace?: bigint;
}

function bad(message: string): DecdnError {
  return new DecdnError("BAD_URI", message);
}

/** An RFC 3986 `pchar` other than `%`: unreserved, sub-delims, `:` and `@`. */
function isPchar(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    "-._~!$&'()*+,;=:@".includes(String.fromCharCode(b))
  );
}

function hexValue(c: string | undefined): number | undefined {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c)
    ? parseInt(c, 16)
    : undefined;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeSegment(segment: string): string {
  const out: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (c === 0x25) {
      const hi = hexValue(segment[i + 1]);
      const lo = hexValue(segment[i + 2]);
      if (hi === undefined || lo === undefined) {
        throw bad("invalid bundle entry path in decdn URI: bad `%` escape");
      }
      out.push((hi << 4) | lo);
      i += 2;
    } else if (c < 0x80 && isPchar(c)) {
      out.push(c);
    } else {
      throw bad(
        `invalid bundle entry path in decdn URI: character ${JSON.stringify(segment[i])} must be percent-encoded`,
      );
    }
  }
  try {
    return utf8.decode(new Uint8Array(out));
  } catch {
    throw bad("invalid bundle entry path in decdn URI: not UTF-8 once decoded");
  }
}

function decodePath(raw: string): string {
  const segments = raw.split("/").map((segment) => {
    const decoded = decodeSegment(segment);
    let why: string | undefined;
    if (decoded === "")
      why =
        "empty segment (a leading, trailing or doubled `/` inside the path)";
    else if (decoded === "." || decoded === "..")
      why = `\`${decoded}\` segment`;
    else if (decoded.includes("/")) why = "encoded `/` (`%2F`) in a segment";
    else if (decoded.includes("\0")) why = "NUL byte";
    if (why !== undefined)
      throw bad(`invalid bundle entry path in decdn URI: ${why}`);
    return decoded;
  });
  return segments.join("/");
}

function badNamespace(why: string): DecdnError {
  return bad(
    `invalid namespace in decdn URI (${why}): expected \`ns=<id>\` with a decimal id of at least 1; omit \`ns\` for no namespace`,
  );
}

function badQuery(why: string): DecdnError {
  return bad(`invalid query in decdn URI (${why}): the only key is \`ns\``);
}

function parseQuery(query: string): bigint {
  let namespace: bigint | undefined;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw badQuery(`\`${pair}\` is not \`key=value\``);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key !== "ns") throw badQuery(`unknown key \`${key}\``);
    if (namespace !== undefined) throw badQuery("`ns` given twice");
    if (!/^[0-9]+$/.test(value))
      throw badNamespace(`\`${value}\` is not a decimal id`);
    const id = BigInt(value);
    if (id > U64_MAX) throw badNamespace(`\`${value}\` is out of range`);
    if (id === 0n) throw badNamespace("0 means no namespace");
    namespace = id;
  }
  if (namespace === undefined) throw badQuery("empty query");
  return namespace;
}

/**
 * Parse a `decdn:` URI. Throws a {@link DecdnError} with code `BAD_URI` for
 * anything the Rust client would refuse.
 */
export function parseUri(s: string): DecdnUri {
  if (!s.startsWith(SCHEME))
    throw bad("not a decdn URI: expected `decdn:<hash>`");
  const rest = s.slice(SCHEME.length);
  if (rest.startsWith("//")) {
    throw bad(
      "a decdn URI has no `//`: write `decdn:<hash>`, not `decdn://<hash>`",
    );
  }
  const q = rest.indexOf("?");
  const body = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? undefined : rest.slice(q + 1);
  const slash = body.indexOf("/");
  const hash = slash < 0 ? body : body.slice(0, slash);
  const path = slash < 0 ? undefined : body.slice(slash + 1);
  if (!isHash(hash)) {
    const why = hash.length !== 64 ? `${hash.length} characters` : "not hex";
    throw bad(
      `invalid hash in decdn URI (${why}): expected 64 hex characters with no \`b3:\` or \`0x\` prefix`,
    );
  }
  const uri: DecdnUri = { hash: hash.toLowerCase(), kind: "blob" };
  if (path === "") uri.kind = "bundle";
  else if (path !== undefined) {
    uri.kind = "entry";
    uri.path = decodePath(path);
  }
  if (query !== undefined) uri.namespace = parseQuery(query);
  return uri;
}

function encodeSegment(segment: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(segment)) {
    out += isPchar(b)
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The canonical string of `uri`: lowercase hex, uppercase `%XX` escapes. */
export function formatUri(uri: DecdnUri): string {
  let out = SCHEME + uri.hash.toLowerCase();
  if (uri.kind === "bundle") out += "/";
  else if (uri.kind === "entry") {
    for (const segment of (uri.path ?? "").split("/"))
      out += `/${encodeSegment(segment)}`;
  }
  if (uri.namespace !== undefined) out += `?ns=${uri.namespace}`;
  return out;
}
