// Node.js helpers: `@decdn/client/node`, under the `node` export condition.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DecdnError } from "./errors.js";

/** The loopback gateway's default data dir, `~/.decdn/gateway`. */
export function defaultDataDir(): string {
  return join(homedir(), ".decdn", "gateway");
}

/**
 * The token a loopback `decdn gateway` keeps in `<dataDir>/token` (mode 0600),
 * for `DecdnClient.open({ token })`. `dataDir` is the gateway's `--data-dir`.
 */
export async function readLoopbackToken(
  dataDir: string = defaultDataDir(),
): Promise<string> {
  const path = join(dataDir, "token");
  let token: string;
  try {
    token = (await readFile(path, "utf8")).trim();
  } catch (e) {
    throw new DecdnError(
      "CONFIG",
      `cannot read the gateway token at ${path}: start \`decdn gateway\` first`,
      {
        cause: e,
      },
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new DecdnError(
      "CONFIG",
      `${path} does not hold a gateway token (64 hex characters)`,
    );
  }
  return token;
}
