// The bench bundle's entry. scripts/bench.ts resolves the specifiers below
// to the `tscache/engine` source of the base and of the head revision, and
// of a second copy of the head, which the A/A control times against the
// head: two copies of the same code, as base and head are when a pull
// request leaves the engine alone. It installs `tscacheBench` on the
// global object for the runtime that loads the bundle.

// @ts-expect-error -- resolved by the bench build only (scripts/bench.ts).
import * as base from "tscache-bench:base";
// @ts-expect-error -- resolved by the bench build only (scripts/bench.ts).
import * as control from "tscache-bench:control";
// @ts-expect-error -- resolved by the bench build only (scripts/bench.ts).
import * as head from "tscache-bench:head";
import type { Impl } from "./cases";
import { type RunOptions, runBench } from "./run";

(globalThis as { tscacheBench?: unknown }).tscacheBench = (
  options: RunOptions,
) =>
  runBench(
    { base: base as Impl, head: head as Impl, control: control as Impl },
    options,
  );
