// Gates and runs of scripts/release.sh. The argument gates run the real script
// with a PATH that holds no tool at all. The rest run it in a fixture repo with
// a bare origin, the real cliff.toml, git and git-cliff, and stubs for `pnpm`
// (`exec prettier` passes the file through, `version` sets package.json's
// version, the checks log their name) and `gh` (the gateway floor's release).
// The host's git config is kept out, and the release commit and tag are signed
// with an ephemeral ssh key. The fixture runs skip without git-cliff or
// ssh-keygen on PATH; CI installs git-cliff.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release.sh");
const FIRST_TOOL_CHECK = "git not found on PATH";
// Resolved before the gate runs empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();
const has = (tool: string) =>
  spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const TODAY = new Date().toISOString().slice(0, 10);

describe("release.sh arguments", () => {
  function gate(...args: string[]) {
    const home = mkdtempSync(join(tmpdir(), "release-gates-"));
    return spawnSync(BASH, [SCRIPT, ...args], {
      cwd: home,
      env: { HOME: home, PATH: join(home, "no-tools") },
      encoding: "utf8",
    });
  }

  it.each([["1.2"], ["v1.2.3"], ["next"], ["minor", "patch"], ["--force"]])(
    "stops on %j before any tool runs",
    (...args) => {
      const r = gate(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
      expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
    },
  );

  it.each([
    [],
    ["auto"],
    ["minor"],
    ["1.2.3"],
    ["patch", "--execute", "--no-verify", "--allow-unconventional"],
  ])("takes %j to the tool checks", (...args) => {
    const r = gate(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(FIRST_TOOL_CHECK);
  });
});

const PNPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$RS_LOG"
case "$1" in
  exec) cat ;;
  version) node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8")); p.version = process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\\n")' "$2" ;;
  *) test ! -e "$RS_FAIL" ;;
esac
`;
const GH_STUB = `#!/usr/bin/env bash
case "$*" in
  *releases/tags/v0.3.0*) echo "\${RS_DRAFT-false}" ;;
  *) exit 1 ;;
esac
`;
const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- **The client.** It fetches.
`;

describe.skipIf(!has("git-cliff") || !has("ssh-keygen"))(
  "release.sh in a fixture repo",
  () => {
    let work: string, repo: string, origin: string, log: string;
    let env: NodeJS.ProcessEnv;

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    const release = (...args: string[]) =>
      spawnSync(join(repo, "scripts/release.sh"), args, {
        cwd: repo,
        env,
        encoding: "utf8",
      });
    // <path> <subject>: change <path>, commit and push.
    function commit(path: string, subject: string) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), `${Math.random()}\n`, { flag: "a" });
      git("add", "-A");
      git("commit", "-qm", subject);
      git("push", "-q", "origin", "main");
    }
    const file = (path: string) => readFileSync(join(repo, path), "utf8");
    const version = () => JSON.parse(file("package.json")).version;
    // The first release, executed: tags v0.1.0 on origin.
    function first() {
      const r = release("minor", "--execute", "--no-verify");
      expect(r.status, r.stderr).toBe(0);
    }

    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "release-fixture-"));
      repo = join(work, "repo");
      origin = join(work, "origin.git");
      log = join(work, "log");
      const bin = join(work, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "pnpm"), PNPM_STUB);
      writeFileSync(join(bin, "gh"), GH_STUB);
      chmodSync(join(bin, "pnpm"), 0o755);
      chmodSync(join(bin, "gh"), 0o755);
      env = {
        HOME: work,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        RS_LOG: log,
        RS_FAIL: join(work, "fail"),
      };
      const key = join(work, "key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
        env,
      });
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
      for (const [k, v] of Object.entries({
        "user.name": "Release Test",
        "user.email": "release@example.org",
        "gpg.format": "ssh",
        "user.signingkey": `${key}.pub`,
        "commit.gpgsign": "false",
      })) {
        git("config", k, v);
      }
      mkdirSync(join(repo, "scripts"));
      copyFileSync(SCRIPT, join(repo, "scripts/release.sh"));
      writeFileSync(
        join(repo, "scripts/check-package.sh"),
        '#!/usr/bin/env bash\necho check-package >> "$RS_LOG"\n',
      );
      chmodSync(join(repo, "scripts/check-package.sh"), 0o755);
      copyFileSync(join(ROOT, "cliff.toml"), join(repo, "cliff.toml"));
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify(
          {
            name: "@decdn/client",
            version: "0.0.0",
            decdn: { gatewayFloor: "0.3.0" },
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
      git("add", "-A");
      git("commit", "-qm", "chore: the fixture");
      git("remote", "add", "origin", origin);
      git("push", "-q", "-u", "origin", "main");
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    it("dry-runs the first release without changing a file", () => {
      const r = release("minor");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("release @decdn/client: v0.1.0");
      expect(r.stdout).toContain(`+## [0.1.0] — ${TODAY}`);
      expect(r.stdout).toContain('+  "version": "0.1.0",');
      expect(r.stdout).toContain("dry run: no file changed");
      expect(git("status", "--porcelain")).toBe("");
      expect(git("tag")).toBe("");
    });

    it("refuses a first release without a level", () => {
      const r = release();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("the first release names its level");
    });

    it("releases the first version from [Unreleased], signed and pushed", () => {
      const r = release("minor", "--execute");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("scripts/publish.sh v0.1.0");
      expect(version()).toBe("0.1.0");
      expect(file("CHANGELOG.md")).toContain(
        `## [0.1.0] — ${TODAY}\n\n### Added\n\n- **The client.** It fetches.`,
      );
      expect(file("CHANGELOG.md")).not.toContain("[Unreleased]");
      expect(git("log", "-1", "--format=%s")).toBe("chore(release): v0.1.0\n");
      expect(git("cat-file", "-p", "HEAD")).toContain("gpgsig ");
      expect(git("cat-file", "-p", "v0.1.0")).toContain("@decdn/client 0.1.0");
      expect(git("cat-file", "-p", "v0.1.0")).toContain(
        "-----BEGIN SSH SIGNATURE-----",
      );
      const remote = git(
        "ls-remote",
        "origin",
        "refs/heads/main",
        "refs/tags/v0.1.0^{}",
      );
      const head = git("rev-parse", "HEAD").trim();
      expect(remote.match(new RegExp(`^${head}\\s`, "gm"))).toHaveLength(2);
      expect(readFileSync(log, "utf8")).toContain(
        "version 0.1.0 --no-git-tag-version\nlint\ntest\nbuild\ncheck-package\n",
      );
    });

    it("generates a later section and bumps the minor on a feature", () => {
      first();
      commit("src/a.ts", "fix(site): keep the query (#3)");
      commit("src/b.ts", "feat: open a bundle (#4)");
      commit("test/a.ts", "test: cover it (#5)");
      commit(".github/ci.yml", "ci: pin an action (#6)");
      const r = release("--execute", "--no-verify");
      expect(r.status, r.stderr).toBe(0);
      expect(version()).toBe("0.2.0");
      const changelog = file("CHANGELOG.md");
      expect(changelog).toContain(
        `## [0.2.0] — ${TODAY}\n\n### Added\n\n- Open a bundle (#4)\n\n### Fixed\n\n- **site**: Keep the query (#3)\n\n## [0.1.0]`,
      );
      expect(changelog).not.toMatch(/Cover it|Pin an action/);
    });

    it("bumps the patch on a fix", () => {
      first();
      commit("src/a.ts", "fix: a fix");
      const r = release();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("release @decdn/client: v0.1.0 -> v0.1.1");
    });

    it("takes an explicit version", () => {
      first();
      commit("src/a.ts", "fix: a fix");
      const r = release("0.4.0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("v0.1.0 -> v0.4.0");
    });

    it("refuses when nothing makes a changelog entry", () => {
      first();
      commit("test/a.ts", "test: more tests");
      commit(".github/ci.yml", "ci: a job");
      const r = release("patch");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("nothing to release");
    });

    it("refuses unconventional commits unless allowed", () => {
      first();
      commit("src/a.ts", "Update the client");
      commit("src/b.ts", "fix: a fix");
      let r = release();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("cannot parse these commits");
      expect(r.stderr).toContain(" Update the client");
      r = release("--allow-unconventional");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("v0.1.0 -> v0.1.1");
      expect(r.stdout).not.toContain("Update the client");
    });

    it("refuses an [Unreleased] section after the first release", () => {
      first();
      commit("src/a.ts", "fix: a fix");
      writeFileSync(
        join(repo, "CHANGELOG.md"),
        file("CHANGELOG.md").replace(
          "## [0.1.0]",
          "## [Unreleased]\n\n- a hand edit\n\n## [0.1.0]",
        ),
      );
      git("commit", "-qam", "docs: a hand edit");
      git("push", "-q", "origin", "main");
      const r = release();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("has an [Unreleased] section");
    });

    it("refuses another branch, a dirty tree and a lag behind origin", () => {
      git("switch", "-qc", "topic");
      expect(release("minor").stderr).toContain("releases are cut on main");
      git("switch", "-q", "main");
      writeFileSync(join(repo, "dirty"), "x");
      expect(release("minor").stderr).toContain("not clean");
      rmSync(join(repo, "dirty"));
      git("commit", "-q", "--allow-empty", "-m", "chore: local only");
      expect(release("minor").stderr).toContain("main is not origin/main");
    });

    it("refuses a gateway floor that is not a published release", () => {
      for (const draft of ["true", ""]) {
        env.RS_DRAFT = draft;
        const r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("the gateway floor, decdn v0.3.0");
      }
    });

    it("restores the files when a check fails", () => {
      writeFileSync(join(work, "fail"), "");
      const r = release("minor", "--execute");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("pnpm lint failed: nothing was committed");
      expect(git("status", "--porcelain")).toBe("");
      expect(version()).toBe("0.0.0");
      expect(git("tag")).toBe("");
    });
  },
);
