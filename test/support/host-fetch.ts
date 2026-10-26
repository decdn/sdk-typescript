// A `fetch` that sends every request to one listener with the URL's host as
// `Host`, the way a TLS proxy in front of a gateway does. Nothing resolves
// `decdn.test` or a site host under it, and Node's `fetch` sets `Host` from
// the URL, so the tests route through `node:http` instead.
import { request } from "node:http";
import { Readable } from "node:stream";

/** A `fetch` that connects to `connect` (`host:port`) whatever the URL's host. */
export function hostFetch(connect: string): typeof fetch {
  const [hostname = "127.0.0.1", port = "80"] = connect.split(":");
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body =
      req.body === null ? undefined : Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = { host: url.host };
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (body !== undefined) headers["content-length"] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          hostname,
          port: Number(port),
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value])
              out.append(key, v);
          }
          const empty =
            req.method === "HEAD" || status === 204 || status === 304;
          if (empty) res.resume();
          resolve(
            new Response(
              empty
                ? null
                : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
              {
                status,
                headers: out,
              },
            ),
          );
        },
      );
      outgoing.on("error", reject);
      req.signal.addEventListener(
        "abort",
        () => outgoing.destroy(req.signal.reason as Error),
        { once: true },
      );
      outgoing.end(body);
    });
  };
}
