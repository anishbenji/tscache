/** One file of `npm pack --dry-run --json`. */
export interface PackedFile {
  path: string;
  size: number;
}

/** What `npm pack --dry-run --json` reports about the tarball. */
export interface Packed {
  filename: string;
  size: number;
  unpackedSize: number;
  files: PackedFile[];
}

/** The parts of package.json that name the files a tarball must hold. */
export interface Manifest {
  exports: Record<string, Record<string, string>>;
  sideEffects?: boolean | string[];
}

/**
 * Reads the output of `npm pack --dry-run --json` for one package. npm 11
 * prints an array of results; npm 12 prints an object keyed by package name.
 */
export function parsePack(text: string): Packed {
  const parsed: unknown = JSON.parse(text);
  const results =
    typeof parsed === "object" && parsed !== null ? Object.values(parsed) : [];
  if (results.length !== 1) {
    throw new Error(
      `npm pack reported ${results.length} packages, expected one`,
    );
  }
  const packed = results[0] as Partial<Packed>;
  if (!Array.isArray(packed.files)) {
    throw new Error("npm pack reported no file list");
  }
  return packed as Packed;
}

/** Built code and its declarations, emitted flat into dist/. */
const BUILT = /^dist\/[\w-]+\.(js|d\.ts)$/;
/** Names a test, a fixture or a source map carries, wherever it sits. */
const FORBIDDEN = /(^|[/._-])(tests?|spec|fixtures?)([/._-]|$)|\.map$/;

/**
 * What is wrong with a tarball's file list: a file the package needs and
 * the tarball lacks (package.json, the README, the license, every entry's
 * code and declarations, every file named in sideEffects), or a file that
 * is neither one of those nor built code in dist/. Empty when it is right.
 */
export function packProblems(
  files: readonly string[],
  manifest: Manifest,
): string[] {
  const present = new Set(files);
  const required = new Set(["package.json", "README.md", "LICENSE"]);
  for (const conditions of Object.values(manifest.exports)) {
    for (const target of Object.values(conditions)) {
      required.add(target.replace(/^\.\//, ""));
    }
  }
  if (Array.isArray(manifest.sideEffects)) {
    for (const file of manifest.sideEffects) {
      required.add(file.replace(/^\.\//, ""));
    }
  }
  const problems: string[] = [];
  for (const file of [...required].sort()) {
    if (!present.has(file)) problems.push(`missing: ${file}`);
  }
  for (const file of [...present].sort()) {
    if (FORBIDDEN.test(file) || !(required.has(file) || BUILT.test(file))) {
      problems.push(`not allowed: ${file}`);
    }
  }
  return problems;
}
