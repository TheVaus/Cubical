/**
 * Frontmatter value → Properties cell-kind inference (L2 Session F, spec §2.4).
 *
 * Pure: a parsed YAML value (the JSON shape `parseFrontmatterYaml`
 * produces) plus its key name map to one of the editable cell kinds, or
 * `"raw"` for anything the Properties UI cannot model. The key name is
 * an input because the `tags` key promotes a plain string array to the
 * tag-styled chip cell.
 */

/** Discriminant for which Properties cell component renders a value. */
export type CellKind =
  | "string" // text (inferred, or text/plain)
  | "multiline" // text/multiline (explicit only)
  | "number" // generic number (inferred only)
  | "int" // number/int (explicit only)
  | "float" // number/float (explicit only)
  | "currency" // number/currency, USD (explicit only)
  | "boolean" // checkbox
  | "date" // date
  | "datetime" // date/datetime (explicit only)
  | "list-of-strings" // list
  | "list-of-tags" // tags
  | "raw";

/** `YYYY-MM-DD` — the only date shape L2 models (spec §2.4). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keys whose string-array values render as tag chips rather than plain
 * string chips. `aliases` is deliberately *not* here: aliases are
 * alternate note names, not tags (`docs/architecture/document-model.md`
 * §5.6) — a §2.4 spec deviation confirmed with the operator.
 */
const TAG_LIST_KEYS = new Set(["tags"]);

/** Infer the cell kind for a frontmatter `key`/`value` pair. */
export function inferType(key: string, value: unknown): CellKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    return ISO_DATE.test(value) ? "date" : "string";
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return TAG_LIST_KEYS.has(key) ? "list-of-tags" : "list-of-strings";
    }
    return "raw";
  }
  return "raw";
}
