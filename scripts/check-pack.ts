// What `npm publish` would upload: runs `npm pack --dry-run --json` in
// packages/tscache, after the build, and fails unless the tarball holds
// exactly package.json, README.md, LICENSE and the built code with its
// declarations in dist/, every entry of `exports` among it, and no test,
// fixture or source map (scripts/pack-contents.ts). Prints the file list.
//
//   bun scripts/check-pack.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Manifest, packProblems, parsePack } from "./pack-contents";

const PACKAGE = fileURLToPath(new URL("../packages/tscache/", import.meta.url));

const npm = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
  cwd: PACKAGE,
  stdout: "pipe",
  stderr: "inherit",
});
if (npm.exitCode !== 0) {
  console.error(`npm pack --dry-run exited with ${npm.exitCode}`);
  process.exit(1);
}
const packed = parsePack(npm.stdout.toString());
const manifest = JSON.parse(
  readFileSync(`${PACKAGE}package.json`, "utf8"),
) as Manifest;

const kB = (bytes: number) => `${(bytes / 1000).toFixed(2)} kB`;
console.log(
  `${packed.filename}: ${packed.files.length} files, ${kB(packed.size)} packed, ${kB(packed.unpackedSize)} unpacked`,
);
for (const file of packed.files) {
  console.log(`  ${file.path.padEnd(32)} ${kB(file.size).padStart(9)}`);
}

const problems = packProblems(
  packed.files.map((file) => file.path),
  manifest,
);
if (problems.length > 0) {
  console.error("The tarball's contents are wrong:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
