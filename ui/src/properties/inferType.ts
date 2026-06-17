/**
 * Frontmatter value → Properties cell-kind inference.
 *
 * Pure: a parsed YAML value (the JSON shape `parseFrontmatterYaml`
 * produces) maps to one of the editable cell kinds, or `"raw"` for
 * anything the Properties UI cannot model. Inference covers the kinds a
 * value can disambiguate on its own; the explicit-only kinds (`currency`,
 * `enum`, and non-default date formats) come solely from a type comment
 * or a menu choice.
 */

/** Discriminant for which Properties cell component renders a value. */
export type CellKind =
  | "string" // text
  | "int" // whole number
  | "float" // decimal
  | "currency" // a float rendered with a currency symbol (explicit only)
  | "boolean" // true / false
  | "enum" // one of a fixed set of values (explicit only)
  | "date" // a date (or date+time), formatted
  | "list-of-strings" // an array of strings (# items render as tag chips)
  | "raw";

/** `YYYY-MM-DD` — the date shape inference recognizes from a bare string. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Infer the cell kind for a frontmatter `value`. */
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
