/** An error's name and message, as `persistStopped` reports them (§4.10.6). */
export type Failure = { name: string; message: string };

/**
 * The name and message of a thrown or rejected value. Total: it never
 * throws, whatever the value (a revoked `Proxy`, a throwing getter, an
 * object without a prototype), so a failure path that reports one always
 * runs to its end. A value it cannot read becomes `{ name: "Error",
 * message: "Error" }` (Codex gate round 5, R5-3; security lane run 4,
 * S4.1).
 */
export function failureOf(error: unknown): Failure {
  let name: unknown;
  let message: unknown;
  try {
    ({ name, message } = (
      typeof error === "object" && error !== null ? error : {}
    ) as { name?: unknown; message?: unknown });
  } catch {
    return { name: "Error", message: "Error" };
  }
  let text = "Error";
  if (typeof message === "string") text = message;
  else {
    try {
      text = String(error);
    } catch {
      // Keeps "Error".
    }
  }
  return { name: typeof name === "string" ? name : "Error", message: text };
}
