import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { EntrySize } from "./size-measure";

// The measurement bundles with Bun.build, which Vitest (under Node) lacks: a
// Bun process measures fixture packages and prints the sizes.

const root = mkdtempSync(join(tmpdir(), "tscache-size-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Variant {
  /** The content hash in each chunk's file name, as tsdown writes it. */
  hashes: { shared: string; lazy: string; nested: string };
  /** A doc comment that tsdown keeps in the chunks. */
  comment: string;
  /** Constants in each chunk's code: the code itself. */
  code: { shared: number; lazy: number; nested: number };
}

const base: Variant = {
  hashes: { shared: "AAAAAAAA", lazy: "BBBBBBBB", nested: "CCCCCCCC" },
  comment: "/** Original wording. */",
  code: { shared: 42, lazy: 7, nested: 3 },
};

/**
 * A built package with one entry that imports a shared chunk statically and
 * a lazy chunk with `import()`, which loads a nested chunk in turn: each of
 * the three measured rows names a hashed chunk in an import string.
 */
function writeDist(name: string, v: Variant): string {
  const { shared, lazy, nested } = v.hashes;
  return writeFiles(name, {
    "index.js": `import { shared } from "./shared-${shared}.js";
${v.comment}
export async function load() {
  const { lazy } = await import("./lazy-${lazy}.js");
  return lazy(shared());
}
`,
    [`shared-${shared}.js`]: `${v.comment}
export function shared() {
  return ${v.code.shared};
}
`,
    [`lazy-${lazy}.js`]: `import { shared } from "./shared-${shared}.js";
${v.comment}
export async function lazy(x) {
  const { nested } = await import("./nested-${nested}.js");
  return nested(x) + shared() + ${v.code.lazy};
}
`,
    [`nested-${nested}.js`]: `import { shared } from "./shared-${shared}.js";
${v.comment}
export function nested(x) {
  return x * shared() * ${v.code.nested};
}
`,
  });
}

/** A built package of the given files, by name; returns its directory. */
function writeFiles(name: string, files: Record<string, string>): string {
  const dist = join(root, name, "dist/");
  mkdirSync(dist, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dist, file), text);
  }
  return dist;
}

/** The `index` entry of each dist, measured by scripts/size-measure.ts. */
async function measure(dists: string[]): Promise<EntrySize[]> {
  const module = fileURLToPath(new URL("./size-measure.ts", import.meta.url));
  const script = `
    const { measureEntry } = await import(${JSON.stringify(module)});
    const sizes = [];
    for (const dist of ${JSON.stringify(dists)}) {
      sizes.push(await measureEntry(dist, "index", "browser"));
    }
    process.stdout.write(JSON.stringify(sizes));`;
  const output = await new Promise<string>((resolve, reject) =>
    execFile("bun", ["-e", script], (error, stdout, stderr) =>
      error
        ? reject(new Error(`${String(error)}\n${stderr}`))
        : resolve(stdout),
    ),
  );
  return JSON.parse(output) as EntrySize[];
}

describe("measureEntry", () => {
  it("measures the same size when only chunk hashes or comments change", async () => {
    const [original, renamed, reworded] = await measure([
      writeDist("original", base),
      // A rebuild that gives the chunks other content hashes.
      writeDist("renamed", {
        ...base,
        hashes: { shared: "q7Zx_9Kp", lazy: "Ie-yiNQd", nested: "hXM790vS" },
      }),
      // A comment-only edit: the comment changes, and with it every hash.
      writeDist("reworded", {
        ...base,
        hashes: { shared: "EheY_Cd9", lazy: "DzEfM3ve", nested: "t_g_9xuO" },
        comment:
          "/** Reworded at greater length, with no change to the code it documents. */",
      }),
    ]);
    expect(original?.lazy).toBeDefined();
    expect(original?.nested).toBeDefined();
    expect(renamed).toEqual(original);
    expect(reworded).toEqual(original);
  });

  it("moves the row of the chunk whose code changes, and only that row", async () => {
    const rows = ["initial", "lazy", "nested"] as const;
    // shared is in the entry's initial load; the lazy rows leave it out.
    const chunkOfRow = { initial: "shared", lazy: "lazy", nested: "nested" };
    const [original, ...changed] = await measure([
      writeDist("code-original", base),
      ...rows.map((row) =>
        writeDist(`code-${row}`, {
          ...base,
          code: { ...base.code, [chunkOfRow[row]]: 4_242_424 },
        }),
      ),
    ]);
    rows.forEach((row, i) => {
      const sizes = changed[i];
      for (const other of rows) {
        if (other === row) {
          expect(sizes?.[other], `${row} change, ${other} row`).not.toEqual(
            original?.[other],
          );
        } else {
          expect(sizes?.[other], `${row} change, ${other} row`).toEqual(
            original?.[other],
          );
        }
      }
    });
  });

  it("fails on a left-out chunk whose file name carries no 8-character hash", async () => {
    const dist = writeFiles("unhashed", {
      "index.js": 'export const load = () => import("./lazy.js");\n',
      "lazy.js": "export const lazy = 1;\n",
    });
    await expect(measure([dist])).rejects.toThrow(/update stableChunkName/);
  });

  it("fails when two left-out chunks would be measured under one name", async () => {
    const dist = writeFiles("collision", {
      "index.js": `export const load = () =>
  Promise.all([import("./lazy-AAAAAAAA.js"), import("./lazy-BBBBBBBB.js")]);
`,
      "lazy-AAAAAAAA.js": "export const a = 1;\n",
      "lazy-BBBBBBBB.js": "export const b = 2;\n",
    });
    await expect(measure([dist])).rejects.toThrow(
      /would both be measured as \.\/lazy-00000000\.js: give the chunks distinct names/,
    );
  });
});
