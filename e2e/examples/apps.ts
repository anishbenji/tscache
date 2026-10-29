// The example apps under examples/, the reference clients under
// reference/, and the port `vite preview` serves each on. A port of its own gives each app its own origin, so its own
// SharedWorker, BroadcastChannel and mock backend.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const apps = {
  "vanilla-uplot": 5101,
  "solid-uplot": 5102,
  "solid-lwcharts": 5103,
  "react-lwcharts": 5104,
  "react-ssr": 5105,
  "solid-ssr": 5106,
  "reference-vanilla": 5201,
  "reference-react": 5202,
  "reference-solid": 5203,
} as const;

export type App = keyof typeof apps;

/** Offsets come in steps of this, so no two checkouts' port sets overlap. */
const STEP = 1000;
/** Offsets below this keep every port under the ephemeral range (49152). */
const STEPS = 40;

/**
 * Added to every port of the suite. Outside CI, Playwright reuses a server
 * it finds on its port, so two checkouts running the suite at once would
 * share servers and mock backends, and one would test the other's build.
 * Each checkout gets an
 * offset from a hash of its path instead (1 to 39 thousand);
 * `E2E_PORT_OFFSET` (0 to 39, in thousands) overrides it, and CI uses none.
 */
export function portOffset(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): number {
  if (env.CI) return 0;
  const set = env.E2E_PORT_OFFSET;
  if (set !== undefined && set !== "") {
    const steps = Number(set);
    if (!Number.isInteger(steps) || steps < 0 || steps >= STEPS) {
      throw new RangeError(
        `E2E_PORT_OFFSET must be an integer from 0 to ${STEPS - 1}, not ${set}`,
      );
    }
    return steps * STEP;
  }
  // Never 0, which CI and a checkout without offsets use.
  const hash = createHash("sha256").update(root).digest().readUInt32BE(0);
  return (1 + (hash % (STEPS - 1))) * STEP;
}

const offset = portOffset(
  process.env,
  fileURLToPath(new URL("../..", import.meta.url)),
);

/** The port of the server for the package's own suite (scripts/e2e-server.ts). */
export const serverPort: number = 4173 + offset;

export function appPort(app: App): number {
  return apps[app] + offset;
}

export function appUrl(app: App): string {
  return `http://127.0.0.1:${appPort(app)}/`;
}

/** The app's directory from the repository root. */
export function appDir(app: App): string {
  return app.startsWith("reference-")
    ? `reference/${app.slice("reference-".length)}`
    : `examples/${app}`;
}
