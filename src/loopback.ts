// The loopback gateway's API
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway.rs):
// `GET /_delegate` names the gateway's pending delegate key, `PUT /_capability`
// registers a `dcap1:` capability issued to a key the gateway holds, and
// `GET /_capability` lists the registered ones. None of them answers
// cross-origin, so a web page cannot call them.
import type { DecdnClient } from "./client.js";
import { DecdnError } from "./errors.js";
import { parseWithBigInts, sendOk } from "./http.js";

/** A capability the gateway holds. */
export interface RegisteredCapability {
  /** The spending cap, in USDC base units. */
  cap: bigint;
  /** Unix-seconds expiry. */
  expiry: bigint;
  pool: string;
  signer: string;
  /** Whether a pull stopped for funding on it. */
  spent: boolean;
}

/** What `registerCapability` registered. */
export interface Registration {
  /** Unix-seconds expiry. */
  expiry: bigint;
  pool: string;
  signer: string;
}

export class LoopbackApi {
  /** @internal */
  constructor(private readonly client: DecdnClient) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    if (this.client.context !== "loopback") {
      throw new DecdnError(
        "CONFIG",
        "the delegate and capability API is a loopback gateway's alone",
      );
    }
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const response = await sendOk(
      this.client.fetch,
      `${this.client.origin}${path}`,
      init,
    );
    return response.text();
  }

  /**
   * The gateway's pending delegate key: the same address on every call until
   * a capability claims it, then a fresh one. The gateway holds its keys in
   * memory, so a restart loses them and every capability issued to them.
   */
  async delegate(): Promise<{ address: string }> {
    const parsed = JSON.parse(await this.call("GET", "/_delegate")) as {
      address: string;
    };
    return { address: parsed.address };
  }

  /**
   * Register `capability`, a `dcap1:` issued to a key the gateway holds. A key
   * holds one capability per pool. `CONFLICT` when the gateway does not hold
   * the signer's key, or that key already holds a capability from that pool.
   */
  async registerCapability(args: {
    capability: string;
  }): Promise<Registration> {
    const text = await this.call("PUT", "/_capability", {
      capability: args.capability,
    });
    const parsed = parseWithBigInts(text, ["expiry"]) as Registration;
    return { signer: parsed.signer, pool: parsed.pool, expiry: parsed.expiry };
  }

  /**
   * The unexpired capabilities the gateway holds, in registration order: the
   * order it pays with them.
   */
  async capabilities(): Promise<RegisteredCapability[]> {
    const text = await this.call("GET", "/_capability");
    return parseWithBigInts(text, ["cap", "expiry"]) as RegisteredCapability[];
  }
}
