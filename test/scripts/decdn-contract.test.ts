// Gates of scripts/decdn-contract.sh: arguments it refuses stop it before
// any tool runs, and arguments it takes reach the first tool check. The
// script runs with a PATH that holds no tool at all.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/decdn-contract.sh");
const FIRST_TOOL_CHECK = "git not found on PATH";
// Resolved before the runs empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();

function run(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "decdn-contract-"));
  return spawnSync(BASH, [SCRIPT, ...args], {
    cwd: home,
    env: { HOME: home, PATH: join(home, "no-tools") },
    encoding: "utf8",
  });
}

describe("decdn-contract.sh", () => {
  it.each([[[]], [["--tag", "v0.3.0", "--ref", "main"]]])(
    "takes exactly one of --tag or --ref (%j)",
    (args) => {
      const r = run(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("pass exactly one of --tag or --ref");
      expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
    },
  );

  it.each([["--bogus"], ["--tag"], ["--ref"], ["--decdn-dir"]])(
    "stops on the malformed argument %s",
    (arg) => {
      const r = run(arg);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("usage: scripts/decdn-contract.sh");
    },
  );

  it.each(["0.3.0", "v0.3", "v03.0.0", "sdk-v0.3.0", "v0.3.0+build"])(
    "stops on the tag %s before any tool runs",
    (tag) => {
      const r = run("--tag", tag);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("the tag must be v<major>.<minor>.<patch>");
      expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
    },
  );

  it("stops on a ref that reads as an option", () => {
    const r = run("--ref", "--upload-pack=x");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a git ref");
    expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
  });

  it.each([
    [["--tag", "v0.3.0"]],
    [["--tag", "v1.2.3-rc.1"]],
    [["--ref", "main"]],
    [["--ref", "feat/typescript-sdk", "--decdn-dir", "/tmp/decdn"]],
  ])("takes %j to the tool checks", (args) => {
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(FIRST_TOOL_CHECK);
  });
});
