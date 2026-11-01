// The steps of the Publish workflow, scripts/publish.sh. An npm version cannot
// be published twice, so what the script refuses must stop it before the
// upload.
//
// The gates run the real script with a PATH that holds no tool at all: a tag
// that is not `v<semver>` stops before the first tool check, and input it
// accepts gets as far as it.
//
// `npm` and `github` run against stubs that share a state directory:
// - `npm` answers `view` from a stub registry: the version and the integrity
//   in $PS_STATE/integrity when it has the version, E404 when it lacks it;
//   with $PS_NPM `down` it fails to reach the registry, with `empty` it
//   answers nothing (as npm before 11 does for a missing version), and with
//   `odd` another version. A dist-tag comes from $PS_STATE/dist-tag-<tag>
//   (none when the file is missing); with $PS_NPM_TAGS `down` npm cannot be
//   asked for it, and with `missing` the package is not on npm. `publish`
//   logs its arguments and, without `--dry-run`, puts the version on the
//   registry;
// - `gh` answers `release view` from the stub releases (a draft when $PS_GH is
//   `draft`, a failure when it is `down`), and `release create` records the
//   release and its notes.
//
// `verify` and `notes` take a signed tag in a fixture repo with a bare origin,
// signed by throwaway OpenPGP keys. Without gpg on PATH those runs skip,
// except under CI, where they fail.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
// Resolved before the gates empty PATH.
const BASH = execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();

describe("publish.sh gates", () => {
  function run(...args: string[]) {
    const home = mkdtempSync(join(tmpdir(), "publish-gates-"));
    try {
      return spawnSync(BASH, [SCRIPT, ...args], {
        cwd: home,
        env: { HOME: home, PATH: join(home, "no-tools") },
        encoding: "utf8",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it.each([
    "sdk-v0.1.0",
    "0.1.0",
    "v0.1",
    "v01.0.0",
    "v0.1.0+build",
    "v0.1.0-",
    "x",
  ])("stops on the tag %s before any tool runs", (tag) => {
    const r = run("verify", tag);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the tag must be v<major>.<minor>.<patch>");
    expect(r.stderr).not.toContain("not found on PATH");
  });

  it.each(["v0.1.0", "v1.20.3", "v0.2.0-rc.1"])(
    "takes the tag %s to the tool checks",
    (tag) => {
      const r = run("verify", tag);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("git not found on PATH");
    },
  );

  it.each([
    ["no tag", ["verify"]],
    ["an unknown step", ["upload", "v0.1.0"]],
    ["verify with an extra argument", ["verify", "v0.1.0", "x"]],
    ["npm without a tarball", ["npm", "v0.1.0"]],
    ["npm with an unknown flag", ["npm", "v0.1.0", "x.tgz", "--force"]],
    ["github without notes", ["github", "v0.1.0"]],
  ])("prints the usage on %s", (_, args) => {
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});

const NPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  view)
    case "\${PS_NPM:-}" in
      down) echo "npm error code ECONNREFUSED" >&2; exit 1 ;;
      empty) exit 0 ;;
      odd) echo "0.1.9"; exit 0 ;;
    esac
    if [[ "$3" == dist-tags.* ]]; then
      case "\${PS_NPM_TAGS:-}" in
        down) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;
        missing) echo "npm error code E404" >&2; exit 1 ;;
      esac
      f="$PS_STATE/dist-tag-\${3#dist-tags.}"
      [[ ! -f "$f" ]] || cat "$f"
      exit 0
    fi
    version="\${2##*@}"
    if grep -qx "$version" "$PS_STATE/npm" 2>/dev/null; then
      [[ "$3" == dist.integrity ]] && cat "$PS_STATE/integrity" || echo "$version"
    else
      echo "npm error code E404" >&2; exit 1
    fi ;;
  publish)
    echo "npm $*" >> "$PS_STATE/log"
    if [[ " $* " != *" --dry-run "* ]]; then
      tar -xzOf "$2" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' >> "$PS_STATE/npm"
    fi ;;
  *) exit 1 ;;
esac
`;
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$PS_STATE/log"
case "$1 $2" in
  "release view")
    [[ "\${PS_GH:-}" != down ]] || { echo "HTTP 502" >&2; exit 1; }
    [[ "\${PS_GH:-}" != draft ]] || { echo true; exit 0; }
    [[ -f "$PS_STATE/release-$3" ]] || { echo "release not found" >&2; exit 1; }
    cat "$PS_STATE/release-$3" ;;
  "release create")
    args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do
      [[ "\${args[i]}" == --notes-file ]] && cp "\${args[i + 1]}" "$PS_STATE/notes-$3"
    done
    echo false > "$PS_STATE/release-$3" ;;
  *) exit 1 ;;
esac
`;

describe("publish.sh npm and github", () => {
  let work: string, state: string, env: NodeJS.ProcessEnv;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "publish-stubs-"));
    state = join(work, "state");
    const bin = join(work, "bin");
    mkdirSync(state);
    mkdirSync(bin);
    for (const [name, body] of Object.entries({ npm: NPM_STUB, gh: GH_STUB })) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    env = {
      HOME: work,
      PATH: `${bin}:${process.env.PATH}`,
      PS_STATE: state,
    };
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const step = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(BASH, [SCRIPT, ...args], {
      cwd: work,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const read = (name: string) =>
    readFileSync(join(state, name), { encoding: "utf8", flag: "a+" });
  const logged = (prefix: string) =>
    read("log")
      .split("\n")
      .filter((l) => l.startsWith(prefix));
  // <name>@<version>, packed as npm packs it: package/package.json.
  function tarball(version: string, name = "@decdn/client") {
    const dir = join(work, `pack-${version}`);
    mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(
      join(dir, "package", "package.json"),
      JSON.stringify({ name, version }),
    );
    const file = join(work, `decdn-client-${version}.tgz`);
    execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
    return file;
  }
  function notes(text = "The notes.\n") {
    const file = join(work, "notes.md");
    writeFileSync(file, text);
    return file;
  }

  describe("npm", () => {
    it("uploads a release under latest, running none of its scripts", () => {
      const tgz = tarball("0.2.0");
      const r = step(["npm", "v0.2.0", tgz]);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("npm publish")).toEqual([
        `npm publish ${tgz} --access public --tag latest --ignore-scripts`,
      ]);
      expect(read("npm")).toBe("0.2.0\n");
    });

    it("uploads a prerelease under next", () => {
      const tgz = tarball("0.3.0-rc.1");
      const r = step(["npm", "v0.3.0-rc.1", tgz]);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("npm publish")).toEqual([
        `npm publish ${tgz} --access public --tag next --ignore-scripts`,
      ]);
    });

    it("dry-runs without uploading", () => {
      const tgz = tarball("0.2.0");
      const r = step(["npm", "v0.2.0", tgz, "--dry-run"]);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("npm publish")).toEqual([
        `npm publish ${tgz} --access public --tag latest --ignore-scripts --dry-run`,
      ]);
      expect(read("npm")).toBe("");
    });

    // npm has 0.2.0, uploaded from <tgz>.
    function onNpm(tgz: string) {
      writeFileSync(join(state, "npm"), "0.2.0\n");
      const digest = createHash("sha512").update(readFileSync(tgz));
      writeFileSync(
        join(state, "integrity"),
        `sha512-${digest.digest("base64")}\n`,
      );
    }

    it.each([[[]], [["--dry-run"]]])(
      "skips a version npm has as this tarball (%j)",
      (flags) => {
        const tgz = tarball("0.2.0");
        onNpm(tgz);
        const r = step(["npm", "v0.2.0", tgz, ...flags]);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain(
          "@decdn/client@0.2.0 is already on npm, as this tarball",
        );
        expect(logged("npm publish")).toEqual([]);
      },
    );

    it("stops on a version npm has from another tarball", () => {
      onNpm(tarball("0.2.0"));
      const other = join(work, "other.tgz");
      execFileSync("tar", [
        "-czf",
        other,
        "-C",
        join(work, "pack-0.2.0"),
        "--mtime=2000-01-01",
        "package",
      ]);
      const r = step(["npm", "v0.2.0", other]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "npm has @decdn/client@0.2.0, but not this tarball",
      );
      expect(logged("npm publish")).toEqual([]);
    });

    it("uploads when npm answers nothing for the version", () => {
      const r = step(["npm", "v0.2.0", tarball("0.2.0")], { PS_NPM: "empty" });
      expect(r.status, r.stderr).toBe(0);
      expect(logged("npm publish")).toHaveLength(1);
    });

    it.each([
      ["latest", "0.2.0", "0.3.0"],
      ["next", "0.3.0-rc.1", "0.3.0-rc.2"],
    ])(
      "stops before moving %s back to a lower version",
      (distTag, version, current) => {
        writeFileSync(join(state, `dist-tag-${distTag}`), `${current}\n`);
        const tgz = tarball(version);
        for (const flags of [[], ["--dry-run"]]) {
          const r = step(["npm", `v${version}`, tgz, ...flags]);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain(
            `npm's ${distTag} is ${current}, above ${version}: publishing would move ${distTag} back`,
          );
        }
        expect(logged("npm publish")).toEqual([]);
      },
    );

    it.each([
      ["below it", { latest: "0.1.1" }, {}],
      ["below it, as a prerelease", { latest: "0.2.0-rc.3" }, {}],
      ["unset", {}, {}],
      ["absent with the package", {}, { PS_NPM_TAGS: "missing" }],
    ])("uploads when the dist-tag is %s", (_, tags, extra) => {
      for (const [t, v] of Object.entries(tags)) {
        writeFileSync(join(state, `dist-tag-${t}`), `${v}\n`);
      }
      const r = step(["npm", "v0.2.0", tarball("0.2.0")], extra);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("npm publish")).toHaveLength(1);
    });

    it.each([
      [
        "a tarball of another version",
        () => tarball("0.1.9"),
        {},
        "holds @decdn/client@0.1.9, not @decdn/client@0.2.0",
      ],
      [
        "a tarball of another package",
        () => tarball("0.2.0", "decdn-client"),
        {},
        "holds decdn-client@0.2.0, not @decdn/client@0.2.0",
      ],
      [
        "an npm it cannot ask",
        () => tarball("0.2.0"),
        { PS_NPM: "down" },
        "cannot ask npm whether it has @decdn/client@0.2.0",
      ],
      [
        "an npm that answers another version",
        () => tarball("0.2.0"),
        { PS_NPM: "odd" },
        "npm answered '0.1.9' when asked for @decdn/client@0.2.0",
      ],
      [
        "an npm it cannot ask for the dist-tag",
        () => tarball("0.2.0"),
        { PS_NPM_TAGS: "down" },
        "cannot ask npm for @decdn/client's latest dist-tag",
      ],
    ])("stops on %s before the upload", (_, make, extra, message) => {
      const r = step(["npm", "v0.2.0", make()], extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(logged("npm publish")).toEqual([]);
    });

    it("stops without a tarball", () => {
      const r = step(["npm", "v0.2.0", join(work, "none.tgz")]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no tarball at");
    });
  });

  describe("github", () => {
    it("makes the release with the notes", () => {
      const r = step(["github", "v0.2.0", notes()]);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("gh release create")).toEqual([
        `gh release create v0.2.0 --repo decdn/sdk-typescript --verify-tag --title v0.2.0 --notes-file ${join(work, "notes.md")}`,
      ]);
      expect(read("notes-v0.2.0")).toBe("The notes.\n");
    });

    it("makes a prerelease's release a prerelease, never the latest", () => {
      const r = step(["github", "v0.3.0-rc.1", notes()]);
      expect(r.status, r.stderr).toBe(0);
      expect(logged("gh release create")[0]).toMatch(
        / --prerelease --latest=false$/,
      );
    });

    it("leaves an existing release as it is", () => {
      writeFileSync(join(state, "release-v0.2.0"), "false\n");
      const r = step(["github", "v0.2.0", notes()]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("already has the release v0.2.0; left as is");
      expect(logged("gh release create")).toEqual([]);
    });

    it.each([
      ["a draft release for the tag", { PS_GH: "draft" }, "has a draft"],
      [
        "a GitHub it cannot ask",
        { PS_GH: "down" },
        "cannot ask GitHub whether decdn/sdk-typescript has the release v0.2.0",
      ],
    ])("stops on %s", (_, extra, message) => {
      const r = step(["github", "v0.2.0", notes()], extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(logged("gh release create")).toEqual([]);
    });

    it("stops on empty notes", () => {
      const r = step(["github", "v0.2.0", notes("")]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no release notes at");
    });
  });
});

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
  "publish.sh verify and notes from a fixture tag",
  () => {
    let gnupg: string;
    // The key in KEYS on main, and one that is not.
    let signer: string, stranger: string;
    let work: string, repo: string;
    let env: NodeJS.ProcessEnv;

    const gpg = (...args: string[]) =>
      execFileSync("gpg", ["--homedir", gnupg, "--batch", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    function key(uid: string) {
      gpg("--passphrase", "", "--quick-gen-key", uid, "ed25519", "sign");
      const fpr = gpg("--with-colons", "--list-secret-keys", uid).match(
        /^fpr:+([0-9A-F]+):/m,
      )?.[1];
      if (!fpr) throw new Error(`gpg made no key for ${uid}`);
      return fpr;
    }

    beforeAll(() => {
      expect(NO_GPG, "gpg is on PATH").toBe(false);
      gnupg = mkdtempSync(join(tmpdir(), "publish-gpg-"));
      signer = key("Publish Test <publish@example.org>");
      stranger = key("Stranger <stranger@example.org>");
    });
    afterAll(() => {
      spawnSync("gpgconf", ["--homedir", gnupg, "--kill", "all"]);
      rmSync(gnupg, { recursive: true, force: true });
    });

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    // The script runs from a copy of itself in the fixture, as the workflow
    // runs it from the checked-out tag.
    const step = (...args: string[]) =>
      spawnSync(BASH, [join(repo, "scripts", "publish.sh"), ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
    // <version>: package.json and CHANGELOG.md at <version>, committed and
    // tagged v<version>, signed by <by> (or unsigned), pushed unless not.
    function tag(
      version: string,
      {
        by = signer as string | null,
        push = true,
        decdn = { gatewayFloor: "0.3.0" } as object | null,
      } = {},
    ) {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "@decdn/client", version, decdn }) + "\n",
      );
      writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
      git("add", "-A");
      git("commit", "-qm", `chore(release): v${version}`);
      const t = `v${version}`;
      if (by) git("tag", "-u", by, "-s", t, "-m", `@decdn/client ${version}`);
      else git("tag", "-a", t, "-m", `@decdn/client ${version}`);
      if (push) git("push", "-q", "origin", "main", t);
    }

    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "publish-fixture-"));
      repo = join(work, "repo");
      const origin = join(work, "origin.git");
      env = {
        HOME: work,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GNUPGHOME: gnupg,
      };
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
        env,
      });
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
      for (const [k, v] of Object.entries({
        "user.name": "Publish Test",
        "user.email": "publish@example.org",
      })) {
        git("config", k, v);
      }
      mkdirSync(join(repo, "scripts"));
      writeFileSync(join(repo, "scripts", "publish.sh"), readFileSync(SCRIPT));
      writeFileSync(join(repo, "KEYS"), gpg("--armor", "--export", signer));
      git("add", "-A");
      git("commit", "-qm", "chore: the fixture");
      git("remote", "add", "origin", origin);
      git("push", "-q", "-u", "origin", "main");
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    describe("verify", () => {
      it("passes a signed tag on origin, checked out", () => {
        tag("0.2.0");
        const r = step("verify", "v0.2.0");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain(
          `v0.2.0 is ${git("rev-parse", "HEAD").trim()}, signed by a key in KEYS`,
        );
      });

      it("stops on an unsigned tag", () => {
        tag("0.2.0", { by: null });
        const r = step("verify", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          "v0.2.0 is not signed by a key in KEYS on origin/main",
        );
      });

      it("reads KEYS from origin/main, not from the tag", () => {
        // The tag's own tree adds the stranger's key to KEYS.
        writeFileSync(
          join(repo, "KEYS"),
          gpg("--armor", "--export", signer, stranger),
        );
        tag("0.2.0", { by: stranger, push: false });
        git("push", "-q", "origin", "v0.2.0");
        const r = step("verify", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          "v0.2.0 is not signed by a key in KEYS on origin/main",
        );
      });

      it("stops on a tag that is not on origin", () => {
        tag("0.2.0", { push: false });
        const r = step("verify", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("tag v0.2.0 is not on origin");
      });

      it("stops on a checkout that is not at the tag", () => {
        tag("0.2.0");
        git("commit", "-q", "--allow-empty", "-m", "chore: after");
        const r = step("verify", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("the checkout is not at v0.2.0");
      });

      it("stops on a checkout that is not clean", () => {
        tag("0.2.0");
        writeFileSync(join(repo, "stray"), "x");
        const r = step("verify", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("the checkout at v0.2.0 is not clean");
      });
    });

    describe("notes", () => {
      it("prints a release's section, then the footer", () => {
        tag("0.2.0");
        const r = step("notes", "v0.2.0");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe(
          `${SECTION}\n\n---\n\n${footer("0.2.0", "@decdn/client")}`,
        );
      });

      it("prints a prerelease's footer alone", () => {
        tag("0.3.0-rc.1");
        const r = step("notes", "v0.3.0-rc.1");
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe(footer("0.3.0-rc.1", "@decdn/client@next"));
      });

      it("stops on a release without a changelog section", () => {
        tag("0.4.0");
        const r = step("notes", "v0.4.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          "CHANGELOG.md at v0.4.0 has no '## [0.4.0]' section",
        );
      });

      it.each([
        ["no", null, "'-'"],
        ["a malformed", { gatewayFloor: "0.3" }, "'0.3'"],
      ])("stops on %s gateway floor", (_, decdn, shown) => {
        tag("0.2.0", { decdn });
        const r = step("notes", "v0.2.0");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          `has decdn.gatewayFloor ${shown}, not X.Y.Z`,
        );
      });

      it("stops on a package.json at another version", () => {
        tag("0.2.0");
        const r = step("notes", "v0.2.1");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          "package.json is at 0.2.0, but the tag says 0.2.1",
        );
      });
    });
  },
);
