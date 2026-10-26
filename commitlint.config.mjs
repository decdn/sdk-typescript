// The same types as the PR title check (.github/workflows/pr-title.yml):
// squash merges take the PR title as the commit subject on main. No case
// rule, since a subject can start with a name (`README`, `DecdnClient`), and
// no length limits: subjects run long and body paragraphs are not wrapped.
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
