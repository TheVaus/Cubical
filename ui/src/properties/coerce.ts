/**
 * Best-effort type coercion for the Properties type-override menu
 * (L2 Session F, spec §2.4 — brainstorming decision (b)).
 *
 * `coerceValue` always produces a *valid* value of the target kind, so
 * the rendered cell-kind and its value never disagree. When the
 * conversion discards information it sets `lossy: true`; the Properties
 * row then shows a non-dismissable warning chip preserving the original
 * so the user can revert. Nothing is silently destroyed.
 */

import type { CellKind } from "./inferType";

/** Outcome of a coercion: the new value plus whether information was lost. */
export interface Coercion {
  value: unknown;
  lossy: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TRUTHY = new Set(["true", "yes", "1", "on"]);
const FALSY = new Set(["false", "no", "0", "off", ""]);

/** Coerce `value` into the target cell `kind`. */
export function coerceValue(value: unknown, kind: CellKind): Coercion {
  switch (kind) {
    case "string":
    case "multiline":
      return toStringValue(value);
    case "number":
    case "float":
    case "currency":
      return toNumberValue(value);
    case "int":
      return toIntValue(value);
    case "boolean":
      return toBooleanValue(value);
    case "date":
      return toDateValue(value);
    case "datetime":
      return toDateTimeValue(value);
    case "list-of-strings":
    case "list-of-tags":
      return toListValue(value);
    case "raw":
      // `raw` is not a user-pickable override; leave the value untouched.
      return { value, lossy: false };
  }
}

function toStringValue(value: unknown): Coercion {
  if (typeof value === "string") return { value, lossy: false };
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value), lossy: false };
  }
  if (value == null) return { value: "", lossy: false };
  return { value: JSON.stringify(value), lossy: true };
}

function toNumberValue(value: unknown): Coercion {
  if (typeof value === "number") return { value, lossy: false };
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return { value: n, lossy: false };
  }
  return { value: 0, lossy: true };
}

function toBooleanValue(value: unknown): Coercion {
  if (typeof value === "boolean") return { value, lossy: false };
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (TRUTHY.has(lower)) return { value: true, lossy: false };
    if (FALSY.has(lower)) return { value: false, lossy: false };
  }
  return { value: false, lossy: true };
}

function toDateValue(value: unknown): Coercion {
  if (typeof value === "string" && ISO_DATE.test(value)) {
    return { value, lossy: false };
  }
  return { value: "", lossy: true };
}

function toIntValue(value: unknown): Coercion {
  const num = toNumberValue(value);
  const n = num.value as number;
  const i = Math.trunc(n);
  return { value: i, lossy: num.lossy || i !== n };
}

function toDateTimeValue(value: unknown): Coercion {
  if (typeof value === "string") {
    if (ISO_DATETIME.test(value)) return { value, lossy: false };
    if (ISO_DATE.test(value)) return { value: `${value}T00:00`, lossy: false };
  }
  return { value: "", lossy: true };
}

function toListValue(value: unknown): Coercion {
  if (Array.isArray(value)) {
    const lossy = value.some((item) => typeof item !== "string");
    return { value: value.map((item) => String(item)), lossy };
  }
  if (value == null) return { value: [], lossy: false };
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { value: [String(value)], lossy: false };
  }
  return { value: [], lossy: true };
}
