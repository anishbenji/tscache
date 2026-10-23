// Dependabot sometimes capitalises "Bump" (#7), which fails subject-case
// before CI checks anything else. Its pull requests are proposals reviewed
// by hand, so only its own bump commits, marked by its sign-off, are skipped.
const dependabotBump = (message) =>
  /^(chore|ci): Bump /.test(message) &&
  message.includes("Signed-off-by: dependabot[bot] <support@github.com>");

export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [dependabotBump],
};
