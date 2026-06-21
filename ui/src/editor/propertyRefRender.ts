/**
 * Pure DOM renderer for a property reference (`[[note.prop]]` / `[[.prop]]`).
 *
 * No CodeMirror imports — unit-testable under jsdom. The widget in
 * `propertyRef.ts` owns resolution and feeds this a render state:
 *   - `resolved`  → the scalar value text
 *   - `loading`   → the raw token (cross-file fetch in flight)
 *   - `broken`    → the raw token, broken-ref styled (note/key missing)
 */

export type PropertyRefRenderState =
  | { status: "resolved"; value: string }
  | { status: "loading"; raw: string }
  | { status: "broken"; raw: string };

export function renderPropertyRef(state: PropertyRefRenderState): HTMLElement {
  const span = document.createElement("span");
  if (state.status === "resolved") {
    span.className = "cm-md-propref";
    span.textContent = state.value;
  } else if (state.status === "loading") {
    span.className = "cm-md-propref cm-md-propref-loading";
    span.textContent = state.raw;
  } else {
    span.className = "cm-md-propref cm-md-propref-broken";
    span.textContent = state.raw;
  }
  return span;
}
