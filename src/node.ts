// Node.js helpers: `@decdn/client/node`, under the `node` export condition.
import { homedir } from "node:os";
import { join } from "node:path";

/** The loopback gateway's default data dir, `~/.decdn/gateway`. */
export function defaultDataDir(): string {
  return join(homedir(), ".decdn", "gateway");
}
