// The client: one of three contexts over a `decdn gateway`.
//
// - `public`: a gateway with `--public-url`; blobs from the bare host, entries
//   from their site host, every request paid by the operator.
// - `loopback`: the local gateway with its token; every request on the bare
//   host, paid by the capability that covers `host`.
// - `site`: a page served from a site origin; its own entries same-origin and
//   other content through `/_decdn/`.
import { base32ToHash, hashToBase32 } from "./base32.js";
import { DecdnError } from "./errors.js";
import { errorOf, send, type Fetch } from "./http.js";
import { isHash } from "./hex.js";
import {
  MAX_MANIFEST_BYTES,
  parseManifest,
  type BundleManifest,
  type ManifestEntry,
} from "./manifest.js";
import { rewritten, siteType } from "./mime.js";
import { formatUri, parseUri, SCHEME, type DecdnUri } from "./uri.js";
import { collect, guard } from "./verify.js";

/** Where the client runs and how it reaches the gateway. */
export type Context = "public" | "loopback" | "site";

/** `"auto"` verifies what can be verified; `true` refuses what cannot; `false` verifies nothing. */
export type VerifyMode = "auto" | boolean;

/** The chain a namespace pointer is signed for: the EIP-712 domain of `PUT /_pointer`. */
export interface PointerDomain {
  chainId: bigint | number;
  /** The `PublisherRegistry` contract address. */
  publisherRegistry: string;
}

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
  readonly contentLength?: number;
  readonly contentRange?: { offset: number; length: number; size: number };
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
  ) {
    this.status = response.status;
    this.headers = response.headers;
    this.url = response.url;
    this.contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length))
      this.contentLength = Number(length);
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
    this.verified = verified;
    this.body = body;
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
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
}

export class DecdnClient {
  readonly context: Context;
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
  private readonly manifests = new Map<string, Promise<BundleManifest>>();

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
   * A client for the gateway at `gatewayUrl`, or, with no URL in a page served
   * from a site origin (`[<ns>.]<hash32>.<host>`, or `<ns>.<host>` under the
   * configured gateway), for that site.
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
    const loc = (
      globalThis as { location?: { protocol?: string; host?: string } }
    ).location;
    if (
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
    const loopback =
      opts.token !== undefined || isLoopbackHost(gateway.hostname);
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

  private parse(uri: string | DecdnUri): DecdnUri {
    return typeof uri === "string" ? parseUri(uri) : uri;
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
    const ns = BigInt(namespace);
    if (ns <= 0n) throw config("a namespace id is at least 1");
    if (this.site !== undefined)
      return `${this.site.protocol}//${ns}.${this.site.suffix}/`;
    if (this.context === "loopback")
      throw config("a loopback gateway holds no namespace pointers");
    const gw = this.gateway as URL;
    return `${gw.protocol}//${ns}.${gw.host}/`;
  }

  /** The hash a manifest call names, or the site's own. */
  private manifestHash(hashOrUri?: string | DecdnUri): string {
    if (hashOrUri === undefined) {
      if (this.site?.hash !== undefined) return this.site.hash;
      throw config(
        this.site === undefined
          ? "manifest needs a hash outside a site page"
          : "the manifest hash is unknown on a namespace host",
      );
    }
    if (typeof hashOrUri === "string" && isHash(hashOrUri))
      return hashOrUri.toLowerCase();
    return this.parse(hashOrUri).hash;
  }

  /** The bundle manifest a hash or URI names, parsed and verified; cached per client by hash. */
  async manifest(
    hashOrUri?: string | DecdnUri,
    signal?: AbortSignal,
  ): Promise<BundleManifest> {
    const hash = this.manifestHash(hashOrUri);
    const cached = this.manifests.get(hash);
    if (cached !== undefined) {
      this.manifests.delete(hash);
      this.manifests.set(hash, cached);
      return cached;
    }
    const pending = (async () => {
      const response = await this.request(
        this.bareUrl({ hash, kind: "blob" }),
        "GET",
        {},
        signal,
      );
      return parseManifest(
        await collect(guard(response.body, {}), MAX_MANIFEST_BYTES),
        hash,
      );
    })();
    this.manifests.set(hash, pending);
    pending.catch(() => this.manifests.delete(hash));
    while (this.manifests.size > this.cacheSize) {
      const oldest = this.manifests.keys().next().value;
      if (oldest === undefined) break;
      this.manifests.delete(oldest);
    }
    return pending;
  }

  /** The manifest entry `uri` names; `NOT_FOUND` when the bundle has none. */
  private async entryOf(
    uri: DecdnUri,
    signal?: AbortSignal,
  ): Promise<ManifestEntry> {
    const manifest = await this.manifest(uri.hash, signal);
    const entry = manifest.entries.find((e) => e.path === uri.path);
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
    if (u.kind === "bundle") await this.manifest(u.hash);
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
    const response = await send(this.fetch, url, init);
    if (response.status < 200 || response.status > 299)
      throw await errorOf(response);
    return response;
  }

  /** Where an entry comes from, given its manifest entry (when verifying). */
  private entryUrl(uri: DecdnUri, own: boolean, entry?: ManifestEntry): string {
    if (
      entry !== undefined &&
      rewritten(uri.path ?? "") &&
      this.context !== "loopback"
    ) {
      return this.bareUrl({
        hash: entry.hash,
        kind: "blob",
        ...(uri.namespace === undefined ? {} : { namespace: uri.namespace }),
      });
    }
    if (this.site !== undefined)
      return own
        ? `${this.site.origin}${tail({ ...uri, kind: "entry" })}`
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
      return this.planEntry(uri, true, mode, ranged, signal);
    }
    const uri = this.parse(target);
    if (uri.kind === "blob") {
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
    return this.planEntry(uri, own, mode, ranged, signal);
  }

  private async planEntry(
    uri: DecdnUri,
    own: boolean,
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
    const plan: Plan = {
      url: this.entryUrl(uri, own, entry),
      hash: entry.hash,
      verified: true,
    };
    if (entry.size !== undefined) plan.length = entry.size;
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
    let response: Response;
    try {
      response = await this.request(plan.url, "GET", headers, opts.signal);
    } catch (e) {
      const retryable =
        e instanceof DecdnError &&
        ["PAYMENT_REQUIRED", "POOL_UNFUNDED", "RATE_LIMITED"].includes(e.code);
      if (!opts.retry || !retryable || e.retryAfterSecs === undefined) throw e;
      await sleep(e.retryAfterSecs * 1000, opts.signal);
      response = await this.request(plan.url, "GET", headers, opts.signal);
    }
    // Only a window the caller asked for goes unhashed: whatever status the
    // gateway answers a whole-body request with, its bytes must hash.
    const whole = opts.range === undefined || response.status === 200;
    const verified =
      plan.verified === true && !whole ? "skipped" : plan.verified;
    const length = response.headers.get("content-length");
    const guardOpts: Parameters<typeof guard>[1] = {};
    if (verified === true && plan.hash !== undefined)
      guardOpts.hash = plan.hash;
    if (whole && plan.length !== undefined) guardOpts.length = plan.length;
    else if (length !== null && /^\d+$/.test(length))
      guardOpts.length = Number(length);
    return new DecdnResponse(
      response,
      guard(response.body, guardOpts),
      verified,
    );
  }

  /**
   * What is known about `uri` without its bytes: on a public gateway from
   * `HEAD`, elsewhere (where `HEAD` would cost a pull) from the manifest.
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
