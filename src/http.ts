// The fetch wrapper: every non-2xx answer of the gateway becomes a
// `DecdnError` with the fields its contract carries (Retry-After, the
// `Link: <decdn:…>; rel="alternate"` fallback, the 402/503 JSON body, the
// 416 size, the pointer 409 `seq`).
import { DecdnError, type DecdnErrorCode } from "./errors.js";

export type Fetch = typeof globalThis.fetch;

const CODES: Record<number, DecdnErrorCode> = {
  400: "BAD_URI",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  416: "RANGE_NOT_SATISFIABLE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
  502: "UPSTREAM",
  503: "POOL_UNFUNDED",
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

function linkUri(link: string | null): string | undefined {
  if (link === null) return undefined;
  const m = /<(decdn:[^>]+)>\s*;\s*rel="?alternate"?/.exec(link);
  return m?.[1];
}

/** The error for a gateway answer that is not a success. Reads the body. */
export async function errorOf(response: Response): Promise<DecdnError> {
  const status = response.status;
  const code = CODES[status] ?? "HTTP";
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
 * `text` parsed as JSON with the integer values of `fields` read as `bigint`:
 * the gateway writes u64 ids, caps and expiries as JSON numbers, which may
 * exceed 2^53.
 */
export function parseWithBigInts(text: string, fields: string[]): unknown {
  const names = fields.join("|");
  const quoted = text.replace(
    new RegExp(`("(?:${names})"\\s*:\\s*)(\\d+)`, "g"),
    '$1"$2"',
  );
  return JSON.parse(quoted, (key, value: unknown) =>
    fields.includes(key) && typeof value === "string" && /^\d+$/.test(value)
      ? BigInt(value)
      : value,
  );
}
