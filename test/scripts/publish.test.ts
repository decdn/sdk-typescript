// Gates of scripts/publish.sh. An npm version cannot be published twice, so
// what the script refuses must stop it before anything else runs: a tag that
// is not `v<semver>` and a typo in a switch. These tests run the real script
// with a PATH that holds no tool at all: input it accepts gets as far as the
// first tool check, and input it refuses stops before it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/publish.sh");
const FIRST_TOOL_CHECK = "git not found on PATH";
// Resolved before the runs empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();

function run(tag: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "publish-gates-"));
  return spawnSync(BASH, [SCRIPT, tag], {
    cwd: home,
    env: { HOME: home, PATH: join(home, "no-tools"), ...env },
    encoding: "utf8",
  });
}

describe("publish.sh", () => {
  it.each([
    "sdk-v0.1.0",
    "0.1.0",
    "v0.1",
    "v01.0.0",
    "v0.1.0+build",
    "v0.1.0-",
    "x",
  ])("stops on the tag %s before any tool runs", (tag) => {
    const r = run(tag);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the tag must be v<major>.<minor>.<patch>");
    expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
  });

  it.each(["v0.1.0", "v1.20.3", "v0.2.0-rc.1"])(
    "takes the tag %s to the tool checks",
    (tag) => {
      const r = run(tag);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(FIRST_TOOL_CHECK);
    },
  );

  it.each(["maybe", "2", "on"])(
    "stops on DECDN_NPM_DRY_RUN=%s before any tool runs",
    (value) => {
      const r = run("v0.1.0", { DECDN_NPM_DRY_RUN: value });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `DECDN_NPM_DRY_RUN must be 1/true/yes or 0/false/no, got '${value}'`,
      );
      expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
    },
  );

  it.each(["", "0", "no", "1", "TRUE", "yes"])(
    "takes DECDN_NPM_DRY_RUN=%s to the tool checks",
    (value) => {
      const r = run("v0.1.0", { DECDN_NPM_DRY_RUN: value });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(FIRST_TOOL_CHECK);
    },
  );
});
