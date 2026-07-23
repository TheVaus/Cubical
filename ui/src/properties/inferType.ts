export type CellKind =
  | "string"
  | "int"
  | "float"
  | "currency"
  | "boolean"
  | "enum"
  | "date"
  | "list-of-strings"
  | "raw";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function inferType(value: unknown): CellKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "string") {
    return ISO_DATE.test(value) ? "date" : "string";
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string")
      ? "list-of-strings"
      : "raw";
  }
  return "raw";
}
