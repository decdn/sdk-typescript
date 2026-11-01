import { describe, expect, it } from "vitest";
import { DecdnError } from "../../src/index.js";
import { collect, slice } from "../../src/verify.js";

/** A stream of `chunks`, recording whether, and why, its reader cancelled it. */
function chunked(...chunks: number[][]) {
  const state: { cancelled: boolean; reason?: unknown; pulled: number } = {
    cancelled: false,
    pulled: 0,
  };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      state.pulled = i;
      if (next === undefined) controller.close();
      else controller.enqueue(new Uint8Array(next));
    },
    cancel(reason) {
      state.cancelled = true;
      state.reason = reason;
    },
  });
  return { stream, state };
}

async function window(offset: number, length?: number): Promise<number[]> {
  const { stream } = chunked([0, 1, 2], [3, 4], [5, 6, 7]);
  return [...(await collect(slice(stream, offset, length)))];
}

describe("slice", () => {
  it("cuts a window across chunk boundaries", async () => {
    expect(await window(2, 4)).toEqual([2, 3, 4, 5]);
    expect(await window(3, 2)).toEqual([3, 4]);
    expect(await window(0, 1)).toEqual([0]);
    expect(await window(5)).toEqual([5, 6, 7]);
    expect(await window(7, 10)).toEqual([7]);
  });

  it("fails a window that starts at or past the end of a body", async () => {
    for (const offset of [8, 20]) {
      const { stream } = chunked([0, 1, 2], [3, 4], [5, 6, 7]);
      const e = await collect(slice(stream, offset)).catch((e: unknown) => e);
      expect(e).toBeInstanceOf(DecdnError);
      expect((e as DecdnError).code).toBe("RANGE_NOT_SATISFIABLE");
      expect((e as DecdnError).size).toBe(8);
    }
  });

  it("answers an empty body empty, whatever the window", async () => {
    const { stream } = chunked();
    expect(await collect(slice(stream, 5))).toEqual(new Uint8Array());
  });

  it("stops reading once the window is whole", async () => {
    const { stream, state } = chunked([0, 1, 2], [3, 4], [5, 6, 7]);
    expect([...(await collect(slice(stream, 1, 2)))]).toEqual([1, 2]);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(3);
  });

  it("passes a cancel and its reason upstream", async () => {
    const { stream, state } = chunked([0, 1, 2]);
    const reason = new Error("stop");
    await slice(stream, 0).cancel(reason);
    expect(state.cancelled).toBe(true);
    expect(state.reason).toBe(reason);
  });

  it("passes an upstream error through", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DecdnError("TRUNCATED", "cut"));
      },
    });
    const e = await collect(slice(failing, 0)).catch((e: unknown) => e);
    expect((e as DecdnError).code).toBe("TRUNCATED");
  });
});
