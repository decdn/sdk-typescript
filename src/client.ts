// The client: one of three contexts over a `decdn gateway`.
//
// - `public`: a gateway with `--public-url`; blobs from the bare host, entries
//   from their site host, every request paid by the operator.
// - `loopback`: the local gateway with its token; every request on the bare
//   host, paid by the capability that covers `host`. A page reaches it
//   without the token, for `/_delegate` and `/_capability` alone.
// - `site`: a page served from a site origin; its own entries same-origin and
//   other content through `/_decdn/`.
import { base32ToHash, hashToBase32 } from "./base32.js";
import { DecdnError } from "./errors.js";
import { sendOk, type Fetch } from "./http.js";
import { isHash } from "./hex.js";
import {
  MAX_MANIFEST_BYTES,
  parseManifest,
  type BundleManifest,
  type ManifestEntry,
} from "./manifest.js";
import { LoopbackApi } from "./loopback.js";
import { rewritten, siteType } from "./mime.js";
import { integer, PointerApi, type PointerDomain } from "./pointer.js";
import { formatUri, parseUri, SCHEME, type DecdnUri } from "./uri.js";
import { collect, guard, pastEnd, slice } from "./verify.js";

/** Where the client runs and how it reaches the gateway. */
export type Context = "public" | "loopback" | "site";

/** `"auto"` verifies what can be verified; `true` refuses what cannot; `false` verifies nothing. */
export type VerifyMode = "auto" | boolean;

export interface OpenOptions {
  /** The gateway's origin: `https://decdn.link`, or `http://127.0.0.1:8484` for a loopback gateway. */
  gatewayUrl?: string;
  /** The loopback gateway's token (`~/.decdn/gateway/token`). */
  token?: string;
  /** The host whose capability pays on a loopback gateway, sent as `x-decdn-host`. Required with `token`. */
  host?: string;
  /** The chain and registry pointers are signed for. Required by `pointer.set`. */
  pointer?: PointerDomain;
  /** The `fetch` to use. Default: the global one. */
  fetch?: Fetch;
  /** The default verification of `get`. Default `"auto"`. */
  verify?: VerifyMode;
  /** How many manifests the client keeps parsed, by hash. Default 64. */
  manifestCacheSize?: number;
}

/** A byte window: `length` bytes from `offset`, or to the end without `length`. */
export interface ByteRange {
  offset: number;
  length?: number;
}

export interface GetOptions {
  range?: ByteRange;
  signal?: AbortSignal;
  verify?: VerifyMode;
  /** Wait out one `Retry-After` on 402, 429 or 503 and try once more. */
  retry?: boolean;
}

/** What `head` knows about content without fetching it. */
export interface HeadInfo {
  size?: number;
  hash?: string;
  contentType?: string;
}

/** What a URI names, once its manifest is read. */
export interface Resolved {
  kind: DecdnUri["kind"];
  /** The URI's hash: of the blob, or of the bundle manifest. */
  hash: string;
  /** The manifest entry an entry URI names. */
  entry?: ManifestEntry;
  /** The bundle or entry on its site origin. */
  siteUrl?: string;
  /** The URI on the gateway's bare host (or under `/_decdn/` on a site). */
  bareUrl: string;
}

/** The gateway's answer: a stream that ends with an error rather than `done` when its bytes fail verification. */
export class DecdnResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly contentType: string;
  /** How many bytes the body holds, when known: never the encoded length of a body decoded on the way. */
  readonly contentLength?: number;
  /**
   * The window the body holds: from `Content-Range` on a `206`; or, when the
   * gateway answered a range with the whole body (`200`) and the client cut
   * the window from it, from the range, with `length` and `size` only when
   * the whole body's length is known (not for a page a site rewrites, which
   * streams with no length).
   */
  readonly contentRange?: { offset: number; length?: number; size?: number };
  /**
   * `true`: the body is hashed as it streams, and ends with `HASH_MISMATCH`
   * instead of `done` unless it hashes to the hash that names it.
   * `"skipped"`: the bytes cannot be verified (a range, a rewritten page, a
   * bundle listing). `false`: verification was turned off.
   */
  readonly verified: boolean | "skipped";
  readonly body: ReadableStream<Uint8Array>;

  /** @internal */
  constructor(
    response: Response,
    body: ReadableStream<Uint8Array>,
    verified: boolean | "skipped",
    contentType?: string,
    cut?: { offset: number; length?: number; size?: number },
  ) {
    this.status = response.status;
    this.headers = response.headers;
    this.url = response.url;
    this.contentType =
      contentType ??
      response.headers.get("content-type") ??
      "application/octet-stream";
    this.verified = verified;
    this.body = body;
    if (cut !== undefined) {
      if (cut.size === undefined) {
        this.contentRange = { offset: cut.offset };
        return;
      }
      // `get` refuses a window that starts past the end, as the gateway does.
      const length = Math.min(cut.length ?? Infinity, cut.size - cut.offset);
      this.contentLength = length;
      this.contentRange = { offset: cut.offset, length, size: cut.size };
      return;
    }
    const length = bodyLength(response);
    if (length !== undefined) this.contentLength = length;
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("content-range") ?? "",
    );
    if (range !== null) {
      const [, a = "0", b = "0", size = "0"] = range;
      this.contentRange = {
        offset: Number(a),
        length: Number(b) - Number(a) + 1,
        size: Number(size),
      };
    }
  }

  /** The whole body. Rejects with `HASH_MISMATCH` or `TRUNCATED`. */
  bytes(): Promise<Uint8Array> {
    return collect(this.body);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

/** A site origin's own bundle and namespace, and the suffix its siblings share. */
interface SiteOrigin {
  origin: string;
  protocol: string;
  /** `<rest>` of `[<ns>.]<hash32>.<rest>`, or `<host>` of `<ns>.<host>`. */
  suffix: string;
  /** The page's bundle; unknown on a namespace host. */
  hash?: string;
  namespace?: bigint;
}

const NAMESPACE_LABEL = /^[1-9][0-9]*$/;

/** The site origin `host` is, under `gatewayHost` when one is configured. */
function siteOf(
  protocol: string,
  host: string,
  gatewayHost?: string,
): SiteOrigin | undefined {
  const labels = host.split(".");
  const origin = `${protocol}//${host}`;
  const first = labels[0] ?? "";
  const hash = base32ToHash(first);
  if (hash !== undefined && labels.length > 1) {
    return { origin, protocol, suffix: labels.slice(1).join("."), hash };
  }
  const second = base32ToHash(labels[1] ?? "");
  if (
    second !== undefined &&
    NAMESPACE_LABEL.test(first) &&
    labels.length > 2
  ) {
    return {
      origin,
      protocol,
      suffix: labels.slice(2).join("."),
      hash: second,
      namespace: BigInt(first),
    };
  }
  if (
    gatewayHost !== undefined &&
    NAMESPACE_LABEL.test(first) &&
    labels.slice(1).join(".") === gatewayHost
  ) {
    return { origin, protocol, suffix: gatewayHost, namespace: BigInt(first) };
  }
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function config(message: string): DecdnError {
  return new DecdnError("CONFIG", message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** `promise`, or `signal`'s reason as soon as it aborts. */
function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** `uri` without `decdn:` and the hash: `[/<path>][?ns=<id>]`, canonically encoded. */
function tail(uri: DecdnUri): string {
  return formatUri(uri).slice(SCHEME.length + 64);
}

/** One request `get` sends, and what its body must hash to. */
interface Plan {
  url: string;
  hash?: string;
  length?: number;
  verified: boolean | "skipped";
  /** The entry by its hash, unrewritten: where a verified entry comes from when its site answers with a type the gateway rewrites. */
  blobUrl?: string;
  /** The type of an entry fetched by its hash, which the bare host serves as bytes: the one its site serves it as. */
  contentType?: string;
}

/** The types a site rewrites as it streams (`Rewrite::for_type` in the gateway). */
function isRewrittenType(contentType: string | null): boolean {
  const essence = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return essence === "text/html" || essence === "text/css";
}

/**
 * How many bytes the body holds as it is read: `Content-Length`; or
 * `undefined` when a `Content-Encoding` has the body decoded on the way,
 * since `Content-Length` then counts the encoded bytes.
 */
function bodyLength(response: Response): number | undefined {
  const encoding = (response.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding !== "" && encoding !== "identity") return undefined;
  const length = response.headers.get("content-length");
  return length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
}

/**
 * A manifest read, cached by key and shared by every caller of that key. A
 * failed read leaves the cache, and so does one a caller abandons before it
 * settles.
 */
interface ManifestRead {
  promise: Promise<BundleManifest>;
  /** Aborts the read once every caller has stopped waiting on it. */
  abort: AbortController;
  waiting: number;
  settled: boolean;
}

export class DecdnClient {
  readonly context: Context;
  /** Namespace pointers (public gateway). */
  readonly pointer: PointerApi = new PointerApi(this);
  /** The delegate and capability API (loopback gateway). */
  readonly loopback: LoopbackApi = new LoopbackApi(this);
  /** @internal */
  readonly fetch: Fetch;
  /** @internal The bare origin: the gateway URL's, or the site's own. */
  readonly origin: string;
  /** @internal */
  readonly pointerDomain?: PointerDomain;
  private readonly gateway?: URL;
  private readonly site?: SiteOrigin;
  private readonly token?: string;
  private readonly host?: string;
  private readonly verify: VerifyMode;
  private readonly cacheSize: number;
  /** Manifest reads by hash and namespace hint, least recently used first. */
  private readonly manifests = new Map<string, ManifestRead>();

  private constructor(
    context: Context,
    opts: OpenOptions,
    gateway?: URL,
    site?: SiteOrigin,
  ) {
    this.context = context;
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.verify = opts.verify ?? "auto";
    this.cacheSize = opts.manifestCacheSize ?? 64;
    if (gateway !== undefined) this.gateway = gateway;
    if (site !== undefined) this.site = site;
    if (opts.token !== undefined) this.token = opts.token;
    if (opts.host !== undefined) this.host = opts.host;
    if (opts.pointer !== undefined) this.pointerDomain = opts.pointer;
    this.origin = site?.origin ?? gateway?.origin ?? "";
  }

  /**
   * A client for the gateway at `gatewayUrl`, or, in a page served from a
   * site origin (`[<ns>.]<hash32>.<host>`, or `<ns>.<host>` under the
   * configured gateway), for that site. A loopback `gatewayUrl` opens the
   * loopback gateway from any page; a page, which cannot send the token,
   * reaches its delegate and capability API alone.
   */
  static async open(opts: OpenOptions = {}): Promise<DecdnClient> {
    let gateway: URL | undefined;
    if (opts.gatewayUrl !== undefined) {
      try {
        gateway = new URL(opts.gatewayUrl);
      } catch (e) {
        throw new DecdnError(
          "CONFIG",
          `not a gateway URL: ${opts.gatewayUrl}`,
          { cause: e },
        );
      }
    }
    const loopback =
      gateway !== undefined &&
      (opts.token !== undefined || isLoopbackHost(gateway.hostname));
    const loc = (
      globalThis as { location?: { protocol?: string; host?: string } }
    ).location;
    if (
      !loopback &&
      loc?.host !== undefined &&
      loc.host !== "" &&
      loc.protocol !== undefined
    ) {
      const site = siteOf(loc.protocol, loc.host, gateway?.host);
      if (site !== undefined)
        return new DecdnClient("site", opts, gateway, site);
    }
    if (gateway === undefined) {
      throw config("no gatewayUrl, and the page is not on a site origin");
    }
    if (
      opts.token !== undefined &&
      (opts.host === undefined || opts.host === "")
    ) {
      throw config(
        "a loopback token needs `host`: the host whose capability pays, sent as x-decdn-host",
      );
    }
    return new DecdnClient(loopback ? "loopback" : "public", opts, gateway);
  }

  /** @internal Headers every bare-host request carries. */
  authHeaders(): Record<string, string> {
    if (this.token === undefined || this.host === undefined) return {};
    return { "x-decdn-token": this.token, "x-decdn-host": this.host };
  }

  /** `uri` parsed, or checked and normalised as its string would parse. */
  private parse(uri: string | DecdnUri): DecdnUri {
    if (typeof uri === "string") return parseUri(uri);
    const parsed = parseUri(formatUri(uri));
    // Only an entry with no path formats as another kind: a bundle.
    if (parsed.kind !== uri.kind)
      throw new DecdnError(
        "BAD_URI",
        "invalid decdn URI: an entry needs a path",
      );
    return parsed;
  }

  /** Content on a loopback gateway is the token holder's alone. */
  private needToken(): void {
    if (this.context === "loopback" && this.token === undefined) {
      throw config(
        "content on a loopback gateway needs its token: a page without it reaches /_delegate and /_capability alone",
      );
    }
  }

  /** The URI on the bare host, or under `/_decdn/` on a site. */
  private bareUrl(uri: DecdnUri): string {
    const rest = `${uri.hash}${tail(uri)}`;
    return this.site !== undefined
      ? `${this.site.origin}/_decdn/${rest}`
      : `${this.origin}/${rest}`;
  }

  /** The site URL of a bundle or an entry. */
  siteUrl(uri: string | DecdnUri): string {
    const u = this.parse(uri);
    if (u.kind === "blob")
      throw config("a blob has no site: only a bundle or an entry does");
    const label = hashToBase32(u.hash);
    const host = u.namespace === undefined ? label : `${u.namespace}.${label}`;
    const path = tail({
      hash: u.hash,
      kind: u.kind,
      ...(u.path === undefined ? {} : { path: u.path }),
    });
    if (this.site !== undefined)
      return `${this.site.protocol}//${host}.${this.site.suffix}${path}`;
    const gw = this.gateway as URL;
    if (this.context === "loopback") {
      const port =
        gw.port !== "" ? gw.port : gw.protocol === "https:" ? "443" : "80";
      return `${gw.protocol}//${host}.localhost:${port}${path}`;
    }
    return `${gw.protocol}//${host}.${gw.host}${path}`;
  }

  /** The host a namespace's pointer serves at on a public gateway: `https://<ns>.<host>/`. */
  namespaceUrl(namespace: bigint | number): string {
    const ns = integer(namespace, "a namespace id");
    if (ns <= 0n) throw config("a namespace id is at least 1");
    if (this.site !== undefined)
      return `${this.site.protocol}//${ns}.${this.site.suffix}/`;
    if (this.context === "loopback")
      throw config("a loopback gateway holds no namespace pointers");
    const gw = this.gateway as URL;
    return `${gw.protocol}//${ns}.${gw.host}/`;
  }

  /** The manifest a manifest call names, as a blob URI with its namespace hint; or the site's own. */
  private manifestUri(hashOrUri?: string | DecdnUri): DecdnUri {
    if (hashOrUri === undefined) {
      if (this.site?.hash !== undefined) {
        const uri: DecdnUri = { hash: this.site.hash, kind: "blob" };
        if (this.site.namespace !== undefined)
          uri.namespace = this.site.namespace;
        return uri;
      }
      throw config(
        this.site === undefined
          ? "manifest needs a hash outside a site page"
          : "the manifest hash is unknown on a namespace host",
      );
    }
    if (typeof hashOrUri === "string" && isHash(hashOrUri))
      return { hash: hashOrUri.toLowerCase(), kind: "blob" };
    const { hash, namespace } = this.parse(hashOrUri);
    return namespace === undefined
      ? { hash, kind: "blob" }
      : { hash, kind: "blob", namespace };
  }

  /**
   * The bundle manifest a hash or URI names, parsed and verified; cached per
   * client by hash and namespace hint. The hint, a URI's `?ns=`, goes with
   * the request: it routes the pull to the namespace's nodes.
   */
  async manifest(
    hashOrUri?: string | DecdnUri,
    signal?: AbortSignal,
  ): Promise<BundleManifest> {
    return this.readManifest(this.manifestUri(hashOrUri), signal);
  }

  private async readManifest(
    uri: DecdnUri,
    signal?: AbortSignal,
  ): Promise<BundleManifest> {
    this.needToken();
    // A caller that has already given up starts no read.
    signal?.throwIfAborted();
    const key = formatUri(uri);
    let read = this.manifests.get(key);
    if (read === undefined) {
      read = this.startRead(key, uri);
    } else {
      this.manifests.delete(key);
      this.manifests.set(key, read);
    }
    read.waiting++;
    try {
      return await untilAborted(read.promise, signal);
    } finally {
      read.waiting--;
      if (!read.settled && signal?.aborted === true) {
        // The read may be the reason the caller gave up: the next caller
        // starts its own instead of joining it.
        if (this.manifests.get(key) === read) this.manifests.delete(key);
        if (read.waiting === 0) read.abort.abort();
      }
    }
  }

  /**
   * One read of a manifest, shared by every caller of its key, so it
   * carries no caller's signal: each caller stops waiting on its own abort,
   * and the last one to stop aborts the read.
   */
  private startRead(key: string, uri: DecdnUri): ManifestRead {
    const abort = new AbortController();
    const promise = (async () => {
      const response = await this.request(
        this.bareUrl(uri),
        "GET",
        {},
        abort.signal,
      );
      return parseManifest(
        await collect(
          guard(response.body, { signal: abort.signal }),
          MAX_MANIFEST_BYTES,
        ),
        uri.hash,
      );
    })();
    const read: ManifestRead = { promise, abort, waiting: 0, settled: false };
    this.manifests.set(key, read);
    // Attached before any caller awaits `promise`, so these handlers run
    // first and `settled` is set before a caller's `finally` reads it.
    // A failed read drops its own entry only: once evicted, the key's slot
    // may hold a newer read.
    promise.then(
      () => {
        read.settled = true;
      },
      () => {
        read.settled = true;
        if (this.manifests.get(key) === read) this.manifests.delete(key);
      },
    );
    while (this.manifests.size > this.cacheSize) {
      const oldest = this.manifests.keys().next().value;
      if (oldest === undefined) break;
      this.manifests.delete(oldest);
    }
    return read;
  }

  /**
   * The manifest entry `uri` names; `NOT_FOUND` when the bundle has none.
   * Off loopback, where entries come from their site, a path that names a
   * directory with an `index.html` names that `index.html`: a site redirects
   * the directory's path to it. The bare host does not, and a loopback
   * client fetches entries there.
   */
  private async entryOf(
    uri: DecdnUri,
    signal?: AbortSignal,
  ): Promise<ManifestEntry> {
    const manifest = await this.readManifest(
      uri.namespace === undefined
        ? { hash: uri.hash, kind: "blob" }
        : { hash: uri.hash, kind: "blob", namespace: uri.namespace },
      signal,
    );
    const entry =
      manifest.entries.find((e) => e.path === uri.path) ??
      (this.context !== "loopback"
        ? manifest.entries.find((e) => e.path === `${uri.path}/index.html`)
        : undefined);
    if (entry === undefined) {
      throw new DecdnError(
        "NOT_FOUND",
        `bundle ${uri.hash} has no entry ${JSON.stringify(uri.path)}`,
      );
    }
    return entry;
  }

  /** What `uri` names: for a bundle or an entry, after reading its manifest. */
  async resolve(uri: string | DecdnUri): Promise<Resolved> {
    const u = this.parse(uri);
    const out: Resolved = {
      kind: u.kind,
      hash: u.hash,
      bareUrl: this.bareUrl(u),
    };
    if (u.kind === "blob") return out;
    out.siteUrl = this.siteUrl(u);
    if (u.kind === "bundle") await this.manifest(u);
    else out.entry = await this.entryOf(u);
    return out;
  }

  /** A request to the gateway; a non-2xx answer is thrown as a `DecdnError`. */
  private async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const bare = this.site === undefined && url.startsWith(`${this.origin}/`);
    const init: RequestInit = {
      method,
      headers: bare ? { ...this.authHeaders(), ...headers } : headers,
    };
    if (signal !== undefined) init.signal = signal;
    return sendOk(this.fetch, url, init);
  }

  /** An entry by its own hash, as a blob: the bytes the manifest names, unrewritten. */
  private entryBlobUrl(uri: DecdnUri, entry: ManifestEntry): string {
    return this.bareUrl({
      hash: entry.hash,
      kind: "blob",
      ...(uri.namespace === undefined ? {} : { namespace: uri.namespace }),
    });
  }

  /**
   * Where an entry comes from, given its manifest entry (when verifying).
   * `own` holds the query of a path on the site's own bundle: the site serves
   * by path alone and leaves the query to the page, and its host already
   * names the namespace.
   */
  private entryUrl(uri: DecdnUri, own?: string, entry?: ManifestEntry): string {
    if (
      entry !== undefined &&
      rewritten(uri.path ?? "") &&
      this.context !== "loopback"
    ) {
      return this.entryBlobUrl(uri, entry);
    }
    if (this.site !== undefined)
      return own !== undefined
        ? `${this.site.origin}${tail({
            hash: uri.hash,
            kind: "entry",
            ...(uri.path === undefined ? {} : { path: uri.path }),
          })}${own}`
        : this.bareUrl(uri);
    return this.context === "loopback" ? this.bareUrl(uri) : this.siteUrl(uri);
  }

  private async plan(
    target: string | DecdnUri,
    mode: VerifyMode,
    ranged: boolean,
    signal?: AbortSignal,
  ): Promise<Plan> {
    const off: Plan["verified"] = mode === false ? false : "skipped";
    const unverifiable = (why: string): void => {
      if (mode === true) throw config(`verify: true, but ${why}`);
    };
    if (typeof target === "string" && target.startsWith("/")) {
      if (this.site === undefined)
        throw config(
          "a path is relative to a site: open the client on a site page",
        );
      const path = target.split(/[?#]/)[0] ?? "/";
      const query = target.slice(path.length).split("#")[0] ?? "";
      if (this.site.hash === undefined || path === "/") {
        unverifiable(
          this.site.hash === undefined
            ? "the bundle is unknown on a namespace host"
            : "a bundle listing is not content",
        );
        return { url: `${this.site.origin}${target}`, verified: off };
      }
      const entry = path.endsWith("/") ? `${path}index.html` : path;
      const uri = parseUri(`${SCHEME}${this.site.hash}${entry}`);
      if (this.site.namespace !== undefined)
        uri.namespace = this.site.namespace;
      return this.planEntry(uri, query, mode, ranged, signal);
    }
    const uri = this.parse(target);
    if (uri.kind === "blob") {
      // The gateway serves a blob whole: nothing declares its size, so a
      // range would come back as every byte, or as an unverifiable window.
      if (ranged)
        throw config(
          "a blob has no declared size to range: fetch it whole, or range a bundle entry",
        );
      return mode === false
        ? { url: this.bareUrl(uri), verified: false }
        : { url: this.bareUrl(uri), hash: uri.hash, verified: true };
    }
    if (uri.kind === "bundle") {
      unverifiable("a bundle's index is a page the gateway rewrites");
      const own = this.site !== undefined && this.site.hash === uri.hash;
      const url =
        this.site !== undefined
          ? own
            ? `${this.site.origin}/`
            : this.bareUrl(uri)
          : this.context === "loopback"
            ? this.bareUrl(uri)
            : this.siteUrl(uri);
      return { url, verified: off };
    }
    const own = this.site !== undefined && this.site.hash === uri.hash;
    // The site serves its own entries under its host's namespace.
    if (
      own &&
      uri.namespace === undefined &&
      this.site?.namespace !== undefined
    )
      uri.namespace = this.site.namespace;
    return this.planEntry(uri, own ? "" : undefined, mode, ranged, signal);
  }

  private async planEntry(
    uri: DecdnUri,
    own: string | undefined,
    mode: VerifyMode,
    ranged: boolean,
    signal?: AbortSignal,
  ): Promise<Plan> {
    if (mode === false || ranged) {
      if (ranged && mode === true)
        throw config("verify: true, but a range cannot be verified");
      return {
        url: this.entryUrl(uri, own),
        verified: mode === false ? false : "skipped",
      };
    }
    const entry = await this.entryOf(uri, signal);
    const target = entry.path === uri.path ? uri : { ...uri, path: entry.path };
    const plan: Plan = {
      url: this.entryUrl(target, own, entry),
      hash: entry.hash,
      verified: true,
    };
    if (entry.size !== undefined) plan.length = entry.size;
    if (this.context !== "loopback") {
      const blobUrl = this.entryBlobUrl(target, entry);
      if (plan.url === blobUrl) plan.contentType = siteType(entry.path);
      else plan.blobUrl = blobUrl;
    }
    return plan;
  }

  /**
   * Fetch what `uri` names: a `decdn:` URI, or on a site page a path of its
   * own bundle. Verification follows `verify` (see {@link DecdnResponse.verified}).
   */
  async get(
    uri: string | DecdnUri,
    opts: GetOptions = {},
  ): Promise<DecdnResponse> {
    this.needToken();
    const mode = opts.verify ?? this.verify;
    const plan = await this.plan(
      uri,
      mode,
      opts.range !== undefined,
      opts.signal,
    );
    const headers: Record<string, string> = {};
    if (opts.range !== undefined) {
      const { offset, length } = opts.range;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (length !== undefined && (!Number.isSafeInteger(length) || length < 1))
      ) {
        throw config("a range is a non-negative offset and a positive length");
      }
      headers.range = `bytes=${offset}-${length === undefined ? "" : offset + length - 1}`;
    }
    let response = await this.fetchRetrying(plan.url, headers, opts);
    // A site rewrites what it serves as HTML or CSS. `rewritten` picks those
    // entries out by name up front; any other the site answers with such a
    // type comes by its hash, keeping the site's type.
    let contentType = plan.contentType;
    if (
      plan.blobUrl !== undefined &&
      isRewrittenType(response.headers.get("content-type"))
    ) {
      contentType = response.headers.get("content-type") ?? undefined;
      // The page is dropped unread, without waiting: a tee branch's cancel
      // settles only once its sibling does, and a failure changes nothing.
      response.body?.cancel().catch(() => undefined);
      response = await this.fetchRetrying(plan.blobUrl, headers, opts);
    }
    // A plan is verified only for a whole body: whatever status the gateway
    // answers it with, its bytes must hash. A range is never verified, and
    // one answered with the whole body (a page the site rewrites, a proxy
    // that drops `Range`) has the window cut from it here.
    const range = opts.range;
    const cut =
      range !== undefined && response.status === 200 ? range : undefined;
    const guardOpts: Parameters<typeof guard>[1] = {};
    if (plan.verified === true && plan.hash !== undefined)
      guardOpts.hash = plan.hash;
    // The manifest's size bounds a whole entry both ways, and a `206` window
    // holds at most what was asked for. An unencoded `Content-Length` bounds
    // any other body from below, so one that ends short is `TRUNCATED`.
    const length = bodyLength(response);
    // A window past the end is refused, as the gateway refuses it with 416;
    // an empty body is answered empty, as the gateway answers it.
    if (
      cut !== undefined &&
      length !== undefined &&
      length > 0 &&
      cut.offset >= length
    ) {
      response.body?.cancel().catch(() => undefined);
      throw pastEnd(cut.offset, length);
    }
    if (plan.length !== undefined) {
      guardOpts.length = plan.length;
      guardOpts.max = plan.length;
    } else {
      if (length !== undefined) guardOpts.length = length;
      if (range?.length !== undefined && cut === undefined)
        guardOpts.max = range.length;
    }
    if (opts.signal !== undefined) guardOpts.signal = opts.signal;
    const body = guard(response.body, guardOpts);
    if (cut === undefined)
      return new DecdnResponse(response, body, plan.verified, contentType);
    const window: { offset: number; length?: number; size?: number } = {
      offset: cut.offset,
    };
    if (cut.length !== undefined) window.length = cut.length;
    if (length !== undefined) window.size = length;
    return new DecdnResponse(
      response,
      slice(body, cut.offset, cut.length),
      plan.verified,
      contentType,
      window,
    );
  }

  /** A `GET` of `url`, once more after one `Retry-After` when `opts.retry` asks. */
  private async fetchRetrying(
    url: string,
    headers: Record<string, string>,
    opts: GetOptions,
  ): Promise<Response> {
    try {
      return await this.request(url, "GET", headers, opts.signal);
    } catch (e) {
      const retryable =
        e instanceof DecdnError &&
        ["PAYMENT_REQUIRED", "POOL_UNFUNDED", "RATE_LIMITED"].includes(e.code);
      if (!opts.retry || !retryable || e.retryAfterSecs === undefined) throw e;
      await sleep(e.retryAfterSecs * 1000, opts.signal);
      return this.request(url, "GET", headers, opts.signal);
    }
  }

  /**
   * What is known about `uri` without its bytes: on a public gateway from
   * `HEAD`, elsewhere (where `HEAD` would cost a pull) from the manifest. A
   * public `HEAD` of a raw blob whose size the gateway does not know yet
   * pays for one chunk group, the proof of its size, and is refused or fails
   * as its `GET` would be.
   */
  async head(uri: string | DecdnUri): Promise<HeadInfo> {
    const u = this.parse(uri);
    if (this.context === "public") {
      const url = u.kind === "blob" ? this.bareUrl(u) : this.siteUrl(u);
      const response = await this.request(url, "HEAD", {});
      const info: HeadInfo = {};
      const length = response.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length)) info.size = Number(length);
      const etag = /^"?([0-9a-fA-F]{64})"?$/.exec(
        response.headers.get("etag") ?? "",
      )?.[1];
      if (etag !== undefined) info.hash = etag.toLowerCase();
      const type = response.headers.get("content-type");
      if (type !== null) info.contentType = type;
      return info;
    }
    if (u.kind !== "entry") return { hash: u.hash };
    const entry = await this.entryOf(u);
    const info: HeadInfo = {
      hash: entry.hash,
      contentType: siteType(entry.path),
    };
    if (entry.size !== undefined) info.size = entry.size;
    return info;
  }
}
