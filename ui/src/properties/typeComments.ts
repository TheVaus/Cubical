/**
 * Inline type-comment grammar (spec §4, §4b, §7.1).
 *
 * Types are stored as a trailing YAML comment on a property's key line,
 * e.g. `price: 9.99 # type:number/currency` or `d: 17-06-26 #
 * type:date:DD-MM-YY`. This module is the single source of truth for the
 * `PropertyType ⇄ comment token` mapping and for reading those comments
 * out of a frontmatter YAML string.
 *
 * Marker is `type:`. Because `type:` is a common word, a comment counts
 * as a type hint ONLY when what follows resolves to a known kind.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { isKnownDateFormat } from "./dateFormats";
import type { CellKind } from "./inferType";

/** A resolved property type: a kind plus an optional date format. */
export interface PropertyType {
  kind: CellKind;
  /** Only meaningful when `kind === "date"`. */
  format?: string;
}

/** Emittable kinds → canonical token (date handled separately). */
const KIND_TO_TOKEN: Partial<Record<CellKind, string>> = {
  string: "text",
  multiline: "text/multiline",
  int: "number/int",
  float: "number/float",
  currency: "number/currency",
  boolean: "checkbox",
  date: "date",
  datetime: "datetime",
  "list-of-strings": "list",
  "list-of-tags": "tags",
  // `number` and `raw` are intentionally absent — never written.
};

/** Canonical + alias tokens → kind (date/currency handled in code). */
const TOKEN_TO_KIND: Record<string, CellKind> = {
  text: "string",
  "text/plain": "string",
  "text/multiline": "multiline",
  number: "number",
  "number/int": "int",
  "number/float": "float",
  checkbox: "boolean",
  datetime: "datetime",
  "date/datetime": "datetime",
  list: "list-of-strings",
  "list/list": "list-of-strings",
  tags: "list-of-tags",
  "list/tags": "list-of-tags",
};

/** A node comment like ` type:date:DD-MM-YY` (no leading `#`). */
const TYPE_RE = /^\s*type:(\S+)\s*$/;

/** Parse a node `comment` string into a PropertyType, or `undefined`. */
export function parseTypeToken(
  comment: string | null | undefined,
): PropertyType | undefined {
  if (!comment) return undefined;
  const m = TYPE_RE.exec(comment);
  if (!m) return undefined;
  const raw = m[1]!.trim();

  // Date with optional format param: `date` or `date:FORMAT`. (The
  // `date/datetime` alias falls through to TOKEN_TO_KIND → datetime.)
  if (raw === "date") return { kind: "date" };
  if (raw.startsWith("date:")) {
    const format = raw.slice("date:".length);
    return isKnownDateFormat(format)
      ? { kind: "date", format }
      : { kind: "date" };
  }
  // Currency tolerates a future per-currency param, e.g. number/currency:EUR.
  if (raw === "number/currency" || raw.startsWith("number/currency:")) {
    return { kind: "currency" };
  }
  const kind = TOKEN_TO_KIND[raw];
  return kind ? { kind } : undefined;
}

/** Whether a node comment is a recognized type hint. */
export function isTypeComment(comment: string | null | undefined): boolean {
  return parseTypeToken(comment) !== undefined;
}

/**
 * Build the comment token for a PropertyType, or `null` when the type is
 * not emittable (`number`, `raw`). The date format is appended only when
 * it differs from `defaultFormat`.
 */
export function typeToToken(
  type: PropertyType,
  defaultFormat: string,
): string | null {
  if (type.kind === "date") {
    if (type.format && type.format !== defaultFormat) {
      return `date:${type.format}`;
    }
    return "date";
  }
  return KIND_TO_TOKEN[type.kind] ?? null;
}

/**
 * Read per-key type comments from a frontmatter YAML body. Only
 * top-level keys; value-node comment wins over key-node comment.
 */
export function parseTypeComments(yaml: string): Map<string, PropertyType> {
  const out = new Map<string, PropertyType>();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yaml);
  } catch {
    return out;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return out;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const value = pair.value as {
      comment?: string | null;
      commentBefore?: string | null;
    } | null;
    const keyComment = (pair.key as { comment?: string | null }).comment;
    // Scalar values carry the hint as a trailing `comment`; block-list
    // values carry it as `commentBefore` (the `# …` after `key:` on the
    // key line, before the items). Key-node comment is a final fallback.
    const type =
      parseTypeToken(value?.comment) ??
      parseTypeToken(value?.commentBefore) ??
      parseTypeToken(keyComment);
    if (type) out.set(key, type);
  }
  return out;
}

// Shared `yaml` predicates for serializeFrontmatter.
export { isMap, isScalar, isSeq };
