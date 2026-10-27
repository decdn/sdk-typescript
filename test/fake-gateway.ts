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
  /** Bytes the public gateway delivers before it answers 402. */
  allowanceBytes?: number;
  /** The loopback token. */
  token?: string;
}

/** One request the fake answered. */
export interface Seen {
  method: string;
  url: string;
  headers: Headers;
}

const EXPOSED =
  "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, ETag, Retry-After, Link";
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
/** What a raw blob's size proof spends of the allowance: one chunk group. */
const PROOF_BYTES = 16 * 1024;

/** A capability registered for a loopback delegate. */
interface Registered {
  signer: string;
  pool: string;
  scope: string;
  origin: string | null;
  cap: bigint;
  expiry: bigint;
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
  readonly token: string;
  readonly blobs = new Map<string, Uint8Array>();
  /** The raw blobs whose size a proof here proved. */
  private readonly proven = new Set<string>();
  /** Hashes whose pull the pool cannot pay: 503. */
  readonly unfunded = new Set<string>();
  /** Hashes served with one byte flipped. */
  readonly tampered = new Set<string>();
  /** Hashes whose body aborts after its first half. */
  readonly truncated = new Set<string>();
  /** Hashes answered 206 with their first byte, whatever the request asked: a lying gateway. */
  readonly partial = new Set<string>();
  /** Loopback capability scopes registered: `example.com`, `*.example.com`, `*`. */
  readonly scopes: string[] = [];
  /** Namespace pointers: namespace id → bundle hash. */
  readonly pointers = new Map<bigint, string>();
  readonly seen: Seen[] = [];
  /** Loopback delegates by lowercase address, with the capability registered for each. */
  readonly delegates = new Map<string, Registered | undefined>();
  /** The deployment pointers are verified on (public). */
  pointerDomain?: PointerDomain;
  /** Namespace owners on that deployment, lowercase. */
  readonly owners = new Map<bigint, string>();
  /** The highest stored `seq` per namespace and signer. */
  private readonly highWater = new Map<string, bigint>();
  allowance: number;

  constructor(opts: FakeOptions) {
    this.mode = opts.mode;
    this.host =
      opts.host ?? (opts.mode === "public" ? "decdn.test" : "127.0.0.1:8484");
    this.token = opts.token ?? "ab".repeat(32);
    this.allowance = opts.allowanceBytes ?? Number.MAX_SAFE_INTEGER;
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
        return this.fetch(location, {
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
    if (this.mode === "public" && req.method === "OPTIONS")
      return this.preflight(url.pathname, site === undefined);
    if (site !== undefined) return this.site(req, url, site);
    return this.bare(req, url);
  }

  private preflight(path: string, bare: boolean): Response {
    const api =
      path === "/_delegate" || path === "/_capability" || path === "/_pointer";
    if (api && !bare)
      return text(404, "the gateway API answers on the gateway origin only\n");
    if (path === "/_delegate" || path === "/_capability")
      return text(404, "a public gateway has no API\n");
    const [methods, headers] =
      path === "/_pointer" ? ["PUT", "content-type"] : ["GET, HEAD", "range"];
    return text(204, "", {
      "access-control-allow-methods": methods,
      "access-control-allow-headers": headers,
      "access-control-max-age": "600",
    });
  }

  private authorized(req: Request): boolean {
    return req.headers.get("x-decdn-token") === this.token;
  }

  private covers(host: string): boolean {
    const name = host.split(":")[0] ?? host;
    return this.scopes.some(
      (s) =>
        s === "*" ||
        s === name ||
        (s.startsWith("*.") &&
          (name === s.slice(2) || name.endsWith(s.slice(1)))),
    );
  }

  private async bare(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const api = await this.api(req, path);
    if (api !== undefined) return api;
    if (this.mode === "public") {
      if (path === "/_delegate" || path === "/_capability")
        return text(404, "a public gateway has no API\n");
      if (req.method === "HEAD" && (path === "/" || path === "/favicon.ico"))
        return text(200, "");
    }
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
    if (this.mode === "public" || !this.authorized(req)) {
      if (uri.kind !== "blob") {
        return new Response(null, {
          status: 302,
          headers: { location: this.siteLocation(uri) },
        });
      }
      if (this.mode === "loopback") return text(401, "token required\n");
      if (req.method === "HEAD") return this.headBlob(uri);
      return this.serve(uri, "bare", req.headers.get("range"));
    }
    const pageHost = req.headers.get("x-decdn-host");
    if (pageHost === null) return text(401, "page host required\n");
    if (!this.covers(pageHost.toLowerCase()))
      return text(402, `no capability covers ${pageHost.toLowerCase()}\n`);
    return this.serve(uri, "bare", req.headers.get("range"));
  }

  /** The gateway API on the bare host, or `undefined` for a content path. */
  private async api(req: Request, path: string): Promise<Response | undefined> {
    const method = req.method;
    if (this.mode === "public") {
      if (path === "/_pointer" && method === "PUT") return this.putPointer(req);
      return undefined;
    }
    const origin = req.headers.get("origin");
    const cors = (r: Response): Response => {
      if (origin !== null) {
        r.headers.set("access-control-allow-origin", origin);
        r.headers.set("vary", "Origin");
      }
      return r;
    };
    if (method === "OPTIONS") {
      if (path !== "/_delegate" && path !== "/_capability")
        return text(403, "no cross-origin access\n");
      if (origin === null) return text(403, "no Origin\n");
      return cors(
        text(204, "", {
          "access-control-allow-methods": "GET, PUT",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
          "access-control-allow-private-network": "true",
        }),
      );
    }
    const page =
      origin !== null && origin !== "null"
        ? new URL(origin).hostname
        : undefined;
    const authorized = this.authorized(req);
    if (path === "/_delegate" && method === "GET") {
      if (!authorized && page === undefined)
        return cors(text(403, "the token or a page origin is required\n"));
      const address = `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      this.delegates.set(address, undefined);
      return cors(json(200, { address: checksum(address) }));
    }
    if (path === "/_capability" && method === "PUT") {
      if (!authorized && page === undefined)
        return cors(text(403, "the token or a page origin is required\n"));
      return cors(
        await this.register(req, authorized ? undefined : page, origin),
      );
    }
    if (path === "/_capability" && method === "GET") {
      if (!authorized) return text(401, "token required\n");
      const list = [...this.delegates.entries()].flatMap(([, r]) =>
        r === undefined ? [] : [r],
      );
      return new Response(
        `[${list
          .map(
            (r) =>
              `{"signer":"${checksum(r.signer)}","pool":"${r.pool}","scope":"${r.scope}","origin":${r.origin === null ? "null" : JSON.stringify(r.origin)},"cap":${r.cap},"expiry":${r.expiry},"spent":false}`,
          )
          .join(",")}]`,
        { headers: { "content-type": "application/json" } },
      );
    }
    if (path === "/_pointer" && method === "PUT")
      return text(404, "a loopback gateway holds no namespace pointers\n");
    return undefined;
  }

  private async register(
    req: Request,
    page: string | undefined,
    origin: string | null,
  ): Promise<Response> {
    const body = await req.text();
    if (body.length > MAX_BODY) return text(413, "body too large\n");
    let request: { capability?: unknown; scope?: unknown };
    try {
      request = JSON.parse(body) as typeof request;
    } catch (e) {
      return text(
        422,
        `expected {"capability", "scope"}: ${(e as Error).message}\n`,
      );
    }
    if (
      typeof request.capability !== "string" ||
      typeof request.scope !== "string"
    ) {
      return text(422, 'expected {"capability", "scope"}\n');
    }
    const scope = request.scope;
    if (!/^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/.test(scope))
      return text(422, `invalid scope ${scope}\n`);
    if (page !== undefined && scope !== page && scope !== `*.${page}`) {
      return text(403, `a page registers only a scope that covers itself\n`);
    }
    let grant;
    try {
      grant = parseCapability(request.capability.trim());
    } catch (e) {
      return text(422, `${(e as Error).message}\n`);
    }
    if (grant.expiry <= BigInt(Math.floor(Date.now() / 1000)))
      return text(422, "the capability has expired\n");
    const signer = grant.signer.toLowerCase();
    if (!this.delegates.has(signer)) {
      return text(
        409,
        "the capability names no delegate this gateway is holding: get one from GET /_delegate\n",
      );
    }
    if (this.delegates.get(signer) !== undefined) {
      return text(
        409,
        "that delegate already holds a capability: get a new one from GET /_delegate\n",
      );
    }
    this.delegates.set(signer, {
      signer,
      pool: grant.poolId,
      scope,
      origin: page === undefined ? null : origin,
      cap: grant.spendingCap,
      expiry: grant.expiry,
    });
    this.scopes.push(scope);
    return new Response(
      `{"signer":"${checksum(signer)}","scope":"${scope}","expiry":${grant.expiry}}`,
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

  private siteLocation(uri: DecdnUri): string {
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
    return `http://${host}${path}`;
  }

  private async site(
    req: Request,
    url: URL,
    site: { hash: string; namespace?: bigint; pointer?: bigint },
  ): Promise<Response> {
    const path = url.pathname;
    if (
      path === "/_delegate" ||
      path === "/_capability" ||
      path === "/_pointer"
    ) {
      return text(404, "the gateway API answers on the gateway origin only\n");
    }
    if (req.method === "HEAD" && this.mode === "loopback")
      return text(405, "", { allow: "GET" });
    if (req.method !== "GET" && req.method !== "HEAD")
      return text(405, "method not allowed\n");
    if (this.mode === "loopback" && !this.authorized(req)) {
      const fetchSite = req.headers.get("sec-fetch-site");
      if (fetchSite === null)
        return text(401, "token required outside a browser\n");
      if (fetchSite !== "same-origin" && fetchSite !== "none") {
        return text(
          403,
          "a site answers only its own pages and top-level navigation\n",
        );
      }
    }
    const csp = {
      "content-security-policy":
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'",
    };
    let response: Response;
    if (path.startsWith("/_decdn/")) {
      let uri: DecdnUri;
      try {
        uri = parseUri(`decdn:${path.slice("/_decdn/".length)}${url.search}`);
      } catch (e) {
        return text(400, `${(e as Error).message}\n`);
      }
      response = await this.serve(uri, "site", req.headers.get("range"));
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
          ? this.headSite(uri)
          : await this.serve(uri, "site", req.headers.get("range"));
    }
    for (const [k, v] of Object.entries(csp)) response.headers.set(k, v);
    return response;
  }

  private manifestOf(hash: string): BundleManifest | Response {
    const bytes = this.blobs.get(hash);
    if (bytes === undefined) return text(404, "not found\n");
    try {
      return parseManifest(bytes);
    } catch (e) {
      return text(404, `${(e as Error).message}\n`);
    }
  }

  private headSite(uri: DecdnUri): Response {
    const manifest = this.manifestOf(uri.hash);
    if (manifest instanceof Response) return manifest;
    const path = uri.kind === "bundle" ? "index.html" : (uri.path ?? "");
    const entry = manifest.entries.find((e) => e.path === path);
    if (entry === undefined) return text(404, `no entry ${path}\n`);
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

  private refusal(
    status: 402 | 503,
    uri: DecdnUri,
    retryAfter: number,
    why: string,
  ): Response {
    const canonical = formatUri(uri);
    return json(
      status,
      { error: why, uri: canonical, retry_after_secs: retryAfter },
      {
        "retry-after": String(retryAfter),
        link: `<${canonical}>; rel="alternate"`,
      },
    );
  }

  private secondsToMidnight(): number {
    const now = Date.now() / 1000;
    return Math.ceil(86400 - (now % 86400));
  }

  /**
   * `HEAD` of a raw blob on a public gateway: free for a blob whose size is
   * proven, else refused or failed as its `GET` would be before it pays for
   * the size proof.
   */
  private headBlob(uri: DecdnUri): Response {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      etag: `"${uri.hash}"`,
      "x-content-type-options": "nosniff",
    };
    const bytes = this.blobs.get(uri.hash);
    if (!this.proven.has(uri.hash)) {
      if (this.allowance <= 0) {
        return this.refusal(
          402,
          uri,
          this.secondsToMidnight(),
          "the gateway's allowance is spent for today",
        );
      }
      if (this.unfunded.has(uri.hash))
        return this.refusal(
          503,
          uri,
          60,
          "the gateway's pool cannot pay right now",
        );
      if (bytes === undefined) return text(404, "not found\n");
      this.prove(uri.hash);
    }
    if (bytes !== undefined) {
      headers["content-length"] = String(bytes.length);
      headers["accept-ranges"] = "bytes";
    }
    return new Response(null, { headers });
  }

  /** Pay for the size proof of the raw blob `hash`, once. */
  private prove(hash: string): void {
    if (this.proven.has(hash)) return;
    this.charge(PROOF_BYTES);
    this.proven.add(hash);
  }

  private async serve(
    uri: DecdnUri,
    present: "bare" | "site",
    range: string | null,
  ): Promise<Response> {
    if (this.mode === "public" && this.allowance <= 0) {
      return this.refusal(
        402,
        uri,
        this.secondsToMidnight(),
        "the gateway's allowance is spent for today",
      );
    }
    if (this.unfunded.has(uri.hash))
      return this.refusal(
        503,
        uri,
        60,
        "the gateway's pool cannot pay right now",
      );
    if (uri.kind === "blob") {
      // The gateway proves a raw blob's size before it answers (one chunk
      // group of the allowance, once), so a raw blob answers as a sized
      // entry does.
      const bytes = this.blobs.get(uri.hash);
      if (bytes === undefined) return text(404, "not found\n");
      this.prove(uri.hash);
      return this.sized(uri, uri.hash, bytes, bytes.length, range, {
        "content-type": "application/octet-stream",
        "content-disposition": `inline; filename="${uri.hash}"`,
        "x-content-type-options": "nosniff",
      });
    }
    const manifest = this.manifestOf(uri.hash);
    if (manifest instanceof Response) return manifest;
    this.charge(this.blobs.get(uri.hash)?.length ?? 0);
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
        );
      }
      const links = manifest.entries
        .map((e) => `<li><a href="${e.path}">${e.path}</a></li>`)
        .join("");
      return new Response(`<ul>${links}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return this.entry(uri, manifest, present, range);
  }

  private entry(
    uri: DecdnUri,
    manifest: BundleManifest,
    present: "bare" | "site",
    range: string | null,
  ): Response {
    const path = uri.path ?? "";
    const entry = manifest.entries.find((e) => e.path === path);
    if (entry === undefined) return text(404, `no entry ${path} in bundle\n`);
    if (this.unfunded.has(entry.hash))
      return this.refusal(
        503,
        uri,
        60,
        "the gateway's pool cannot pay right now",
      );
    const bytes = this.blobs.get(entry.hash);
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
    return this.sized(uri, entry.hash, bytes, entry.size, range, headers);
  }

  /**
   * The answer for `bytes` of known `size`: on a public gateway refused with
   * 402 when it does not fit what is left of the allowance, else whole with
   * its length, or one `range` as 206 (416 past the end).
   */
  private sized(
    uri: DecdnUri,
    hash: string,
    bytes: Uint8Array,
    size: number,
    range: string | null,
    headers: Record<string, string>,
  ): Response {
    if (this.mode === "public" && size > this.allowance) {
      return this.refusal(
        402,
        uri,
        0,
        "the response does not fit what is left of the gateway's allowance today",
      );
    }
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

  private charge(n: number): void {
    if (this.mode === "public") this.allowance -= n;
  }

  /** A streamed body of `bytes`, in two chunks, honouring the fault sets for `hash`. */
  private body(
    hash: string,
    bytes: Uint8Array,
    status: number,
    headers: Record<string, string>,
  ): Response {
    this.charge(bytes.length);
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
