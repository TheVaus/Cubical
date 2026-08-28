import type { EvalErrorKind } from "./expr/evaluate";

export type EquationRenderState =
  | { status: "ok"; value: string }
  | { status: "loading"; raw: string }
  | { status: "error"; kind: EvalErrorKind; raw: string };

const MESSAGES: Record<EvalErrorKind, string> = {
  syntax: "not an expression",
  too_complex: "expression too long",
  not_a_number: "not a number",
  unresolved_note: "note not found",
  missing_property: "property not found",
  divide_by_zero: "divide by zero",
};

export function equationErrorMessage(kind: EvalErrorKind): string {
  return MESSAGES[kind];
}

export function renderEquation(state: EquationRenderState): HTMLElement {
  const span = document.createElement("span");
  if (state.status === "ok") {
    span.className = "cm-equation";
    span.textContent = state.value;
    return span;
  }
  if (state.status === "loading") {
    span.className = "cm-equation cm-equation-loading";
    span.textContent = state.raw;
    return span;
  }
  span.className = "cm-equation cm-equation-error";
  span.textContent = MESSAGES[state.kind];
  span.title = state.raw;
  return span;
}
