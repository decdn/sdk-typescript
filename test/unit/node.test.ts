import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir, readLoopbackToken } from "../../src/node.js";

describe("readLoopbackToken", () => {
  it("reads the trimmed token the gateway wrote under its data dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decdn-token-"));
    writeFileSync(join(dir, "token"), `${"ab".repeat(32)}\n`);
    expect(await readLoopbackToken(dir)).toBe("ab".repeat(32));
  });

  it("fails with CONFIG when there is no token or it is not 64 hex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decdn-token-"));
    await expect(readLoopbackToken(dir)).rejects.toMatchObject({
      code: "CONFIG",
    });
    writeFileSync(join(dir, "token"), "short");
    await expect(readLoopbackToken(dir)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("defaults to ~/.decdn/gateway", () => {
    expect(defaultDataDir()).toMatch(/[/\\]\.decdn[/\\]gateway$/);
  });
});
