// Gates and runs of scripts/publish.sh. An npm version cannot be published
// twice, so what the script refuses must stop it before the upload.
//
// The gates run the real script with a PATH that holds no tool at all: a tag
// that is not `v<semver>` and a typo in a switch stop before the first tool
// check, and input it accepts gets as far as it.
//
// The runs take a signed tag in a fixture repo with a bare origin, signed by a
// throwaway OpenPGP key that the fixture's KEYS holds, with git, gpg, node and
// stubs that share a state directory:
// - `corepack` logs each `pnpm` call; `publish` without `--dry-run` puts the
//   version on the stub npm registry;
// - `npm` answers `view` from that registry, with E404 when it lacks the
//   version, or fails to reach it when $PS_NPM is `down`;
// - `gh` answers the repo's push permission with $PS_PUSH, `release view` from
//   the stub releases (a draft when $PS_GH is `draft`, a failure when it is
//   `down`), and `release create` records the release and its notes (or fails
//   when $PS_GH is `refuse`).
// Without gpg on PATH the runs skip, except under CI, where they fail.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

const COREPACK_STUB = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == pnpm ]] || exit 1
shift
echo "pnpm $*" >> "$PS_STATE/log"
if [[ "$1" == publish && " $* " != *" --dry-run "* ]]; then
  node -p 'require("./package.json").version' >> "$PS_STATE/npm"
fi
`;
const NPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  whoami) echo tester ;;
  view)
    [[ "\${PS_NPM:-}" != down ]] || { echo "npm error code ECONNREFUSED" >&2; exit 1; }
    version="\${2##*@}"
    if grep -qx "$version" "$PS_STATE/npm" 2>/dev/null; then
      [[ "$3" == dist.integrity ]] && echo "sha512-stub" || echo "$version"
    else
      echo "npm error code E404" >&2; exit 1
    fi ;;
  *) exit 1 ;;
esac
`;
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$PS_STATE/log"
case "$1 $2" in
  "api repos/decdn/sdk-typescript") echo "\${PS_PUSH:-true}" ;;
  "release view")
    [[ "\${PS_GH:-}" != down ]] || { echo "HTTP 502" >&2; exit 1; }
    [[ "\${PS_GH:-}" != draft ]] || { echo true; exit 0; }
    [[ -f "$PS_STATE/release-$3" ]] || { echo "release not found" >&2; exit 1; }
    cat "$PS_STATE/release-$3" ;;
  "release create")
    [[ "\${PS_GH:-}" != refuse ]] || { echo "HTTP 422" >&2; exit 1; }
    args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do
      [[ "\${args[i]}" == --notes-file ]] && cp "\${args[i + 1]}" "$PS_STATE/notes-$3"
    done
    echo false > "$PS_STATE/release-$3" ;;
  *) exit 1 ;;
esac
`;
const SECTION = `### Fixed

- **Aborts surface as aborts.** Aborting a \`get\` rejects with the
  signal's reason.`;
const CHANGELOG = `# Changelog

Intro.

## [0.2.0] — 2026-11-01

${SECTION}

## [0.1.0] — 2026-10-30

### Added

- **The client.**
`;
const footer = (version: string, install: string) =>
  `npm: [\`@decdn/client@${version}\`](https://www.npmjs.com/package/@decdn/client/v/${version}) (\`npm install ${install}\`). Browser pages and public gateways need \`decdn gateway\` [v0.3.0](https://github.com/decdn/decdn/releases/tag/v0.3.0) or later.\n`;
const NO_GPG = spawnSync("sh", ["-c", "command -v gpg"]).status !== 0;

describe.skipIf(NO_GPG && !process.env.CI)(
  "publish.sh from a fixture tag",
  () => {
    let gnupg: string, signer: string;
    let work: string, repo: string, state: string;
    let env: NodeJS.ProcessEnv;

    beforeAll(() => {
      expect(NO_GPG, "gpg is on PATH").toBe(false);
      gnupg = mkdtempSync(join(tmpdir(), "publish-gpg-"));
      const gpg = (...args: string[]) =>
        execFileSync("gpg", ["--homedir", gnupg, "--batch", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      const uid = "Publish Test <publish@example.org>";
      gpg("--passphrase", "", "--quick-gen-key", uid, "ed25519", "sign");
      const fpr = gpg("--with-colons", "--list-secret-keys", uid).match(
        /^fpr:+([0-9A-F]+):/m,
      )?.[1];
      if (!fpr) throw new Error(`gpg made no key for ${uid}`);
      signer = fpr;
      writeFileSync(join(gnupg, "KEYS"), gpg("--armor", "--export", signer));
    });
    afterAll(() => {
      spawnSync("gpgconf", ["--homedir", gnupg, "--kill", "all"]);
      rmSync(gnupg, { recursive: true, force: true });
    });

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    const publish = (tag: string, extra: Record<string, string> = {}) =>
      spawnSync(BASH, [SCRIPT, tag], {
        cwd: repo,
        env: { ...env, ...extra },
        encoding: "utf8",
      });
    const read = (name: string) =>
      readFileSync(join(state, name), { encoding: "utf8", flag: "a+" });
    const uploaded = () =>
      read("log")
        .split("\n")
        .filter((l) => l.startsWith("pnpm publish"));
    const created = () =>
      read("log")
        .split("\n")
        .filter((l) => l.startsWith("gh release create"));
    // <version>: package.json and CHANGELOG.md at <version>, committed,
    // tagged v<version> (signed) and pushed.
    function tag(version: string) {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          name: "@decdn/client",
          version,
          decdn: { gatewayFloor: "0.3.0" },
        }) + "\n",
      );
      writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
      git("add", "-A");
      git("commit", "-qm", `chore(release): v${version}`);
      git("tag", "-s", `v${version}`, "-m", `@decdn/client ${version}`);
      git("push", "-q", "origin", "main", `v${version}`);
    }

    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "publish-fixture-"));
      repo = join(work, "repo");
      state = join(work, "state");
      const origin = join(work, "origin.git");
      const bin = join(work, "bin");
      mkdirSync(state);
      mkdirSync(bin);
      for (const [name, body] of Object.entries({
        corepack: COREPACK_STUB,
        npm: NPM_STUB,
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
        PS_STATE: state,
      };
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
        env,
      });
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
      for (const [k, v] of Object.entries({
        "user.name": "Publish Test",
        "user.email": "publish@example.org",
        "user.signingkey": signer,
      })) {
        git("config", k, v);
      }
      writeFileSync(join(repo, "KEYS"), readFileSync(join(gnupg, "KEYS")));
      git("add", "-A");
      git("commit", "-qm", "chore: the fixture");
      git("remote", "add", "origin", origin);
      git("push", "-q", "-u", "origin", "main");
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    it("uploads a release, then makes its GitHub release", () => {
      tag("0.2.0");
      const r = publish("v0.2.0");
      expect(r.status, r.stderr).toBe(0);
      expect(uploaded()).toEqual([
        "pnpm publish --access public --no-git-checks --tag latest",
      ]);
      const [create] = created();
      expect(create).toMatch(
        /^gh release create v0\.2\.0 --repo decdn\/sdk-typescript --verify-tag --title v0\.2\.0 --notes-file \S+$/,
      );
      expect(read("notes-v0.2.0")).toBe(
        `${SECTION}\n\n---\n\n${footer("0.2.0", "@decdn/client")}`,
      );
      expect(read("log").indexOf("pnpm publish")).toBeLessThan(
        read("log").indexOf("gh release create"),
      );
    });

    it("makes a prerelease's release a prerelease, its notes the footer", () => {
      tag("0.3.0-rc.1");
      const r = publish("v0.3.0-rc.1");
      expect(r.status, r.stderr).toBe(0);
      expect(uploaded()).toEqual([
        "pnpm publish --access public --no-git-checks --tag next",
      ]);
      expect(created()[0]).toMatch(/ --prerelease --latest=false$/);
      expect(read("notes-v0.3.0-rc.1")).toBe(
        footer("0.3.0-rc.1", "@decdn/client@next"),
      );
    });

    it("finishes a run whose GitHub release failed", () => {
      tag("0.2.0");
      const failed = publish("v0.2.0", { PS_GH: "refuse" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "npm has @decdn/client@0.2.0, but the GitHub release failed",
      );
      expect(uploaded()).toHaveLength(1);
      expect(existsSync(join(state, "release-v0.2.0"))).toBe(false);

      const r = publish("v0.2.0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        "@decdn/client@0.2.0 is already on npm; not publishing it again",
      );
      expect(r.stdout).toContain("sha512-stub");
      expect(uploaded()).toHaveLength(1);
      expect(read("release-v0.2.0")).toBe("false\n");
    });

    it("leaves an existing release as it is", () => {
      tag("0.2.0");
      writeFileSync(join(state, "npm"), "0.2.0\n");
      writeFileSync(join(state, "release-v0.2.0"), "false\n");
      const r = publish("v0.2.0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("already has the release v0.2.0; left as is");
      expect(uploaded()).toEqual([]);
      expect(created()).toEqual([]);
    });

    it("dry-runs without uploading or releasing, printing the notes", () => {
      tag("0.2.0");
      const r = publish("v0.2.0", { DECDN_NPM_DRY_RUN: "1" });
      expect(r.status, r.stderr).toBe(0);
      expect(uploaded()).toEqual([
        "pnpm publish --access public --no-git-checks --tag latest --dry-run",
      ]);
      expect(created()).toEqual([]);
      expect(r.stdout).toContain(
        "The GitHub release would be: gh release create v0.2.0",
      );
      expect(r.stdout).toContain(footer("0.2.0", "@decdn/client"));
      expect(read("npm")).toBe("");
    });

    it.each([
      [
        "a draft release for the tag",
        { PS_GH: "draft" },
        "has a draft release for v0.2.0",
      ],
      [
        "an npm it cannot ask",
        { PS_NPM: "down" },
        "cannot ask npm whether it has @decdn/client@0.2.0",
      ],
      [
        "a GitHub it cannot ask",
        { PS_GH: "down" },
        "cannot ask GitHub whether decdn/sdk-typescript has the release v0.2.0",
      ],
      [
        "an account without write access",
        { PS_PUSH: "false" },
        "gh's account has no write access to decdn/sdk-typescript",
      ],
    ])("stops on %s before the upload", (_, extra, message) => {
      tag("0.2.0");
      const r = publish("v0.2.0", extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(uploaded()).toEqual([]);
      expect(created()).toEqual([]);
    });

    it("stops on a release without a changelog section before the build", () => {
      tag("0.4.0");
      const r = publish("v0.4.0");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "CHANGELOG.md at v0.4.0 has no '## [0.4.0]' section",
      );
      expect(read("log")).not.toContain("pnpm");
    });
  },
);
