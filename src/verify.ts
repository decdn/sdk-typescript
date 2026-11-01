// The body guard: a stream that passes the gateway's bytes through, hashes
// them as they go when the request named the bytes by hash, and ends with an
// error instead of `done` when they do not hash to it, when fewer bytes arrive
// than declared, or when more arrive than the body may hold.
import { concat } from "./bytes.js";
import { DecdnError } from "./errors.js";
import { createBlake3 } from "./hash.js";

export interface GuardOptions {
  /** The hash the whole body must have, or `undefined` to skip the check. */
  hash?: string;
  /** The fewest bytes the body holds: the manifest's size, or Content-Length. */
  length?: number;
  /** The most bytes the body may hold: the manifest's size, or the window asked for. */
  max?: number;
  /** The request's signal: a read it aborts fails with its reason. */
  signal?: AbortSignal;
}

/** `body`, guarded: a failed read is `TRUNCATED`, a short or long body `TRUNCATED`, a wrong hash `HASH_MISMATCH`. */
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
            : opts.signal?.aborted === true
              ? opts.signal.reason
              : new DecdnError("TRUNCATED", "the body ended early", {
                  cause: e,
                }),
        );
        return;
      }
      if (!chunk.done) {
        delivered += chunk.value.length;
        if (opts.max !== undefined && delivered > opts.max) {
          controller.error(
            new DecdnError(
              "TRUNCATED",
              `the body ran past the ${opts.max} bytes it may hold`,
            ),
          );
          // The error is the caller's already; a failed cancel adds nothing.
          reader?.cancel().catch(() => undefined);
          return;
        }
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
  return concat(parts);
}

/** The error for a window from `offset` of a body of `size` bytes, as the gateway's 416 maps. */
export function pastEnd(offset: number, size: number): DecdnError {
  return new DecdnError(
    "RANGE_NOT_SATISFIABLE",
    `the range starts at ${offset}, past the ${size} bytes`,
    { size },
  );
}

/**
 * The bytes of `body` from `offset`, at most `length` of them: the window a
 * range asked for, cut from a whole body the gateway answered it with. A
 * body that is not empty and ends at or before `offset` fails with
 * `RANGE_NOT_SATISFIABLE`.
 */
export function slice(
  body: ReadableStream<Uint8Array>,
  offset: number,
  length?: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const end = length === undefined ? Infinity : offset + length;
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (at >= end) {
          controller.close();
          // The window is whole: the rest of the body is not wanted.
          reader.cancel().catch(() => undefined);
          return;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          if (at > 0 && at <= offset) controller.error(pastEnd(offset, at));
          else controller.close();
          return;
        }
        const start = at;
        at += chunk.value.length;
        const from = Math.max(0, offset - start);
        const to = Math.min(chunk.value.length, end - start);
        if (to > from) {
          controller.enqueue(chunk.value.subarray(from, to));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
