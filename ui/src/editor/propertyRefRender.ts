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
