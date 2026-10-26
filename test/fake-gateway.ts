// An in-process fake of `decdn gateway`'s HTTP contract
// (crates/cli/src/commands/gateway.rs, adr/appendix-gateway.md): the same
// hosts, statuses, headers and JSON bodies, over content held in memory.
// `handle` answers a web `Request`; `fetch` is a drop-in `fetch` for the SDK.
// The contract suite (test/contract) runs the same tests against this fake
// and against a real gateway, so a drift between the two fails CI.
import {
  base32ToHash,
  blake3Hex,
  formatUri,
  hashToBase32,
  parseManifest,
  parseUri,
  type BundleManifest,
  type DecdnUri,
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

export class FakeGateway {
  readonly mode: FakeMode;
  readonly host: string;
  readonly token: string;
  readonly blobs = new Map<string, Uint8Array>();
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
      return this.preflight(url.pathname);
    if (site !== undefined) return this.site(req, url, site);
    return this.bare(req, url);
  }

  private preflight(path: string): Response {
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
      if (req.method === "HEAD") {
        return new Response(null, {
          headers: {
            "content-type": "application/octet-stream",
            etag: `"${uri.hash}"`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      return this.serve(uri, "bare", req.headers.get("range"));
    }
    const pageHost = req.headers.get("x-decdn-host");
    if (pageHost === null) return text(401, "page host required\n");
    if (!this.covers(pageHost.toLowerCase()))
      return text(402, `no capability covers ${pageHost.toLowerCase()}\n`);
    return this.serve(uri, "bare", req.headers.get("range"));
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
      const bytes = this.blobs.get(uri.hash);
      if (bytes === undefined) return text(404, "not found\n");
      return this.body(uri.hash, bytes, 200, {
        "content-type":
          present === "bare"
            ? "application/octet-stream"
            : "application/octet-stream",
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
    if (this.mode === "public" && entry.size > this.allowance) {
      return this.refusal(
        402,
        uri,
        0,
        "the entry does not fit what is left of the gateway's allowance today",
      );
    }
    headers["accept-ranges"] = "bytes";
    const w = window(range, entry.size);
    if (w === "unsatisfiable")
      return text(416, "range not satisfiable\n", {
        "content-range": `bytes */${entry.size}`,
      });
    if (w === undefined) {
      headers["content-length"] = String(entry.size);
      return this.body(entry.hash, bytes, 200, headers);
    }
    const [offset, len] = w;
    headers["content-length"] = String(len);
    headers["content-range"] =
      `bytes ${offset}-${offset + len - 1}/${entry.size}`;
    return this.body(
      entry.hash,
      bytes.subarray(offset, offset + len),
      206,
      headers,
    );
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
