// The same types as the PR title check (.github/workflows/pr-title.yml):
// branch commits reach main as they are on a rebase merge, and as the squash
// subject of a single-commit PR. Keep the two lists in step. No case rule,
// since a subject can start with a name (`README`, `DecdnClient`), and no
// length limits: headers run long, and body paragraphs and trailers are not
// wrapped.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "docs",
        "chore",
        "revert",
        "security",
        "ci",
        "test",
        "style",
        "build",
      ],
    ],
    "subject-case": [0],
    "header-max-length": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
