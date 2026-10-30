// Gates and runs of scripts/release.sh. The argument gates run the real script
// with a PATH that holds no tool at all. The rest run it in a fixture repo with
// a bare origin, the real cliff.toml, git, git-cliff and gpg, and stubs:
// - `pnpm` logs each call; `exec prettier` passes the file through, `version`
//   sets package.json's version, and any other subcommand (a check) fails
//   when it is named in $RS_FAIL;
// - `scripts/check-package.sh` logs itself and fails the same way;
// - `gh` answers the gateway floor's release as $RS_GH says.
// The host's git config is kept out. Commits and tags are signed with a
// throwaway OpenPGP key that the fixture's KEYS holds; a second key it does
// not hold signs as a stranger. Without git-cliff or gpg on PATH the fixture
// runs skip, except under CI, which installs git-cliff, where they fail.
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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release.sh");
const FIRST_TOOL_CHECK = "git not found on PATH";
// Resolved before the gate runs empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();
const has = (tool: string) =>
  spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const today = () => new Date().toISOString().slice(0, 10);

describe("release.sh arguments", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "release-gates-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function gate(...args: string[]) {
    return spawnSync(BASH, [SCRIPT, ...args], {
      cwd: home,
      env: { HOME: home, PATH: join(home, "no-tools") },
      encoding: "utf8",
    });
  }

  it.each([
    ["1.2"],
    ["v1.2.3"],
    ["1.2.3-rc.1"],
    ["next"],
    ["minor", "patch"],
    ["--force"],
  ])("stops on %j before any tool runs", (...args) => {
    const r = gate(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stderr).not.toContain(FIRST_TOOL_CHECK);
  });

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
  version) node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8")); p.version = process.argv[1]; if (process.env.RS_PNPM_EXTRA) p.extra = true; fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\\n")' "$2" ;;
  build) [[ -z "\${RS_DIRTY:-}" ]] || echo "# dirty" >> cliff.toml ;&
  *) [[ " \${RS_FAIL:-} " != *" $1 "* ]] ;;
esac
`;
const CHECK_PACKAGE_STUB = `#!/usr/bin/env bash
echo check-package >> "$RS_LOG"
[[ " \${RS_FAIL:-} " != *" check-package "* ]]
`;
const GH_STUB = `#!/usr/bin/env bash
[[ "$*" == *releases/tags/v0.3.0* ]] || exit 1
case "\${RS_GH:-false}" in
  404) echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  401) echo '{"message":"Bad credentials","status":"401"}'; echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
  *) echo "\${RS_GH:-false}" ;;
esac
`;
// Shaped like CHANGELOG.md before its first release: an intro, then a
// hand-written [Unreleased] section with wrapped entries. Not the file itself,
// which loses its [Unreleased] section at the first release.
const CHANGELOG = `# Changelog

All notable changes to \`@decdn/client\` are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The client.** A pure-TypeScript package that speaks HTTP to a gateway
  and hashes what it fetches.

### Fixed

- **Aborts surface as aborts.** Aborting a \`get\` rejects with the
  signal's reason.
`;
const MISSING = ["git-cliff", "gpg"].filter((t) => !has(t));

describe.skipIf(MISSING.length > 0 && !process.env.CI)(
  "release.sh in a fixture repo",
  () => {
    let gnupg: string, signer: string, stranger: string;
    let work: string, repo: string, origin: string, log: string;
    let env: NodeJS.ProcessEnv;

    beforeAll(() => {
      expect(MISSING, "git-cliff and gpg are on PATH").toEqual([]);
      gnupg = mkdtempSync(join(tmpdir(), "release-gpg-"));
      const gpg = (...args: string[]) =>
        execFileSync("gpg", ["--homedir", gnupg, "--batch", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      const key = (uid: string) => {
        gpg("--passphrase", "", "--quick-gen-key", uid, "ed25519", "sign");
        const fpr = gpg("--with-colons", "--list-secret-keys", uid).match(
          /^fpr:+([0-9A-F]+):/m,
        )?.[1];
        if (!fpr) throw new Error(`gpg made no key for ${uid}`);
        return fpr;
      };
      signer = key("Release Test <release@example.org>");
      stranger = key("Stranger <stranger@example.org>");
      writeFileSync(join(gnupg, "KEYS"), gpg("--armor", "--export", signer));
    });
    afterAll(() => {
      spawnSync("gpgconf", ["--homedir", gnupg, "--kill", "all"]);
      rmSync(gnupg, { recursive: true, force: true });
    });

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    const originGit = (...args: string[]) =>
      execFileSync("git", ["--git-dir", origin, ...args], {
        env,
        encoding: "utf8",
      });
    const release = (...args: string[]) =>
      spawnSync(join(repo, "scripts/release.sh"), args, {
        cwd: repo,
        env,
        encoding: "utf8",
      });
    // <path> <message>: change <path>, commit and push.
    function commit(path: string, message: string) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), `${Math.random()}\n`, { flag: "a" });
      git("add", "-A");
      git("commit", "-qm", message);
      git("push", "-q", "origin", "main");
    }
    // <path> <content>: replace <path>, commit and push.
    function replace(path: string, content: string) {
      writeFileSync(join(repo, path), content);
      git("commit", "-qam", `chore: rewrite ${path}`);
      git("push", "-q", "origin", "main");
    }
    const file = (path: string) => readFileSync(join(repo, path), "utf8");
    const version = () => JSON.parse(file("package.json")).version;
    const calls = () => readFileSync(log, { encoding: "utf8", flag: "a+" });
    const pkg = (version: string) =>
      JSON.stringify(
        { name: "@decdn/client", version, decdn: { gatewayFloor: "0.3.0" } },
        null,
        2,
      ) + "\n";
    // The first release, executed: tags v0.1.0 on origin.
    function first() {
      const r = release("minor", "--execute", "--no-verify");
      expect(r.status, r.stderr).toBe(0);
    }
    // Nothing committed or pushed, and the tree as it was.
    function untouched(head: string) {
      expect(git("rev-parse", "HEAD").trim()).toBe(head);
      expect(git("status", "--porcelain")).toBe("");
      expect(originGit("rev-parse", "main").trim()).toBe(head);
    }

    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "release-fixture-"));
      repo = join(work, "repo");
      origin = join(work, "origin.git");
      log = join(work, "log");
      const bin = join(work, "bin");
      mkdirSync(bin);
      for (const [name, body] of Object.entries({
        pnpm: PNPM_STUB,
        gh: GH_STUB,
      })) {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
      }
      env = {
        HOME: work,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GNUPGHOME: gnupg,
        RS_LOG: log,
      };
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
        env,
      });
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
      for (const [k, v] of Object.entries({
        "user.name": "Release Test",
        "user.email": "release@example.org",
        "user.signingkey": signer,
        "commit.gpgsign": "false",
      })) {
        git("config", k, v);
      }
      mkdirSync(join(repo, "scripts"));
      copyFileSync(SCRIPT, join(repo, "scripts/release.sh"));
      writeFileSync(join(repo, "scripts/check-package.sh"), CHECK_PACKAGE_STUB);
      chmodSync(join(repo, "scripts/check-package.sh"), 0o755);
      copyFileSync(join(ROOT, "cliff.toml"), join(repo, "cliff.toml"));
      copyFileSync(join(gnupg, "KEYS"), join(repo, "KEYS"));
      writeFileSync(join(repo, "package.json"), pkg("0.0.0"));
      writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
      git("add", "-A");
      git("commit", "-qm", "chore: the fixture");
      git("remote", "add", "origin", origin);
      git("push", "-q", "-u", "origin", "main");
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    describe("the first release", () => {
      it("dry-runs without changing a file", () => {
        const head = git("rev-parse", "HEAD").trim();
        const r = release("minor");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("release @decdn/client: v0.1.0");
        expect(r.stdout).toContain(`+## [0.1.0] — ${today()}`);
        expect(r.stdout).toContain('+  "version": "0.1.0",');
        expect(r.stdout).toContain("dry run: no file changed");
        untouched(head);
        expect(git("tag")).toBe("");
        expect(calls()).not.toMatch(/^version /m);
      });

      it("names its level", () => {
        const r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("the first release names its level");
      });

      it("releases [Unreleased] as it is, signed and pushed", () => {
        const r = release("minor", "--execute");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("scripts/publish.sh v0.1.0");
        expect(version()).toBe("0.1.0");
        expect(file("CHANGELOG.md")).toBe(
          CHANGELOG.replace(
            "\n## [Unreleased]\n",
            `\n## [0.1.0] — ${today()}\n`,
          ),
        );
        expect(git("status", "--porcelain")).toBe("");
        expect(git("log", "-1", "--format=%s")).toBe(
          "chore(release): v0.1.0\n",
        );
        expect(git("show", "--name-only", "--format=", "HEAD")).toBe(
          "CHANGELOG.md\npackage.json\n",
        );
        for (const [verify, ref] of Object.entries({
          "verify-commit": "HEAD",
          "verify-tag": "v0.1.0",
        })) {
          const v = spawnSync("git", ["-C", repo, verify, "--raw", ref], {
            env,
            encoding: "utf8",
          });
          expect(v.status, v.stderr).toBe(0);
          expect(v.stderr).toContain(`VALIDSIG ${signer}`);
        }
        expect(git("cat-file", "-p", "v0.1.0")).toContain(
          "@decdn/client 0.1.0",
        );
        const head = git("rev-parse", "HEAD").trim();
        expect(originGit("rev-parse", "main", "v0.1.0^{commit}")).toBe(
          `${head}\n${head}\n`,
        );
        expect(originGit("tag")).toBe("v0.1.0\n");
        expect(calls()).toContain(
          "version 0.1.0 --no-git-tag-version\nlint\ntest\nbuild\ncheck-package\n",
        );
      });

      it.each([
        [
          "a manifest past the placeholder",
          () => replace("package.json", pkg("0.3.0")),
          "not the 0.0.0 placeholder",
        ],
        [
          "a prerelease manifest",
          () => replace("package.json", pkg("0.2.0-rc.1")),
          "after a prerelease, version goes back to the last release",
        ],
        [
          "no [Unreleased] section",
          () =>
            replace(
              "CHANGELOG.md",
              CHANGELOG.replace("## [Unreleased]", "## Next"),
            ),
          "has no '## [Unreleased]' section",
        ],
        [
          "an empty [Unreleased] section",
          () => replace("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n"),
          "the [Unreleased] section has no '- ' entries",
        ],
        [
          "a link definition",
          () =>
            replace(
              "CHANGELOG.md",
              `${CHANGELOG}\n[Unreleased]: https://example.org/compare\n`,
            ),
          "has link definitions",
        ],
      ])("refuses %s", (_, setup, message) => {
        setup();
        const r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(message);
      });
    });

    describe("a later release", () => {
      beforeEach(first);

      it("generates its section and pushes it", () => {
        commit("src/a.ts", "fix(site): keep the query (#3)");
        commit("src/b.ts", "feat: open a bundle (#4)");
        commit("test/a.ts", "test: cover it (#5)");
        commit(".github/ci.yml", "ci: pin an action (#6)");
        const r = release("--execute", "--no-verify");
        expect(r.status, r.stderr).toBe(0);
        expect(version()).toBe("0.2.0");
        const changelog = file("CHANGELOG.md");
        expect(changelog).toContain(
          `and the package follows [Semantic Versioning](https://semver.org/).\n\n## [0.2.0] — ${today()}\n\n### Added\n\n- Open a bundle (#4)\n\n### Fixed\n\n- **site**: Keep the query (#3)\n\n## [0.1.0]`,
        );
        expect(changelog).not.toMatch(/Cover it|Pin an action/);
        const head = git("rev-parse", "HEAD").trim();
        expect(originGit("rev-parse", "main", "v0.2.0^{commit}")).toBe(
          `${head}\n${head}\n`,
        );
        expect(git("status", "--porcelain")).toBe("");
      });

      it("renders every type under a Keep a Changelog kind", () => {
        for (const message of [
          "perf: faster hashing",
          "docs: document open",
          "refactor: split http",
          "revert: drop the retry",
          "security: check the origin",
          "style: format",
          "chore(deps): bump noble",
          "chore(release): v9.9.9",
          "ci!: drop node 18",
          "Feat: a capitalised type",
          "deps: an unlisted type",
          "build: a build change",
        ]) {
          commit("src/a.ts", message);
        }
        const r = release();
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("v0.1.0 -> v0.2.0");
        const section = r.stdout
          .split("\n")
          .filter((l) => /^\+(###|- )/.test(l))
          .join("\n");
        expect(section).toBe(
          [
            "+### Added",
            "+- A capitalised type",
            "+### Changed",
            "+- An unlisted type",
            "+- **Breaking:** Drop node 18",
            "+- **deps**: Bump noble",
            "+- Split http",
            "+- Document open",
            "+- Faster hashing",
            "+### Removed",
            "+- Drop the retry",
            "+### Security",
            "+- Check the origin",
          ].join("\n"),
        );
      });

      it("refuses a heading that is not a Keep a Changelog kind", () => {
        replace(
          "cliff.toml",
          file("cliff.toml").replace(/^ {2}\{ message = "\.\*".*\n/m, ""),
        );
        commit("src/a.ts", "deps: an unlisted type");
        const r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("not a Keep a Changelog kind");
      });

      it.each([
        ["a fix", ["fix: a fix"], "v0.1.1"],
        ["a feature", ["fix: a fix", "feat: a feature"], "v0.2.0"],
        ["a breaking change", ["refactor!: drop X"], "v0.2.0"],
        [
          "a breaking footer",
          ["fix: a fix\n\nBREAKING CHANGE: it breaks"],
          "v0.2.0",
        ],
      ])("bumps on %s to %s", (_, messages, tag) => {
        for (const m of messages) commit("src/a.ts", m);
        const r = release();
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain(`v0.1.0 -> ${tag}`);
      });

      it("marks a breaking change", () => {
        commit("src/a.ts", "refactor!: drop X");
        expect(release().stdout).toContain("+- **Breaking:** Drop X");
      });

      it.each([
        ["minor", "v0.2.0"],
        ["major", "v1.0.0"],
        ["0.4.0", "v0.4.0"],
      ])("takes the level %s", (level, tag) => {
        commit("src/a.ts", "fix: a fix");
        const r = release(level);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain(`v0.1.0 -> ${tag}`);
      });

      it.each(["0.0.5", "0.1.0"])(
        "refuses the version %s, not above the last",
        (level) => {
          commit("src/a.ts", "feat: a feature");
          const r = release(level);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain(
            `${level} is not above the last release, 0.1.0`,
          );
        },
      );

      it("refuses when nothing makes a changelog entry", () => {
        commit("test/a.ts", "test: more tests");
        commit(".github/ci.yml", "ci: a job");
        const r = release("patch");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("nothing to release");
      });

      it("refuses unconventional commits unless allowed", () => {
        commit("src/a.ts", "Update the client");
        commit("src/b.ts", "feat(): an empty scope");
        commit("src/c.ts", "fix(x): a glued body\nright under the subject");
        commit("src/d.ts", "fix: a fix");
        let r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("cannot parse these commits");
        for (const subject of [
          " Update the client",
          " feat(): an empty scope",
          " fix(x): a glued body",
        ]) {
          expect(r.stderr).toContain(subject);
        }
        r = release("--allow-unconventional");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toContain(" Update the client");
        expect(r.stdout).toContain("v0.1.0 -> v0.1.1");
        expect(r.stdout).not.toMatch(
          /^\+- .*(Update the client|An empty scope|A glued body)/m,
        );
      });

      it("refuses an [Unreleased] section", () => {
        commit("src/a.ts", "fix: a fix");
        replace(
          "CHANGELOG.md",
          file("CHANGELOG.md").replace(
            "## [0.1.0]",
            "## [Unreleased]\n\n- a hand edit\n\n## [0.1.0]",
          ),
        );
        const r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("has an [Unreleased] section");
      });

      it("refuses a manifest that is not the last release", () => {
        replace("package.json", pkg("0.5.0"));
        commit("src/a.ts", "fix: a fix");
        const r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("fix the manifest first");
      });

      it("refuses a local tag above origin's", () => {
        commit("src/a.ts", "fix: a fix");
        git("tag", "v0.9.0");
        const r = release();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          "the highest local tag, v0.9.0, is not origin's (v0.1.0)",
        );
      });

      it("pushes all or nothing, and its undo works", () => {
        commit("src/a.ts", "fix: a fix");
        const before = originGit("rev-parse", "main").trim();
        const hook = join(origin, "hooks/update");
        writeFileSync(
          hook,
          '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\n',
        );
        chmodSync(hook, 0o755);
        let r = release("--execute", "--no-verify");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("nothing reached origin");
        expect(originGit("rev-parse", "main").trim()).toBe(before);
        expect(originGit("tag")).toBe("v0.1.0\n");
        expect(git("log", "-1", "--format=%s")).toBe(
          "chore(release): v0.1.1\n",
        );
        expect(release().stderr).toContain("main is not origin/main");
        rmSync(hook);
        git("tag", "-d", "v0.1.1");
        git("reset", "-q", "--hard", "origin/main");
        r = release("--execute", "--no-verify");
        expect(r.status, r.stderr).toBe(0);
        expect(originGit("tag")).toBe("v0.1.0\nv0.1.1\n");
      });
    });

    describe("refusals", () => {
      it("refuses another branch and a detached HEAD", () => {
        git("switch", "-qc", "topic");
        let r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("releases are cut on main, not 'topic'");
        git("switch", "-q", "--detach", "main");
        r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("not 'a detached HEAD'");
      });

      it("refuses a dirty tree and keeps the edit", () => {
        writeFileSync(join(repo, "CHANGELOG.md"), "# my edit\n", {
          flag: "a",
        });
        const r = release("minor", "--execute");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("the working tree is not clean");
        expect(file("CHANGELOG.md")).toBe(`${CHANGELOG}# my edit\n`);
      });

      it("refuses a main ahead of or behind origin", () => {
        git("commit", "-q", "--allow-empty", "-m", "chore: local only");
        let r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("main is not origin/main");
        git("push", "-q", "origin", "main");
        git("reset", "-q", "--hard", "HEAD~1");
        r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("main is not origin/main");
      });

      it.each([
        ["404", "decdn v0.3.0, has no published release"],
        ["401", "is gh logged in?"],
        ["true", "decdn v0.3.0, is a draft release"],
      ])("refuses the gateway floor when gh answers %s", (answer, message) => {
        env.RS_GH = answer;
        const r = release("minor");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(message);
        if (answer === "401") expect(r.stderr).toContain("Bad credentials");
      });

      it.each([
        [
          "no signing key",
          () => git("config", "--unset", "user.signingkey"),
          "git has no user.signingkey",
        ],
        [
          "an ssh signing format",
          () => git("config", "gpg.format", "ssh"),
          "gpg.format is ssh",
        ],
        [
          "a key KEYS does not hold",
          () => git("config", "user.signingkey", stranger),
          "signs with a key that is not in KEYS",
        ],
      ])("refuses %s before anything runs", (_, setup, message) => {
        setup();
        const head = git("rev-parse", "HEAD").trim();
        const r = release("minor", "--execute");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(message);
        expect(calls()).toBe("");
        untouched(head);
        expect(git("tag")).toBe("");
      });
    });

    describe("restores the files", () => {
      // A failed --execute leaves the tree as it was, and commits, tags and
      // pushes nothing.
      it.each([
        ["lint fails", { RS_FAIL: "lint" }, "pnpm lint failed"],
        [
          "check-package fails",
          { RS_FAIL: "check-package" },
          "scripts/check-package.sh failed",
        ],
        [
          "a check leaves other changes",
          { RS_DIRTY: "1" },
          "the checks left changes besides package.json CHANGELOG.md",
        ],
        [
          "pnpm version writes another package.json",
          { RS_PNPM_EXTRA: "1" },
          "pnpm version wrote a package.json other than the one shown",
        ],
      ])("when %s", (_, extra: Record<string, string>, message) => {
        Object.assign(env, extra);
        const head = git("rev-parse", "HEAD").trim();
        const r = release("minor", "--execute");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`${message}: nothing was committed`);
        // The stray change the check made is the test's to drop.
        git("checkout", "-q", "--", "cliff.toml");
        untouched(head);
        expect(version()).toBe("0.0.0");
        expect(git("tag")).toBe("");
        if (extra.RS_FAIL === "lint") {
          expect(calls()).not.toMatch(/^(test|build)$/m);
        }
      });

      it("when a commit hook fails", () => {
        const hook = join(repo, ".git/hooks/pre-commit");
        writeFileSync(hook, "#!/bin/sh\nexit 1\n");
        chmodSync(hook, 0o755);
        const head = git("rev-parse", "HEAD").trim();
        const r = release("minor", "--execute", "--no-verify");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("git commit failed");
        untouched(head);
        expect(version()).toBe("0.0.0");
        expect(git("tag")).toBe("");
      });
    });
  },
);
