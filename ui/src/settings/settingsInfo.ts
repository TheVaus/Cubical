/** Settings whose toggle carries an info popover (spec: five complex settings). */
export type InfoId =
  | "typed-props"
  | "wiki-repair"
  | "dataview"
  | "property-refs"
  | "shortcuts";

/**
 * Reducer for the single `openInfo` signal. Clicking the `ⓘ` of the
 * already-open row closes it; any other click opens (or switches to) that row.
 */
export function toggleInfo(current: InfoId | null, id: InfoId): InfoId | null {
  return current === id ? null : id;
}
