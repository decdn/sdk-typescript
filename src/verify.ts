// The body guard: a stream that passes the gateway's bytes through, hashes
// them as they go when the request named the bytes by hash, and ends with an
// error instead of `done` when they do not hash to it or when fewer bytes
// arrive than the response declared.
import { DecdnError } from "./errors.js";
import { createBlake3 } from "./hash.js";

export interface GuardOptions {
  /** The hash the whole body must have, or `undefined` to skip the check. */
  hash?: string;
  /** The length the response declared, if any. */
  length?: number;
}

/** `body`, guarded: a failed read is `TRUNCATED`, a short body `TRUNCATED`, a wrong hash `HASH_MISMATCH`. */
export function guard(
  body: ReadableStream<Uint8Array> | null,
  opts: GuardOptions,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  const hasher = opts.hash === undefined ? undefined : createBlake3();
  let delivered = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk =
          reader === undefined
            ? { done: true, value: undefined }
            : await reader.read();
      } catch (e) {
        controller.error(
          e instanceof DecdnError
            ? e
            : new DecdnError("TRUNCATED", "the body ended early", { cause: e }),
        );
        return;
      }
      if (!chunk.done) {
        delivered += chunk.value.length;
        hasher?.update(chunk.value);
        controller.enqueue(chunk.value);
        return;
      }
      if (opts.length !== undefined && delivered < opts.length) {
        controller.error(
          new DecdnError(
            "TRUNCATED",
            `the body ended after ${delivered} of ${opts.length} bytes`,
          ),
        );
        return;
      }
      if (hasher !== undefined && opts.hash !== undefined) {
        const got = hasher.hex();
        if (got !== opts.hash) {
          controller.error(
            new DecdnError(
              "HASH_MISMATCH",
              `the body hashes to ${got}, not ${opts.hash}`,
            ),
          );
          return;
        }
      }
      controller.close();
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

/** Every byte of `stream`, joined. */
export async function collect(
  stream: ReadableStream<Uint8Array>,
  limit?: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (limit !== undefined && total > limit) {
      await reader.cancel();
      throw new DecdnError(
        "MALFORMED_MANIFEST",
        `the body is larger than ${limit} bytes`,
      );
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
