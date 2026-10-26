// Tallies a calibration of the timing gate (bench-calibrate.yml,
// docs/benchmarking.md): the results of many runs of the head against
// itself, each in its own directory, with the slowdown that was injected.
//
//   bun scripts/bench-calibration.ts <directory> <slowdown>
//
// With no slowdown, every confirmed regression is a false alarm; with one,
// every case that is not one is a miss. Prints a Markdown table: per
// runtime and case, in how many quiet runs the gate fired. Noisy runs
// (the A/A control out of bounds) fail nothing, so they count in neither
// column and are listed apart.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CalibrationReport,
  tallyCalibration,
} from "../packages/tscache/bench/gate";

const [directory = "calibration", slowdownArg = "0"] = process.argv.slice(2);
const slowdown = Number(slowdownArg);

const runs = readdirSync(directory);
const reports: CalibrationReport[] = runs.flatMap((run) =>
  readdirSync(join(directory, run))
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        JSON.parse(
          readFileSync(join(directory, run, file), "utf8"),
        ) as CalibrationReport,
    ),
);
const { cases, noisy } = tallyCalibration(reports);

const what =
  slowdown === 0
    ? "false alarms (should be none)"
    : `detections of a ${Math.round(slowdown * 100)} % slowdown`;
const lines = [
  `### Bench calibration: ${runs.length} runs, ${what}`,
  "",
  "| Runtime | Case | Fired | Quiet runs |",
  "|---|---|---:|---:|",
];
for (const [runtime, counts] of cases) {
  for (const [name, [fired, quiet]] of counts) {
    lines.push(`| ${runtime} | \`${name}\` | ${fired} | ${quiet} |`);
  }
}
lines.push("");
for (const [runtime, count] of noisy) {
  lines.push(`- ${runtime}: ${count} noisy run(s), left out of the counts`);
}
console.log(lines.join("\n"));
