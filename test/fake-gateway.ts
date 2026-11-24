// An in-process fake of `decdn gateway`'s HTTP contract
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway.rs,
// https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md): the same
// hosts, statuses, headers and JSON bodies, over content held in memory.
// `handle` answers a web `Request`; `fetch` is a drop-in `fetch` for the SDK.
// The contract suite (test/contract) runs the same tests against this fake
// and against a real gateway, so a drift between the two fails CI.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  base32ToHash,
  blake3Hex,
  formatUri,
  hashToBase32,
  parseCapability,
  parseManifest,
  parseUri,
  recoverPointerSigner,
  type BundleManifest,
  type DecdnUri,
  type PointerDomain,
} from "../src/index.js";

export type FakeMode = "public" | "loopback";

export interface FakeOptions {
  mode: FakeMode;
  /** `host[:port]` of the bare host. Default `decdn.test` (public) or `127.0.0.1:8484` (loopback). */
  host?: string;
}

/** One request the fake answered. */
export interface Seen {
  method: string;
  url: string;
  headers: Headers;
}

const EXPOSED =
  "Content-Length, Content-Encoding, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, ETag, Retry-After, Link";
const REWRITTEN = /\.(html?|hxt|shtml|css)$/i;
const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  txt: "text/plain",
  json: "application/json",
  js: "text/javascript",
  bin: "application/octet-stream",
  png: "image/png",
};
/** Types a browser runs or renders as a document; the bare host serves them as text. */
const ACTIVE = [
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "application/javascript",
];

function extType(name: string): string {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** The type a site serves `name` as: its own, text in UTF-8. */
function siteType(name: string): string {
  const t = extType(name);
  return t.startsWith("text/") ? `${t}; charset=utf-8` : t;
}

/** The type the bare host serves `name` as: every text or active type as plain text. */
function bareType(name: string): string {
  const t = extType(name);
  return t.startsWith("text/") || ACTIVE.includes(t)
    ? "text/plain; charset=utf-8"
    : t;
}

function text(
  status: number,
  body: string,
  headers: HeadersInit = {},
): Response {
  return new Response(status === 204 || status === 304 ? null : body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function json(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A `Range` header naming one window: `[offset, length]`, `"unsatisfiable"`, or `undefined` to ignore it. */
function window(
  range: string | null,
  size: number,
): [number, number] | "unsatisfiable" | undefined {
  const m = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m === null) return undefined;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return undefined;
  if (a === "") {
    const n = Math.min(Number(b), size);
    return n === 0 ? "unsatisfiable" : [size - n, n];
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return undefined;
  return [start, end - start + 1];
}

/** The largest API body the gateway reads (64 KiB). */
const MAX_BODY = 64 * 1024;
/** The gateway API's paths, answered on the bare host alone. */
const API_PATHS = ["/_delegate", "/_capability", "/_status", "/_pointer"];

/**
 * How long before its expiry a gateway stops paying with a
 * capability, and refuses to register it: one redeem interval and 120 s.
 */
export const EXPIRY_MARGIN_SECS = 420n;

/** A loopback gateway's 402 for content it must pull with no usable capability. */
export const NO_CAPABILITY =
  "the gateway holds no capability that can pay: register one with PUT /_capability\n";

/** The `error` of a public gateway's 503 when nothing can pay. */
const CANNOT_PAY = "the gateway cannot pay right now";

/** A capability the gateway holds. */
export interface Registered {
  /** Lowercase `0x` address of the key it was issued to. */
  signer: string;
  /** Lowercase `0x` + 64 hex. */
  pool: string;
  cap: bigint;
  expiry: bigint;
  /** The namespaces a namespace-scoped capability pays for; absent when it pays for any content. */
  namespaces?: bigint[];
  spent: boolean;
}

/**
 * `body` with each JSON number of a `namespaces` list as the string `"#<n>"`,
 * so a u64 past 2^53 parses exactly and a string id stays distinguishable.
 */
function quoteNamespaces(body: string): string {
  return body.replace(
    /("namespaces"\s*:\s*\[)([^\]]*)\]/g,
    (_m, head: string, list: string) =>
      `${head}${list.replace(/(?<!["\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w."])/g, '"#$&"')}]`,
  );
}

/**
 * The namespaces of a registration's `scope`: `[]` for `"any"`, the ids of a
 * well-formed namespace scope (a non-empty list of u64s and a `0x`
 * 65-byte hex signature), `undefined` for any other. The fake checks the
 * shape alone; the real gateway also recovers the pool's owner from the
 * signature.
 */
/**
 * A `PUT /_capability` scope as the gateway parses it: `"any"` (no
 * namespaces), or u64 namespace ids and the signature as `0x` hex bytes of
 * any length, which the gateway checks only once it holds the key.
 */
function parseScope(
  scope: unknown,
): { namespaces: bigint[]; signature?: string } | undefined {
  if (scope === "any") return { namespaces: [] };
  if (typeof scope !== "object" || scope === null) return undefined;
  const { namespaces, signature, ...rest } = scope as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (
    typeof signature !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)
  )
    return undefined;
  if (!Array.isArray(namespaces)) return undefined;
  const ids: bigint[] = [];
  for (const n of namespaces) {
    if (typeof n !== "string" || !/^#\d+$/.test(n)) return undefined;
    const id = BigInt(n.slice(1));
    if (id >= 1n << 64n) return undefined;
    ids.push(id);
  }
  return { namespaces: ids, signature };
}

/** A capability entry's `"namespaces":[..],` member, or `""` for one that pays for any content. */
function namespacesJson(r: Registered): string {
  return r.namespaces === undefined
    ? ""
    : `"namespaces":[${r.namespaces.join(",")}],`;
}

/** Whether `headers` mark a top-level navigation: `navigate` mode, `document` destination. */
function topLevel(headers: Headers): boolean {
  return (
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document"
  );
}

function nowSecs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** The EIP-55 spelling of a lowercase `0x` address, as the gateway writes addresses. */
function checksum(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(hex));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    const nibble = ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? (hex[i] ?? "").toUpperCase() : (hex[i] ?? "");
  }
  return out;
}

export class FakeGateway {
  readonly mode: FakeMode;
  /** `host[:port]` of the bare host; settable so a listener can name the port it got. */
  host: string;
  readonly blobs = new Map<string, Uint8Array>();
  /** The raw blobs whose size a proof here proved. */
  private readonly proven = new Set<string>();
  /** Hashes whose pull nothing can pay: 503. */
  readonly unfunded = new Set<string>();
  /** Hashes served with one byte flipped. */
  readonly tampered = new Set<string>();
  /** Hashes whose body aborts after its first half. */
  readonly truncated = new Set<string>();
  /** Hashes answered 206 with their first byte, whatever the request asked: a lying gateway. */
  readonly partial = new Set<string>();
  /** Hashes only the nodes of one namespace hold: found with that `?ns=` hint alone. */
  readonly namespaced = new Map<string, bigint>();
  /** Namespace pointers: namespace id → bundle hash. */
  readonly pointers = new Map<bigint, string>();
  readonly seen: Seen[] = [];
  /** The gateway's one pending delegate key, lowercase: no capability has claimed it. */
  pending?: string;
  /** Delegate keys a capability has claimed, lowercase. */
  readonly keys = new Set<string>();
  /** Capabilities in registration order, as `GET /_capability` lists them. */
  readonly capabilities: Registered[] = [];
  /** Pools (lowercase) whose pulls stop for funding: a capability on one is spent when it next pays. */
  readonly drained = new Set<string>();
  /** The capability that paid each pull, in order. */
  readonly paid: Registered[] = [];
  /** Raw blobs the gateway's pulls delivered whole: its cache serves them with nothing that pays. */
  readonly cached = new Set<string>();
  /** The deployment pointers are verified on (public). */
  pointerDomain?: PointerDomain;
  /** Namespace owners on that deployment, lowercase. */
  readonly owners = new Map<bigint, string>();
  /** The highest stored `seq` per namespace and signer. */
  private readonly highWater = new Map<string, bigint>();

  constructor(opts: FakeOptions) {
    this.mode = opts.mode;
    this.host =
      opts.host ?? (opts.mode === "public" ? "decdn.test" : "127.0.0.1:8484");
  }

  /** Hold a capability that pays every request, as a registration through the API leaves one. */
  fund(): void {
    this.capabilities.push({
      signer: "0x00000000000000000000000000000000000000a1",
      pool: `0x${"11".repeat(32)}`,
      cap: 10_000_000n,
      expiry: 1_900_000_000n,
      spent: false,
    });
  }

  /** The bare origin, `http://<host>`. */
  get url(): string {
    return `http://${this.host}`;
  }

  /** The suffix under which site hosts live. */
  private get suffix(): string {
    if (this.mode === "public") return this.host;
    return `localhost:${this.host.split(":").pop() ?? "8484"}`;
  }

  /** Store `bytes`, returning their hash. */
  addBlob(bytes: Uint8Array | string): string {
    const b =
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const hash = blake3Hex(b);
    this.blobs.set(hash, b);
    return hash;
  }

  /** Store a bundle of `files`, returning its manifest. `unsized` paths carry no `size`. */
  addBundle(
    files: Record<string, Uint8Array | string>,
    unsized: string[] = [],
  ): BundleManifest {
    const entries = Object.entries(files).map(([path, bytes]) => {
      const hash = this.addBlob(bytes);
      const size = this.blobs.get(hash)?.length ?? 0;
      return unsized.includes(path)
        ? { path, hash: `b3:${hash}` }
        : { path, hash: `b3:${hash}`, size };
    });
    const hash = this.addBlob(JSON.stringify({ version: 1, entries }));
    return parseManifest(this.blobs.get(hash) ?? new Uint8Array());
  }

  /** A `fetch` that answers from this fake in-process. */
  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const response = await this.handle(req);
    if (
      response.status >= 300 &&
      response.status < 400 &&
      req.redirect === "follow"
    ) {
      const location = response.headers.get("location");
      if (location !== null)
        return this.fetch(new URL(location, req.url).href, {
          method: req.method,
          headers: req.headers,
          signal: req.signal,
        });
    }
    return response;
  };

  /** Serve this fake over HTTP on a free loopback port: `address` is `127.0.0.1:<port>`. */
  async listen(): Promise<{ address: string; close(): Promise<void> }> {
    const server = createServer((req, res) => {
      void this.serveHttp(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    return {
      address: `127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  private async serveHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value))
        for (const v of value) headers.append(key, v);
    }
    const method = req.method ?? "GET";
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && chunks.length > 0)
      init.body = Buffer.concat(chunks);
    const response = await this.handle(
      new Request(
        `http://${req.headers.host ?? this.host}${req.url ?? "/"}`,
        init,
      ),
    );
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    if (response.body === null || method === "HEAD") {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch {
      // The gateway aborts a body whose pull fails after its first byte.
      res.destroy();
    }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.seen.push({ method: req.method, url: req.url, headers: req.headers });
    const response = await this.route(req, url);
    if (this.mode === "public") {
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set("access-control-expose-headers", EXPOSED);
    }
    return response;
  }

  private async route(req: Request, url: URL): Promise<Response> {
    const host = url.host;
    const labels = host.endsWith(`.${this.suffix}`)
      ? host.slice(0, -this.suffix.length - 1)
      : undefined;
    const bare =
      host === this.host ||
      (this.mode === "loopback" &&
        host === `localhost:${this.suffix.split(":")[1]}`);
    let site:
      { hash: string; namespace?: bigint; pointer?: bigint } | undefined;
    if (labels !== undefined) {
      const parts = labels.split(".");
      const hash =
        parts.length <= 2
          ? base32ToHash(parts[parts.length - 1] ?? "")
          : undefined;
      const ns =
        parts.length === 2
          ? parts[0]
          : parts.length === 1 && hash === undefined
            ? parts[0]
            : undefined;
      const nsOk = ns === undefined || /^[1-9][0-9]*$/.test(ns);
      if (hash !== undefined && nsOk) {
        site = ns === undefined ? { hash } : { hash, namespace: BigInt(ns) };
      } else if (
        this.mode === "public" &&
        parts.length === 1 &&
        ns !== undefined &&
        nsOk
      ) {
        const root = this.pointers.get(BigInt(ns));
        if (root === undefined)
          return text(404, `namespace ${ns} has no pointer on this gateway\n`);
        site = { hash: root, namespace: BigInt(ns), pointer: BigInt(ns) };
      }
    }
    if (site === undefined && !bare) return text(403, "unknown Host\n");
    if (this.mode === "loopback") {
      const refused = this.gate(req);
      if (refused !== undefined) return refused;
    }
    if (this.mode === "public" && req.method === "OPTIONS")
      return this.preflight(url.pathname, site === undefined);
    if (site !== undefined) return this.site(req, url, site);
    return this.bare(req, url);
  }

  private preflight(path: string, bare: boolean): Response {
    if (API_PATHS.includes(path) && !bare)
      return text(404, "the gateway API answers on the gateway origin only\n");
    const [methods, headers] =
      path === "/_pointer"
        ? ["PUT", "content-type"]
        : path === "/_capability"
          ? ["GET, PUT", "content-type"]
          : path === "/_delegate" || path === "/_status"
            ? ["GET", "content-type"]
            : ["GET, HEAD", "range"];
    return text(204, "", {
      "access-control-allow-methods": methods,
      "access-control-allow-headers": headers,
      "access-control-max-age": "600",
    });
  }

  /** Whether `origin` is one of a loopback gateway's own: its bare host or a site origin. */
  private ownOrigin(origin: string): boolean {
    let host: string;
    try {
      const u = new URL(origin);
      if (u.protocol !== "http:") return false;
      host = u.host;
    } catch {
      return false;
    }
    if (host === this.host || host === this.suffix) return true;
    if (!host.endsWith(`.${this.suffix}`)) return false;
    const labels = host.slice(0, -this.suffix.length - 1).split(".");
    const [first = "", second] = labels;
    if (labels.length === 1) return base32ToHash(first) !== undefined;
    return (
      labels.length === 2 &&
      /^[1-9][0-9]*$/.test(first) &&
      base32ToHash(second ?? "") !== undefined
    );
  }

  /**
   * A loopback gateway's browser-header gate on every request, in order: a
   * top-level `GET` navigation passes, from any page; then a cross-site
   * request, an `Origin` that is not one of the gateway's own, and a request
   * that looks like a browser (an `Origin`, or a `Mozilla/` user agent) with
   * no `Sec-Fetch-Site` are refused; anything else, such as a client outside
   * a browser, passes.
   */
  private gate(req: Request): Response | undefined {
    if (req.method === "GET" && topLevel(req.headers)) return undefined;
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite === "cross-site")
      return text(403, "a page on another site may not use the gateway\n");
    const origin = req.headers.get("origin");
    if (origin !== null && !this.ownOrigin(origin))
      return text(403, "a page on another origin may not use the gateway\n");
    if (
      fetchSite === null &&
      (origin !== null ||
        (req.headers.get("user-agent") ?? "").startsWith("Mozilla/"))
    ) {
      return text(
        403,
        "a browser that sends no Sec-Fetch-Site may not use the gateway\n",
      );
    }
    return undefined;
  }

  /**
   * The capability that pays a pull selected by `namespace`: among the held
   * ones that are not spent and not inside the expiry margin, the earliest
   * registered scoped to `namespace`, else the earliest registered for any
   * content. A pull that stops for funding on one retires it, and the next
   * takes the request.
   */
  private payer(namespace: bigint | undefined): Registered | undefined {
    const horizon = nowSecs() + EXPIRY_MARGIN_SECS;
    const usable = this.capabilities.filter(
      (r) => !r.spent && r.expiry > horizon,
    );
    const scoped = usable.filter(
      (r) => namespace !== undefined && r.namespaces?.includes(namespace),
    );
    const any = usable.filter((r) => r.namespaces === undefined);
    for (const r of [...scoped, ...any]) {
      if (this.drained.has(r.pool)) {
        r.spent = true;
        continue;
      }
      this.paid.push(r);
      return r;
    }
    return undefined;
  }

  private async bare(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const api = await this.api(req, path);
    if (api !== undefined) return api;
    if (
      this.mode === "public" &&
      req.method === "HEAD" &&
      (path === "/" || path === "/favicon.ico")
    )
      return text(200, "");
    if (req.method === "GET" && path === "/") {
      return new Response("<h1>decdn gateway</h1>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "HEAD" && this.mode === "loopback")
      return text(405, "", { allow: "GET" });
    if (req.method !== "GET" && req.method !== "HEAD")
      return text(405, "method not allowed\n");
    let uri: DecdnUri;
    try {
      uri = parseUri(`decdn:${path.slice(1)}${url.search}`);
    } catch (e) {
      return text(400, `${(e as Error).message}\n`);
    }
    // A public gateway sends every bundle and entry to its site; a loopback
    // one sends a browser's navigation there and serves anything else here.
    const toSite =
      uri.kind !== "blob" &&
      (this.mode === "public" ||
        req.headers.get("sec-fetch-mode") === "navigate");
    if (toSite) {
      return new Response(null, {
        status: 302,
        headers: { location: this.siteLocation(uri) },
      });
    }
    if (req.method === "HEAD") return this.headBlob(uri);
    return this.serve(uri, "bare", req.headers.get("range"));
  }

  /** The capabilities the gateway holds, unexpired, as `GET /_capability` lists them. */
  private listed(): string {
    const now = nowSecs();
    return `[${this.capabilities
      .filter((r) => r.expiry > now)
      .map(
        (r) =>
          `{"cap":${r.cap},"expiry":${r.expiry},${namespacesJson(r)}"pool":"${r.pool}","signer":"${checksum(r.signer)}","spent":${r.spent}}`,
      )
      .join(",")}]`;
  }

  /**
   * The gateway API on the bare host, or `undefined` for a content path. A
   * loopback gateway answers no cross-origin request; a public one answers
   * every origin.
   */
  private async api(req: Request, path: string): Promise<Response | undefined> {
    const method = req.method;
    if (this.mode === "loopback" && method === "OPTIONS")
      return text(403, "no cross-origin access\n");
    if (path === "/_status" && method === "GET") {
      return new Response(`{"capabilities":${this.listed()}}`, {
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/_delegate" && method === "GET") {
      if (this.pending === undefined) {
        this.pending = `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      }
      return json(200, { address: checksum(this.pending) });
    }
    if (path === "/_capability" && method === "PUT") return this.register(req);
    if (path === "/_capability" && method === "GET") {
      return new Response(this.listed(), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/_pointer" && method === "PUT") {
      return this.mode === "public"
        ? this.putPointer(req)
        : text(404, "a loopback gateway holds no namespace pointers\n");
    }
    return undefined;
  }

  private async register(req: Request): Promise<Response> {
    const body = await req.text();
    if (body.length > MAX_BODY) return text(413, "body too large\n");
    let request: unknown;
    try {
      request = JSON.parse(quoteNamespaces(body));
    } catch (e) {
      return text(
        422,
        `expected {"capability", "scope"}: ${(e as Error).message}\n`,
      );
    }
    if (typeof request !== "object" || request === null)
      return text(422, 'expected {"capability", "scope"}\n');
    const fields = request as Record<string, unknown>;
    const capability = fields.capability;
    if (
      Object.keys(fields).some((k) => k !== "capability" && k !== "scope") ||
      typeof capability !== "string" ||
      !("scope" in fields)
    ) {
      return text(422, 'expected {"capability", "scope"}\n');
    }
    const scope = parseScope(fields.scope);
    if (scope === undefined) {
      return text(
        422,
        'a scope is "any" or {"namespaces": [<id>, ...], "signature": "0x<65-byte hex>"}\n',
      );
    }
    const { namespaces, signature } = scope;
    if (signature !== undefined && namespaces.length === 0)
      return text(422, "a scope names at least one namespace\n");
    let grant;
    try {
      grant = parseCapability(capability.trim());
    } catch (e) {
      return text(422, `${(e as Error).message}\n`);
    }
    if (grant.spendingCap === 0n)
      return text(422, "the capability's spending cap is 0\n");
    if (grant.expiry <= nowSecs() + EXPIRY_MARGIN_SECS)
      return text(422, "the capability expires too soon to pay\n");
    const signer = grant.signer.toLowerCase();
    const pool = grant.poolId.toLowerCase();
    if (signer !== this.pending && !this.keys.has(signer)) {
      return text(
        409,
        "the capability names no key this gateway holds: get one from GET /_delegate\n",
      );
    }
    if (this.capabilities.some((r) => r.signer === signer && r.pool === pool)) {
      return text(409, "that key already holds a capability from this pool\n");
    }
    // The owner check reads the scope signature after the key checks.
    if (signature !== undefined && signature.length !== 2 + 65 * 2)
      return text(422, "the scope signature is malformed\n");
    if (signer === this.pending) delete this.pending;
    this.keys.add(signer);
    const registered: Registered = {
      signer,
      pool,
      cap: grant.spendingCap,
      expiry: grant.expiry,
      spent: false,
    };
    if (namespaces.length > 0) registered.namespaces = namespaces;
    this.capabilities.push(registered);
    return new Response(
      `{"expiry":${grant.expiry},${namespacesJson(registered)}"pool":"${pool}","signer":"${checksum(signer)}"}`,
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  }

  private async putPointer(req: Request): Promise<Response> {
    const body = await req.text();
    if (body.length > MAX_BODY) return text(413, "body too large\n");
    const m =
      /^\s*\{\s*"namespace"\s*:\s*(\d+)\s*,\s*"root"\s*:\s*"0x([0-9a-fA-F]{64})"\s*,\s*"seq"\s*:\s*(\d+)\s*,\s*"signature"\s*:\s*"(0x[0-9a-fA-F]*)"\s*\}\s*$/.exec(
        body,
      );
    if (m === null)
      return text(422, 'expected {"namespace","root","seq","signature"}\n');
    const [, nsText = "", rootHex = "", seqText = "", signature = ""] = m;
    const namespace = BigInt(nsText);
    const seq = BigInt(seqText);
    const root = rootHex.toLowerCase();
    if (this.pointerDomain === undefined) return text(502, "no chain\n");
    let signer: string;
    try {
      signer = recoverPointerSigner(
        this.pointerDomain,
        { namespace, root, seq },
        signature,
      );
    } catch {
      return text(422, "the pointer signature is malformed\n");
    }
    const key = `${namespace}:${signer}`;
    const held = this.highWater.get(key);
    if (held !== undefined && seq <= held) {
      return new Response(
        `{"error":"the gateway holds a pointer at or above this seq","seq":${held}}`,
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const owner = this.owners.get(namespace);
    if (owner === undefined)
      return text(404, `namespace ${namespace} does not exist\n`);
    if (owner !== signer) {
      return text(
        403,
        `the pointer is signed by ${signer}; namespace ${namespace} is owned by ${owner}\n`,
      );
    }
    this.highWater.set(key, seq);
    this.pointers.set(namespace, root);
    return new Response(
      `{"namespace":${namespace},"root":"${root}","seq":${seq},"url":"http://${namespace}.${this.host}/"}`,
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }

  /**
   * The URL of `uri` on its bundle's site. With `directory`, `uri` names a
   * directory's `index.html`, and the URL is the directory itself.
   */
  private siteLocation(uri: DecdnUri, directory = false): string {
    const label = hashToBase32(uri.hash);
    const host =
      uri.namespace === undefined
        ? `${label}.${this.suffix}`
        : `${uri.namespace}.${label}.${this.suffix}`;
    const path = formatUri({
      hash: uri.hash,
      kind: uri.kind,
      ...(uri.path === undefined ? {} : { path: uri.path }),
    }).slice("decdn:".length + 64);
    const at = directory ? path.slice(0, -"index.html".length) : path;
    return `http://${host}${at}`;
  }

  private async site(
    req: Request,
    url: URL,
    site: { hash: string; namespace?: bigint; pointer?: bigint },
  ): Promise<Response> {
    const path = url.pathname;
    if (API_PATHS.includes(path))
      return text(404, "the gateway API answers on the gateway origin only\n");
    if (req.method === "HEAD" && this.mode === "loopback")
      return text(405, "", { allow: "GET" });
    if (req.method !== "GET" && req.method !== "HEAD")
      return text(405, "method not allowed\n");
    // A loopback site spends only for its own pages, the user, and a
    // top-level navigation (no Sec-Fetch-Mode, or navigate, to a document).
    const fetchSite = req.headers.get("sec-fetch-site");
    if (
      this.mode === "loopback" &&
      fetchSite !== null &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none" &&
      !(
        (req.headers.get("sec-fetch-mode") ?? "navigate") === "navigate" &&
        req.headers.get("sec-fetch-dest") === "document"
      )
    ) {
      return text(
        403,
        "a site answers only its own pages and top-level navigation\n",
      );
    }
    const csp = {
      "content-security-policy":
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'",
    };
    let response: Response;
    if (path.startsWith("/_decdn/")) {
      // A directory in a bundle (`<hash>/<dir>/`) names its `index.html`, as
      // a site's own directory paths do; the bundle root stays as it is.
      const rest = path.slice("/_decdn/".length);
      const slash = rest.indexOf("/");
      const directory =
        slash >= 0 && slash < rest.length - 1 && rest.endsWith("/");
      let uri: DecdnUri;
      try {
        uri = parseUri(
          `decdn:${rest}${directory ? "index.html" : ""}${url.search}`,
        );
      } catch (e) {
        return text(400, `${(e as Error).message}\n`);
      }
      // A pointer's namespace pays for the pointer's own bundle alone.
      const pointer = uri.hash === site.hash ? site.pointer : undefined;
      const navigation =
        (req.headers.get("sec-fetch-mode") ?? "navigate") === "navigate";
      if (uri.kind !== "blob" && (req.method === "HEAD" || navigation)) {
        // A HEAD or a navigation (no Sec-Fetch-Mode, or navigate) of a
        // bundle or an entry redirects to its site, a directory to the
        // directory, without reading the manifest or charging.
        response = new Response(null, {
          status: 302,
          headers: { location: this.siteLocation(uri, directory) },
        });
      } else if (req.method === "HEAD") {
        response = this.headBlob(uri, pointer);
      } else {
        response = await this.serve(
          uri,
          "site",
          req.headers.get("range"),
          url.search,
          pointer,
        );
      }
    } else {
      const entry =
        path.length > 1 && path.endsWith("/") ? `${path}index.html` : path;
      let uri: DecdnUri;
      try {
        uri = parseUri(`decdn:${site.hash}${entry}`);
      } catch (e) {
        return text(404, `${(e as Error).message}\n`);
      }
      if (site.namespace !== undefined) uri.namespace = site.namespace;
      response =
        req.method === "HEAD"
          ? this.headSite(uri, url.search)
          : await this.serve(
              uri,
              "site",
              req.headers.get("range"),
              url.search,
              site.pointer,
            );
    }
    for (const [k, v] of Object.entries(csp)) response.headers.set(k, v);
    return response;
  }

  /** The blob `hash`, as a pull with the namespace hint `namespace` finds it. */
  private blob(hash: string, namespace?: bigint): Uint8Array | undefined {
    const only = this.namespaced.get(hash);
    if (only !== undefined && only !== namespace) return undefined;
    return this.blobs.get(hash);
  }

  private manifestOf(
    hash: string,
    namespace?: bigint,
  ): BundleManifest | Response {
    const bytes = this.blob(hash, namespace);
    if (bytes === undefined) return text(404, "not found\n");
    try {
      return parseManifest(bytes);
    } catch (e) {
      return text(404, `${(e as Error).message}\n`);
    }
  }

  /**
   * A site's answer for `path`, which `manifest` has no entry at: a
   * redirect to the directory, with the request's `query` (`?…`, or empty)
   * kept, when it has an `index.html`; else 404. The location is relative
   * to the request, so it holds under `/_decdn/` too.
   */
  private directory(
    uri: DecdnUri,
    manifest: BundleManifest,
    path: string,
    query: string,
  ): Response {
    if (!manifest.entries.some((e) => e.path === `${path}/index.html`))
      return text(404, `no entry ${path} in bundle\n`);
    const last = formatUri(uri).split("?")[0]?.split("/").pop() ?? "";
    return new Response(null, {
      status: 302,
      headers: { location: `${last}/${query}` },
    });
  }

  private headSite(uri: DecdnUri, query: string): Response {
    const manifest = this.manifestOf(uri.hash, uri.namespace);
    if (manifest instanceof Response) return manifest;
    const path = uri.kind === "bundle" ? "index.html" : (uri.path ?? "");
    const entry = manifest.entries.find((e) => e.path === path);
    if (entry === undefined) return this.directory(uri, manifest, path, query);
    const headers: Record<string, string> = {
      "content-type": siteType(path),
      etag: `"${entry.hash}"`,
      "x-content-type-options": "nosniff",
    };
    if (entry.size !== undefined && !REWRITTEN.test(path)) {
      headers["content-length"] = String(entry.size);
      headers["accept-ranges"] = "bytes";
    }
    return new Response(null, { headers });
  }

  /** The 503 for a pull nothing can pay, with the URI to fetch with a paying client. */
  private cannotPay(uri: DecdnUri): Response {
    const canonical = formatUri(uri);
    return json(
      503,
      { error: CANNOT_PAY, retry_after_secs: 60, uri: canonical },
      { "retry-after": "60", link: `<${canonical}>; rel="alternate"` },
    );
  }

  /**
   * Pay for a pull of `uri`: `undefined` once a capability pays, else the
   * refusal (503 on a public gateway, the plain-text 402 on a loopback one).
   * On a public gateway, `pointer`, the namespace whose pointer serves the
   * request, selects a scoped capability; on a loopback one, the namespace
   * `uri` names does.
   */
  private pay(
    uri: DecdnUri,
    hash: string,
    pointer: bigint | undefined,
  ): Response | undefined {
    if (this.unfunded.has(hash)) return this.cannotPay(uri);
    const namespace = this.mode === "public" ? pointer : uri.namespace;
    if (this.payer(namespace) !== undefined) return undefined;
    return this.mode === "public"
      ? this.cannotPay(uri)
      : text(402, NO_CAPABILITY);
  }

  /**
   * `HEAD` of a raw blob on a public gateway: free for a blob whose size is
   * proven, else refused or failed as its `GET` would be before it pays for
   * the size proof, which `pointer` selects a capability for as `pay` reads it.
   */
  private headBlob(uri: DecdnUri, pointer?: bigint): Response {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      etag: `"${uri.hash}"`,
      "x-content-type-options": "nosniff",
    };
    const bytes = this.blob(uri.hash, uri.namespace);
    // The empty root is empty, with no proof.
    if (!this.proven.has(uri.hash) && bytes?.length !== 0) {
      const refused = this.pay(uri, uri.hash, pointer);
      if (refused !== undefined) return refused;
      if (bytes === undefined) return text(404, "not found\n");
      this.proven.add(uri.hash);
    }
    if (bytes !== undefined) {
      headers["content-length"] = String(bytes.length);
      headers["accept-ranges"] = "bytes";
    }
    return new Response(null, { headers });
  }

  private async serve(
    uri: DecdnUri,
    present: "bare" | "site",
    range: string | null,
    query = "",
    pointer?: bigint,
  ): Promise<Response> {
    // A raw blob the cache holds whole, and the empty root, need nothing that
    // pays; every other answer is a paid pull.
    const free =
      uri.kind === "blob" &&
      (this.cached.has(uri.hash) ||
        this.blob(uri.hash, uri.namespace)?.length === 0);
    if (!free) {
      const refused = this.pay(uri, uri.hash, pointer);
      if (refused !== undefined) return refused;
    }
    if (uri.kind === "blob") {
      // The gateway proves a raw blob's size before it answers, so a raw
      // blob answers as a sized entry does.
      const bytes = this.blob(uri.hash, uri.namespace);
      if (bytes === undefined) return text(404, "not found\n");
      this.proven.add(uri.hash);
      const response = this.sized(uri.hash, bytes, bytes.length, range, {
        "content-type": "application/octet-stream",
        "content-disposition": `inline; filename="${uri.hash}"`,
        "x-content-type-options": "nosniff",
      });
      if (response.status === 200) this.cached.add(uri.hash);
      return response;
    }
    const manifest = this.manifestOf(uri.hash, uri.namespace);
    if (manifest instanceof Response) return manifest;
    if (uri.kind === "bundle") {
      if (
        present === "site" &&
        manifest.entries.some((e) => e.path === "index.html")
      ) {
        return this.entry(
          { ...uri, kind: "entry", path: "index.html" },
          manifest,
          present,
          null,
          query,
        );
      }
      const links = manifest.entries
        .map((e) => `<li><a href="${e.path}">${e.path}</a></li>`)
        .join("");
      return new Response(`<ul>${links}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return this.entry(uri, manifest, present, range, query);
  }

  private entry(
    uri: DecdnUri,
    manifest: BundleManifest,
    present: "bare" | "site",
    range: string | null,
    query: string,
  ): Response {
    const path = uri.path ?? "";
    const entry = manifest.entries.find((e) => e.path === path);
    if (entry === undefined) {
      return present === "site"
        ? this.directory(uri, manifest, path, query)
        : text(404, `no entry ${path} in bundle\n`);
    }
    if (this.unfunded.has(entry.hash)) return this.cannotPay(uri);
    const bytes = this.blob(entry.hash, uri.namespace);
    if (bytes === undefined) return text(502, "the upstream pull failed\n");
    const name = path.split("/").pop() ?? path;
    const rewrite = present === "site" && REWRITTEN.test(path);
    const headers: Record<string, string> = {
      "content-type": present === "site" ? siteType(name) : bareType(name),
      "content-disposition": `inline; filename="${name}"`,
      "x-content-type-options": "nosniff",
    };
    if (rewrite) {
      const out = new TextDecoder()
        .decode(bytes)
        .replace(/decdn:([0-9a-fA-F]{64})/g, "/_decdn/$1");
      return this.body(entry.hash, new TextEncoder().encode(out), 200, headers);
    }
    if (entry.size === undefined)
      return this.body(entry.hash, bytes, 200, headers);
    return this.sized(entry.hash, bytes, entry.size, range, headers);
  }

  /**
   * The answer for `bytes` of known `size`: one `range` as 206, or 416 past
   * the end; else whole with its length.
   */
  private sized(
    hash: string,
    bytes: Uint8Array,
    size: number,
    range: string | null,
    headers: Record<string, string>,
  ): Response {
    headers["accept-ranges"] = "bytes";
    const w = window(range, size);
    if (w === "unsatisfiable")
      return text(416, "range not satisfiable\n", {
        "content-range": `bytes */${size}`,
      });
    if (w === undefined) {
      headers["content-length"] = String(size);
      return this.body(hash, bytes, 200, headers);
    }
    const [offset, len] = w;
    headers["content-length"] = String(len);
    headers["content-range"] = `bytes ${offset}-${offset + len - 1}/${size}`;
    return this.body(hash, bytes.subarray(offset, offset + len), 206, headers);
  }

  /** A streamed body of `bytes`, in two chunks, honouring the fault sets for `hash`. */
  private body(
    hash: string,
    bytes: Uint8Array,
    status: number,
    headers: Record<string, string>,
  ): Response {
    if (this.partial.has(hash) && status === 200 && bytes.length > 1) {
      return new Response(bytes.slice(0, 1) as Uint8Array<ArrayBuffer>, {
        status: 206,
        headers: { ...headers, "content-range": `bytes 0-0/${bytes.length}` },
      });
    }
    let out = bytes;
    if (this.tampered.has(hash) && bytes.length > 0) {
      out = bytes.slice();
      out[0] = (out[0] ?? 0) ^ 0xff;
    }
    const half = Math.ceil(out.length / 2);
    const cut = this.truncated.has(hash);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(out.subarray(0, half));
        if (cut) {
          controller.error(new TypeError("terminated"));
          return;
        }
        if (half < out.length) controller.enqueue(out.subarray(half));
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  }
}
