// The loopback gateway's API
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway.rs):
// `GET /_delegate` names the gateway's pending delegate key, `PUT /_capability`
// registers a `dcap1:` capability issued to a key the gateway holds, and
// `GET /_capability` lists the registered ones. None of them answers
// cross-origin, so a web page cannot call them.
import type { DecdnClient } from "./client.js";
import { DecdnError } from "./errors.js";
import { parseWithBigInts, sendOk } from "./http.js";
import { integer } from "./pointer.js";

/**
 * The content a registered capability pays for: `"any"`, or only the
 * content of `namespaces`. A namespace scope carries the pool owner's EIP-712
 * `CapabilityScope(address signer,bytes32 poolId,uint256[] namespaces)`
 * signature (domain `decdn-capability-scope`, version `1`, the chain id, and
 * the PaymentPool as verifying contract), which the SDK passes through.
 */
export type CapabilityScope =
  | "any"
  | {
      /** Namespace ids, each at least 1; at least one. */
      namespaces: readonly (bigint | number)[];
      /** `0x` + the 65-byte signature, in hex. */
      signature: string;
    };

/** A capability the gateway holds. */
export interface RegisteredCapability {
  /** The spending cap, in USDC base units. */
  cap: bigint;
  /** Unix-seconds expiry. */
  expiry: bigint;
  /** The namespaces a namespace-scoped capability pays for; absent when it pays for any content. */
  namespaces?: bigint[];
  pool: string;
  signer: string;
  /** Whether a pull stopped for funding on it. */
  spent: boolean;
}

/** What `registerCapability` registered. */
export interface Registration {
  /** Unix-seconds expiry. */
  expiry: bigint;
  /** The namespaces a namespace-scoped capability pays for; absent when it pays for any content. */
  namespaces?: bigint[];
  pool: string;
  signer: string;
}

export class LoopbackApi {
  /** @internal */
  constructor(private readonly client: DecdnClient) {}

  private async call(
    method: string,
    path: string,
    body?: string,
  ): Promise<string> {
    if (this.client.context !== "loopback") {
      throw new DecdnError(
        "CONFIG",
        "the delegate and capability API is a loopback gateway's alone",
      );
    }
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = body;
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
   * Register `capability`, a `dcap1:` issued to a key the gateway holds, to
   * pay for the content `scope` names. A key holds one capability per pool.
   * `CONFLICT` when the gateway does not hold the signer's key, or that key
   * already holds a capability from that pool; `UNPROCESSABLE` for a scope
   * the gateway refuses, among them a namespace scope whose signature does
   * not recover the pool's owner.
   */
  async registerCapability(args: {
    capability: string;
    scope: CapabilityScope;
  }): Promise<Registration> {
    const text = await this.call(
      "PUT",
      "/_capability",
      `{"capability":${JSON.stringify(args.capability)},"scope":${scopeJson(args.scope)}}`,
    );
    const parsed = parseWithBigInts(text, [
      "expiry",
      "namespaces",
    ]) as Registration;
    const registration: Registration = {
      signer: parsed.signer,
      pool: parsed.pool,
      expiry: parsed.expiry,
    };
    if (parsed.namespaces !== undefined)
      registration.namespaces = parsed.namespaces;
    return registration;
  }

  /**
   * The unexpired capabilities the gateway holds, in registration order: the
   * order it pays with them.
   */
  async capabilities(): Promise<RegisteredCapability[]> {
    const text = await this.call("GET", "/_capability");
    return parseWithBigInts(text, [
      "cap",
      "expiry",
      "namespaces",
    ]) as RegisteredCapability[];
  }
}

/** `scope` as the JSON `PUT /_capability` carries, its namespace ids as integers. */
function scopeJson(scope: CapabilityScope): string {
  if (scope === "any") return '"any"';
  if (
    typeof scope !== "object" ||
    scope === null ||
    !Array.isArray(scope.namespaces)
  ) {
    throw new DecdnError(
      "CONFIG",
      'a capability scope is "any" or { namespaces, signature }',
    );
  }
  const ids = scope.namespaces.map((n) => integer(n, "a namespace id"));
  return `{"namespaces":[${ids.join(",")}],"signature":${JSON.stringify(scope.signature)}}`;
}
