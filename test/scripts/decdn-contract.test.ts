// Gates of scripts/decdn-contract.sh: arguments it refuses stop it before
// any tool runs, and arguments it takes reach the first tool check. The
// script runs with a PATH that holds no tool at all.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { shippedAfter } from "../contract/fixture.js";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/decdn-contract.sh");
const FIRST_TOOL_CHECK = "git not found on PATH";
// Resolved before the runs empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();

/** The script's `released_after`, run alone: whether `release` shipped after `version`. */
function releasedAfter(release: string, version: string): boolean {
  const fn = /^released_after\(\) \{\n[\s\S]*?^\}$/m.exec(
    readFileSync(SCRIPT, "utf8"),
  )?.[0];
  expect(fn).toBeDefined();
  const r = spawnSync(
    BASH,
    ["-c", `${fn}\nreleased_after "$1" "$2"`, "bash", release, version],
    { encoding: "utf8" },
  );
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
  return r.status === 0;
}

function run(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "decdn-contract-"));
  return spawnSync(BASH, [SCRIPT, ...args], {
    cwd: home,
    env: { HOME: home, PATH: join(home, "no-tools") },
    encoding: "utf8",
  });
}

describe("decdn-contract.sh", () => {
  it.each([
    ["0.3.0", false],
    ["0.3.1", false],
    ["0.3.1-rc.1", false],
    ["0.3.2-rc.1", true],
    ["0.3.2", true],
    ["0.3.10", true],
    ["0.4.0", true],
    ["1.0.0", true],
    ["0.2.9", false],
  ])(
    "reads %s as shipped after 0.3.1: %s, as shippedAfter does",
    (release, after) => {
      expect(releasedAfter(release, "0.3.1")).toBe(after);
      vi.stubEnv("DECDN_CONTRACT_RELEASE", release);
      try {
        expect(shippedAfter("0.3.1")).toBe(after);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
