/** What went wrong, as a stable code a caller can branch on. */
export type DecdnErrorCode =
  /** 402: the gateway's allowance is spent, or the content does not fit what is left, or no capability covers the host. */
  | "PAYMENT_REQUIRED"
  /** 503: the gateway's pool cannot pay. */
  | "POOL_UNFUNDED"
  /** 404. */
  | "NOT_FOUND"
  /** 416: the range starts past the end; `size` holds the entry's size. */
  | "RANGE_NOT_SATISFIABLE"
  /** 401: the loopback token is missing or wrong. */
  | "UNAUTHORIZED"
  /** 403. */
  | "FORBIDDEN"
  /** 400, or a `decdn:` URI that does not parse. */
  | "BAD_URI"
  /** 429. */
  | "RATE_LIMITED"
  /** 502: the gateway's pull failed upstream. */
  | "UPSTREAM"
  /** 413. */
  | "PAYLOAD_TOO_LARGE"
  /** 409: a pointer `seq` that is not newer, or a capability already registered. */
  | "CONFLICT"
  /** 422. */
  | "UNPROCESSABLE"
  /** The bytes do not hash to the hash that names them. */
  | "HASH_MISMATCH"
  /** The body is shorter or longer than declared, or the stream failed. */
  | "TRUNCATED"
  /** A bundle manifest that does not parse. */
  | "MALFORMED_MANIFEST"
  /** A `dcap1:` capability token that does not decode. */
  | "BAD_CAPABILITY"
  /** The gateway could not be reached. */
  | "NETWORK"
  /** The client is not set up for the call, or the call cannot be honoured as asked. */
  | "CONFIG"
  /** A status the gateway contract does not name. */
  | "HTTP";

/** Fields a {@link DecdnError} may carry besides its code and message. */
export interface DecdnErrorDetails {
  /** The HTTP status, when the gateway answered. */
  status?: number;
  /** Seconds to wait before a retry, from `Retry-After` or the JSON body. */
  retryAfterSecs?: number;
  /** The canonical `decdn:` URI to fetch with a paying client instead. */
  fallbackUri?: string;
  /** The entry's size, on `RANGE_NOT_SATISFIABLE`. */
  size?: number;
  /** The highest stored `seq`, on a pointer `CONFLICT`. */
  seq?: bigint;
  /** The response body, as text. */
  body?: string;
  /** What caused this error. */
  cause?: unknown;
}

/** Every failure the SDK reports. */
export class DecdnError extends Error {
  override readonly name = "DecdnError";
  readonly code: DecdnErrorCode;
  readonly status?: number;
  readonly retryAfterSecs?: number;
  readonly fallbackUri?: string;
  readonly size?: number;
  readonly seq?: bigint;
  readonly body?: string;

  constructor(
    code: DecdnErrorCode,
    message: string,
    details: DecdnErrorDetails = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterSecs !== undefined)
      this.retryAfterSecs = details.retryAfterSecs;
    if (details.fallbackUri !== undefined)
      this.fallbackUri = details.fallbackUri;
    if (details.size !== undefined) this.size = details.size;
    if (details.seq !== undefined) this.seq = details.seq;
    if (details.body !== undefined) this.body = details.body;
  }
}
