// The end-to-end scenarios' contract between scripts/bench-e2e.ts, which drives
// Chromium, and the page that runs them (bench/e2e.ts). Free of DOM types,
// so the driver can import it.

import type { Sample } from "./sample";

/** Which revision of the package a page talks to. */
export type Side = "base" | "head";

/**
 * The scenarios timed inside one page; handshake-first-read takes a new
 * page per run (scripts/bench-e2e.ts).
 */
export type PageScenario =
  | "read-viewport-shared"
  | "two-tabs-one-fetch"
  | "live-tail-get";

/** The bars every scenario reads: a chart's screen and one each side. */
export const BARS = 1500;

/** One run of an operation: how long it took, and the bars it read. */
export interface Once {
  ms: number;
  value: number;
}

export interface Preparation {
  scenario: PageScenario;
  side: Side;
  /** The mock backend's namespace (scripts/e2e-backend.ts). */
  ns: string;
  /** The cache's id; two-tabs-one-fetch uses the same one in both pages. */
  id: string;
  /**
   * two-tabs-one-fetch: the leader runs the operation, the follower
   * answers it from the second page.
   */
  role: "leader" | "follower";
}

/** What the scenario page installs as `globalThis.tscacheE2e`. */
export interface E2ePage {
  /** handshake-first-read: a new client, its first read, timed once. */
  firstRead(side: Side, ns: string): Promise<Once>;
  /** Connects this page's client of `side` and readies the scenario. */
  prepare(preparation: Preparation): Promise<void>;
  /** The scenario's operation once, on one side. */
  once(scenario: PageScenario, side: Side): Promise<Once>;
  /** The scenario's operation, the head against the base (sampleAsync). */
  sample(scenario: PageScenario, rounds: number): Promise<Sample>;
  /** How often the scenario's operation ran on `side`, warm-ups included. */
  calls(scenario: PageScenario, side: Side): number;
}
