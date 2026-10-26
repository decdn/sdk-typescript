// Bundle manifests, as `BundleManifest::parse` reads them
// (https://github.com/decdn/decdn/blob/main/crates/client/src/bundle.rs): `{"version":1,"entries":[{"path","hash","size"?,"chunks"?}]}`,
// the version checked before any hash, every hash 64 hex characters after an
// optional `b3:` or `0x`.
import { DecdnError } from "./errors.js";
import { blake3Hex } from "./hash.js";
import { isHash } from "./hex.js";

/** The largest manifest the gateway pulls, and the SDK reads (64 MiB). */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** One chunk of an entry: an independently addressed run of its bytes. */
export interface ManifestChunk {
  hash: string;
  size: number;
}

/** One file of a bundle. */
export interface ManifestEntry {
  /** The entry's relative POSIX path: what a `decdn:<hash>/<path>` URI names. */
  path: string;
  /** The BLAKE3 hash of the whole file, 64 lowercase hex characters. */
  hash: string;
  /** The file's size in bytes, when the manifest declares it. */
  size?: number;
  /** The file's chunk decomposition, a dedup hint. */
  chunks?: ManifestChunk[];
}

/** A parsed bundle manifest. */
export interface BundleManifest {
  /** The manifest blob's BLAKE3 hash: what `decdn:<hash>/` names. */
  hash: string;
  entries: ManifestEntry[];
}

function malformed(message: string): DecdnError {
  return new DecdnError("MALFORMED_MANIFEST", message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function parseHash(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const hex = s.startsWith("0x")
    ? s.slice(2)
    : s.startsWith("b3:")
      ? s.slice(3)
      : s;
  return isHash(hex) ? hex.toLowerCase() : undefined;
}

function parseEntry(raw: unknown, i: number): ManifestEntry {
  if (!isRecord(raw) || typeof raw.path !== "string") {
    throw malformed(`bundle entry ${i} has no string \`path\``);
  }
  const path = raw.path;
  const named = JSON.stringify(path);
  const hash = parseHash(raw.hash);
  if (hash === undefined) {
    throw malformed(
      `bundle entry ${named} has a malformed hash: ${JSON.stringify(raw.hash)}`,
    );
  }
  const entry: ManifestEntry = { path, hash };
  if (raw.size !== undefined && raw.size !== null) {
    if (!isSize(raw.size))
      throw malformed(`bundle entry ${named} has a malformed size`);
    entry.size = raw.size;
  }
  if (raw.chunks !== undefined && raw.chunks !== null) {
    if (!Array.isArray(raw.chunks))
      throw malformed(`bundle entry ${named} has malformed chunks`);
    entry.chunks = raw.chunks.map((c: unknown, n) => {
      const chunkHash = isRecord(c) ? parseHash(c.hash) : undefined;
      if (!isRecord(c) || chunkHash === undefined) {
        throw malformed(
          `bundle entry ${named} has a malformed chunk ${n} hash`,
        );
      }
      if (!isSize(c.size))
        throw malformed(
          `bundle entry ${named} has a malformed chunk ${n} size`,
        );
      return { hash: chunkHash, size: c.size };
    });
  }
  return entry;
}

/**
 * Parse manifest bytes. With `expectedHash`, the bytes must hash to it first
 * (`HASH_MISMATCH` otherwise). Anything that is not a v1 manifest is
 * `MALFORMED_MANIFEST`.
 */
export function parseManifest(
  bytes: Uint8Array,
  expectedHash?: string,
): BundleManifest {
  const hash = blake3Hex(bytes);
  if (expectedHash !== undefined && hash !== expectedHash.toLowerCase()) {
    throw new DecdnError(
      "HASH_MISMATCH",
      `bundle manifest hashes to ${hash}, not ${expectedHash.toLowerCase()}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new DecdnError(
      "MALFORMED_MANIFEST",
      "parse bundle JSON (expected v1 manifest)",
      {
        cause: e,
      },
    );
  }
  if (
    !isRecord(json) ||
    typeof json.version !== "number" ||
    !Array.isArray(json.entries)
  ) {
    throw malformed(
      "parse bundle JSON (expected v1 manifest): missing `version` or `entries`",
    );
  }
  if (json.version !== 1) {
    throw malformed(
      `unsupported bundle version ${json.version} (this SDK supports v1)`,
    );
  }
  return { hash, entries: json.entries.map(parseEntry) };
}
