/**
 * Field names come from the consumer's schema and may collide with
 * Object.prototype members (`__proto__`, `constructor`, …). Plain assignment
 * would hit the inherited `__proto__` setter, and a plain read would find
 * inherited members, so name-keyed records go through these two helpers.
 */

/** Defines `name` as an own enumerable data property, whatever the name. */
export function setOwn<T>(
  record: Record<string, T>,
  name: string,
  value: T,
): void {
  Object.defineProperty(record, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** The value of an own property, or undefined; never an inherited member. */
export function getOwn<T>(
  record: Record<string, T>,
  name: string,
): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}
