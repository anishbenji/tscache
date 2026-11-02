// #region filter
// vite-logger.ts
import type { Logger } from "vite";

/**
 * Silences tscache's warning about IIFE workers, for an app that keeps
 * `worker: { format: 'iife' }` on purpose. The warning's opening words are a
 * stable contract of tscache; every other message is logged as before.
 */
export function withoutTscacheIifeWarning(logger: Logger): Logger {
  const warn = logger.warn;
  // Replace warn on this logger, not on a copy: Vite keeps hasWarned on it.
  logger.warn = (message, options) => {
    if (message.startsWith("[tscache] Vite builds workers as IIFE")) return;
    warn.call(logger, message, options);
  };
  return logger;
}
// #endregion filter
