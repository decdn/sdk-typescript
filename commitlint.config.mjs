// The same types as the PR title check (.github/workflows/pr-title.yml), so a
// branch's commits are conventional like the squash subject its title makes.
// A new type that stays out of the changelog also goes in cliff.toml's skips.
// No case rule, since a subject can start with a name (`README`,
// `DecdnClient`), and no length limits: headers run long, and body paragraphs
// and trailers are not wrapped.
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
