// The fetch wrapper: every non-2xx answer of the gateway becomes a
// `DecdnError` with the fields its contract carries (Retry-After, the
// `Link: <decdn:…>; rel="alternate"` fallback, the 503 JSON body, the
// 416 size, the pointer 409 `seq`).
import { DecdnError, type DecdnErrorCode } from "./errors.js";

export type Fetch = typeof globalThis.fetch;

const CODES: Record<number, DecdnErrorCode> = {
  400: "BAD_URI",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  416: "RANGE_NOT_SATISFIABLE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
  502: "UPSTREAM",
  503: "PAYMENT_REQUIRED",
};

/** `fetch`, with a failure to reach the gateway as `NETWORK` and an abort passed through. */
export async function send(
  fetch: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw init.signal.reason ?? e;
    throw new DecdnError(
      "NETWORK",
      `cannot reach ${new URL(url).origin}: ${(e as Error).message}`,
      {
        cause: e,
      },
    );
  }
}

/** `send`, with an answer that is not a success thrown as its `DecdnError`. */
export async function sendOk(
  fetch: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await send(fetch, url, init);
  if (response.status < 200 || response.status > 299)
    throw await errorOf(response);
  return response;
}

function linkUri(link: string | null): string | undefined {
  if (link === null) return undefined;
  const m = /<(decdn:[^>]+)>\s*;\s*rel="?alternate"?/.exec(link);
  return m?.[1];
}

/** The error for a gateway answer that is not a success. Reads the body. */
export async function errorOf(response: Response): Promise<DecdnError> {
  const status = response.status;
  let code = CODES[status] ?? "HTTP";
  let body = "";
  try {
    body = await response.text();
  } catch {
    // The status still says what went wrong.
  }
  const details: ConstructorParameters<typeof DecdnError>[2] = { status };
  let message = body.trim();
  if (message !== "") details.body = message;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim()))
    details.retryAfterSecs = Number(retryAfter.trim());
  const link = linkUri(response.headers.get("link"));
  if (link !== undefined) details.fallbackUri = link;
  if (
    (response.headers.get("content-type") ?? "").startsWith("application/json")
  ) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        const o = parsed as Record<string, unknown>;
        if (typeof o.error === "string") message = o.error;
        if (typeof o.uri === "string") details.fallbackUri = o.uri;
        if (typeof o.retry_after_secs === "number")
          details.retryAfterSecs = o.retry_after_secs;
      }
      // A u64 `seq` may exceed 2^53: read its digits, not the parsed number.
      const seq = /"seq"\s*:\s*(\d+)/.exec(body)?.[1];
      if (seq !== undefined) details.seq = BigInt(seq);
    } catch {
      // Not JSON after all: the text stands.
    }
  }
  // The gateway's 503 names the URI it cannot pay for; another 503, such as
  // a proxy's, says nothing about payment.
  if (status === 503 && details.fallbackUri === undefined) code = "HTTP";
  if (status === 416) {
    const size = /^bytes \*\/(\d+)$/.exec(
      response.headers.get("content-range") ?? "",
    )?.[1];
    if (size !== undefined) details.size = Number(size);
  }
  return new DecdnError(
    code,
    message === "" ? `gateway answered ${status}` : message,
    details,
  );
}

/**
 * What `read` makes of `text`, the gateway's success answer to `path`, parsed
 * as JSON with the integer values of `fields`, and the integers of a list
 * under one of `fields`, read as `bigint`: the gateway writes u64 ids, caps
 * and expiries as JSON numbers, which may exceed 2^53. `read` takes the
 * fields it returns with `record`, `str`, `big`, `bool` and `bigs`. `HTTP`,
 * carrying the body, for an answer that is not JSON or lacks a field its
 * contract names, or has one of another type.
 */
export function readJson<T>(
  path: string,
  text: string,
  fields: string[],
  read: (json: unknown) => T,
): T {
  try {
    return read(parseBig(text, fields));
  } catch (e) {
    if (!(e instanceof SyntaxError) && !(e instanceof TypeError)) throw e;
    throw new DecdnError(
      "HTTP",
      `the gateway's answer to ${path} is not the JSON its contract names: ${e.message}`,
      { body: text, cause: e },
    );
  }
}

/** @internal `value` as a JSON object; `TypeError` naming `what` otherwise. */
export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** @internal The string `o[key]`; `TypeError` otherwise. */
export function str(o: Record<string, unknown>, key: string): string {
  const value = o[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not a string`);
  return value;
}

/** @internal The integer `o[key]`, one of `readJson`'s `fields`; `TypeError` otherwise. */
export function big(o: Record<string, unknown>, key: string): bigint {
  const value = o[key];
  if (typeof value !== "bigint")
    throw new TypeError(`${key} is not an integer`);
  return value;
}

/** @internal The boolean `o[key]`; `TypeError` otherwise. */
export function bool(o: Record<string, unknown>, key: string): boolean {
  const value = o[key];
  if (typeof value !== "boolean")
    throw new TypeError(`${key} is not a boolean`);
  return value;
}

/** @internal The integer list `o[key]`, one of `readJson`'s `fields`, or `undefined` when absent; `TypeError` otherwise. */
export function bigs(
  o: Record<string, unknown>,
  key: string,
): bigint[] | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "bigint"))
    throw new TypeError(`${key} is not a list of integers`);
  return value as bigint[];
}

/**
 * Marks a number `parseBig` quoted, so a string the gateway wrote stays a
 * string: `\u0000` in the JSON text, a NUL in the parsed value.
 */
const BIG = "\u0000big:";
const BIG_JSON = "\\u0000big:";

function parseBig(text: string, fields: string[]): unknown {
  const names = fields.join("|");
  const quoted = text.replace(
    new RegExp(`("(?:${names})"\\s*:\\s*)(\\d+|\\[[\\d\\s,]*\\])`, "g"),
    (_match, head: string, value: string) =>
      `${head}${value.replace(/\d+/g, `"${BIG_JSON}$&"`)}`,
  );
  const toBig = (value: unknown) =>
    typeof value === "string" && value.startsWith(BIG)
      ? BigInt(value.slice(BIG.length))
      : value;
  return JSON.parse(quoted, (key, value: unknown) => {
    if (!fields.includes(key)) return value;
    return Array.isArray(value) ? value.map(toBig) : toBig(value);
  });
}
