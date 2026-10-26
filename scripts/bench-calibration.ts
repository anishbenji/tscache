// Tallies a calibration of the timing gate (bench-calibrate.yml,
// docs/benchmarking.md): the results of many runs of the head against
// itself, each in its own directory, with the slowdown that was injected.
//
//   bun scripts/bench-calibration.ts <directory> <slowdown>
//
// With no slowdown, every confirmed regression is a false alarm; with one,
// every case that is not one is a miss. Prints a Markdown table: per
// runtime and case, in how many runs the gate fired.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Report {
  runtime: string;
  noisy: boolean;
  verdicts: Record<string, string>;
}

const [directory = "calibration", slowdownArg = "0"] = process.argv.slice(2);
const slowdown = Number(slowdownArg);

/** runtime → case → [fired, runs]; and noisy runs per runtime. */
const tally = new Map<string, Map<string, [number, number]>>();
const noisyRuns = new Map<string, number>();
let runs = 0;

for (const run of readdirSync(directory)) {
  runs++;
  for (const file of readdirSync(join(directory, run))) {
    if (!file.endsWith(".json")) continue;
    const report = JSON.parse(
      readFileSync(join(directory, run, file), "utf8"),
    ) as Report;
    if (report.noisy) {
      noisyRuns.set(report.runtime, (noisyRuns.get(report.runtime) ?? 0) + 1);
    }
    const cases = tally.get(report.runtime) ?? new Map();
    tally.set(report.runtime, cases);
    for (const [name, verdict] of Object.entries(report.verdicts)) {
      const [fired, seen] = cases.get(name) ?? [0, 0];
      // A noisy run fails nothing, so it fires nothing either.
      const fires = verdict === "regression" && !report.noisy;
      cases.set(name, [fired + (fires ? 1 : 0), seen + 1]);
    }
  }
}

const what =
  slowdown === 0
    ? "false alarms (should be none)"
    : `detections of a ${Math.round(slowdown * 100)} % slowdown`;
const lines = [
  `### Bench calibration: ${runs} runs, ${what}`,
  "",
  "| Runtime | Case | Fired | Runs |",
  "|---|---|---:|---:|",
];
for (const [runtime, cases] of tally) {
  for (const [name, [fired, seen]] of cases) {
    lines.push(`| ${runtime} | \`${name}\` | ${fired} | ${seen} |`);
  }
}
lines.push("");
for (const [runtime, count] of noisyRuns) {
  lines.push(`- ${runtime}: ${count} run(s) noisy (A/A control out of bounds)`);
}
console.log(lines.join("\n"));
