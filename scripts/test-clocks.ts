// Fails when a test reads the wall clock, times itself or sleeps, which is
// how tests here have flaked (docs/testing.md): a bar or a day boundary
// passing mid-test, a timing ratio on a busy machine, a sleep too short
// under load. Every test has a seam instead: Vitest's fake timers
// (vi.useFakeTimers, vi.setSystemTime), an injected clock, Playwright's
// page.clock and the mock backend's advanceMs, and vi.waitFor or
// expect.poll for a condition rather than a pause.
//
// A line that needs one anyway says why, on the line or the one above:
//   // clock-ok: <reason>
//
// It also keeps Playwright's retries at 0, so a flake fails the run it
// happens in instead of passing on a second try.
//
//   bun scripts/test-clocks.ts           checks the repository
//   bun scripts/test-clocks.ts <files>   checks those files

import { readFileSync } from "node:fs";

export interface Rule {
  name: string;
  pattern: RegExp;
  why: string;
}

export const RULES: readonly Rule[] = [
  {
    name: "wall clock",
    pattern: /\bDate\.now\(\)|\bnew Date\(\)/,
    why: "use vi.setSystemTime, page.clock or the backend's clock",
  },
  {
    name: "timing",
    pattern: /\bperformance\.now\(\)/,
    why: "measure time in the bench, or inject a clock",
  },
  {
    name: "sleep",
    // test.setTimeout() sets a test's time limit, not a sleep.
    pattern: /(?<!\.)\bsetTimeout\(|\.waitForTimeout\(/,
    why: "wait for a condition (vi.waitFor, expect.poll) or advance fake timers",
  },
];

const ALLOW = /\/\/\s*clock-ok:\s*\S/;

export interface Finding {
  file: string;
  line: number;
  rule: string;
  why: string;
  text: string;
}

/** Strips a line's trailing `//` comment and a whole-line comment. */
function code(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
  const comment = line.search(/(^|[^:"'`])\/\//);
  return comment === -1 ? line : line.slice(0, comment + 1);
}

/** The findings in one file's text. */
export function check(file: string, text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  lines.forEach((line, i) => {
    const source = code(line);
    for (const rule of RULES) {
      if (!rule.pattern.test(source)) continue;
      if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? "")) continue;
      findings.push({
        file,
        line: i + 1,
        rule: rule.name,
        why: rule.why,
        text: line.trim(),
      });
    }
  });
  return findings;
}

/** Whether a Playwright config sets retries other than 0. */
export function retriesSet(config: string): boolean {
  return [...config.matchAll(/\bretries\s*:\s*([^,}\n]+)/g)].some(
    ([, value]) => value?.trim() !== "0",
  );
}

/** The test files git knows: unit tests, the Playwright suites and their pages. */
function testFiles(): string[] {
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "--",
    "packages/*/test/**",
    "examples/*/test/**",
    "integrations/test/**",
    "reference/*/test/**",
    "scripts/*.test.ts",
    "e2e/**",
  ]);
  return (
    listed.stdout
      .toString()
      .split("\n")
      .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file))
      // This check's own tests hold the patterns as fixtures.
      .filter((file) => file !== "scripts/test-clocks.test.ts")
  );
}

if (import.meta.main) {
  const given = process.argv.slice(2);
  const files = given.length > 0 ? given : testFiles();
  const findings = files.flatMap((file) =>
    check(file, readFileSync(file, "utf8")),
  );
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.rule}: ${f.why}\n    ${f.text}`);
  }
  let failed = findings.length > 0;
  if (
    given.length === 0 &&
    retriesSet(readFileSync("playwright.config.ts", "utf8"))
  ) {
    console.error(
      "playwright.config.ts: retries must stay 0, so a flake fails the run it happens in",
    );
    failed = true;
  }
  if (failed) {
    console.error(
      `\n${findings.length} finding(s). Use the test's clock seam, or add "// clock-ok: <reason>" (docs/testing.md).`,
    );
    process.exit(1);
  }
  console.log(`test-clocks: ${files.length} files clean`);
}
