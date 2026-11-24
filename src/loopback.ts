// The gateway's delegate and capability API, which the SDK offers on a
// loopback client
// (https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway.rs):
// `GET /_delegate` names the gateway's pending delegate key, `PUT /_capability`
// registers a `dcap1:` capability issued to a key the gateway holds, and
// `GET /_capability` lists the registered ones. None of them answers
// cross-origin, so a web page cannot call them.
import type { DecdnClient } from "./client.js";
import { DecdnError } from "./errors.js";
import { big, bigs, bool, readJson, record, sendOk, str } from "./http.js";
import { namespaceId } from "./pointer.js";

/**
 * The content a registered capability pays for: `"any"`, or only the
 * content of `namespaces`. A namespace scope carries the pool owner's EIP-712
 * `CapabilityScope(address signer,bytes32 poolId,uint256[] namespaces)`
 * signature (domain `decdn-capability-scope`, version `1`, the chain id, and
 * the PaymentPool as verifying contract), which the SDK passes through
 * ([scope](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md#scope)).
 */
export type CapabilityScope =
  | "any"
  | {
      /** Namespace ids, each a u64 of at least 1; at least one. */
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
        "the SDK offers the delegate and capability API on a loopback client alone: open one on a localhost or loopback-address URL",
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
    return readJson(
      "/_delegate",
      await this.call("GET", "/_delegate"),
      [],
      (json) => ({ address: str(record(json, "the answer"), "address") }),
    );
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
    return readJson("/_capability", text, ["expiry", "namespaces"], (json) => {
      const o = record(json, "the answer");
      const registration: Registration = {
        signer: str(o, "signer"),
        pool: str(o, "pool"),
        expiry: big(o, "expiry"),
      };
      const namespaces = bigs(o, "namespaces");
      if (namespaces !== undefined) registration.namespaces = namespaces;
      return registration;
    });
  }

  /**
   * The unexpired capabilities the gateway holds, in registration order. The
   * gateway pays a request that selects a namespace with the earliest
   * capability scoped to it, else with the earliest `"any"` one
   * ([capabilities](https://github.com/decdn/decdn/blob/main/adr/appendix-gateway.md#capabilities)).
   */
  async capabilities(): Promise<RegisteredCapability[]> {
    const text = await this.call("GET", "/_capability");
    return readJson(
      "/_capability",
      text,
      ["cap", "expiry", "namespaces"],
      (json) => {
        if (!Array.isArray(json))
          throw new TypeError("the answer is not a list");
        return json.map((entry: unknown) => {
          const o = record(entry, "an entry");
          const namespaces = bigs(o, "namespaces");
          // The keys in the order the gateway lists them.
          return {
            cap: big(o, "cap"),
            expiry: big(o, "expiry"),
            ...(namespaces === undefined ? {} : { namespaces }),
            pool: str(o, "pool"),
            signer: str(o, "signer"),
            spent: bool(o, "spent"),
          };
        });
      },
    );
  }
}

/**
 * `scope` as the JSON `PUT /_capability` carries, its namespace ids as
 * integers; `CONFIG` for a scope the gateway would refuse as malformed.
 */
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
  if (scope.namespaces.length === 0)
    throw new DecdnError("CONFIG", "a scope names at least one namespace");
  const ids = scope.namespaces.map(namespaceId);
  const { signature } = scope as { signature: unknown };
  if (
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature)
  ) {
    throw new DecdnError(
      "CONFIG",
      "a scope signature is 0x and 65 bytes in hex",
    );
  }
  return `{"namespaces":[${ids.join(",")}],"signature":"${signature}"}`;
}
