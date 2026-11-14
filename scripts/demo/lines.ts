// The lines the demo launcher (scripts/demo.ts) prints for the demo recorder
// (scripts/demo/record.ts), which reads the launcher's output.

/** Starts the line the launcher prints once its hub is up. */
export const HUB_LINE = "tscache demo hub:";

/**
 * The line the launcher prints first thing as it starts stopping, before it
 * signals any app server: from then on its app ports may be anyone's.
 */
export const STOPPING_LINE = "tscache demo: stopping";

/**
 * What the launcher prints: the stopping line on a line of its own. The
 * leading newline ends any partial line an app server's stderr left on the
 * shared stream, so `stopping` still sees the line whole (step 89, security
 * lane S1.1).
 */
export const STOPPING_NOTICE = `\n${STOPPING_LINE}`;

/** Whether the launcher's output so far holds its stopping line, whole. */
export function stopping(output: string): boolean {
  return output.split("\n").some((line) => line.trim() === STOPPING_LINE);
}
