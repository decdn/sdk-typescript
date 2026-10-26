// The loopback gateway's API
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway.rs):
// `GET /_delegate` mints a delegate key, `PUT /_capability` registers a
// `dcap1:` capability issued to it for a scope, `GET /_capability` lists the
// registered ones (token only). A page calls the first two cross-origin; the
// token holder calls all three.
import type { DecdnClient } from "./client.js";
import { DecdnError } from "./errors.js";
import { errorOf, parseWithBigInts, send } from "./http.js";

/** A capability the gateway holds. */
export interface RegisteredCapability {
  signer: string;
  pool: string;
  scope: string;
  /** The page origin that registered it, or `null` for the token holder. */
  origin: string | null;
  /** The spending cap, in USDC base units. */
  cap: bigint;
  /** Unix-seconds expiry. */
  expiry: bigint;
  /** Whether a pull found it spent. */
  spent: boolean;
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
    const init: RequestInit = {
      method,
      headers: { ...this.client.authHeaders() },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] =
        "application/json";
    }
    const response = await send(
      this.client.fetch,
      `${this.client.origin}${path}`,
      init,
    );
    if (response.status < 200 || response.status > 299)
      throw await errorOf(response);
    return response.text();
  }

  /** A fresh delegate key the gateway holds for 15 minutes unless a capability claims it. */
  async delegate(): Promise<{ address: string }> {
    const parsed = JSON.parse(await this.call("GET", "/_delegate")) as {
      address: string;
    };
    return { address: parsed.address };
  }

  /** Register `capability` (a `dcap1:` issued to a delegate) for `scope`: `example.com`, `*.example.com` or `*`. */
  async registerCapability(args: {
    capability: string;
    scope: string;
  }): Promise<{ signer: string; scope: string; expiry: bigint }> {
    const text = await this.call("PUT", "/_capability", {
      capability: args.capability,
      scope: args.scope,
    });
    return parseWithBigInts(text, ["expiry"]) as {
      signer: string;
      scope: string;
      expiry: bigint;
    };
  }

  /** The capabilities the gateway holds. Needs the token. */
  async capabilities(): Promise<RegisteredCapability[]> {
    const text = await this.call("GET", "/_capability");
    return parseWithBigInts(text, ["cap", "expiry"]) as RegisteredCapability[];
  }
}
