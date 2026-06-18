/**
 * Inline type-comment grammar (spec §4). Types are stored as a trailing
 * YAML comment on a property's key line, e.g. `price: 9.99 #
 * type:float/currency/usd` or `status: alive # type:enum(alive,dead)`.
 * This module is the single source of truth for the `PropertyType ⇄
 * comment token` mapping and for reading those comments out of a
 * frontmatter YAML string.
 *
 * Marker is `type:`. Everything after it (trimmed) is the token — which
 * may contain spaces (date formats like `YYYY-MM-DD HH:MM`) and
 * parentheses (enum). A comment counts as a type hint ONLY when the token
 * resolves to a known kind; otherwise it is an ordinary comment.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { isKnownDateFormat } from "./dateFormats";
import type { CellKind } from "./inferType";

/** A resolved property type: a kind plus kind-specific extras. */
export interface PropertyType {
  kind: CellKind;
  /** Date only — a curated format token. */
  format?: string;
  /** Currency only — a lowercase code (usd/nis/eur). */
  currency?: string;
  /** Enum only — the allowed values, in order. */
  values?: string[];
}

/** A node comment like ` type:enum(a,b)` (no leading `#`). */
const TYPE_RE = /^\s*type:(.+?)\s*$/;

/** Parse a node `comment` string into a PropertyType, or `undefined`. */
export function parseTypeToken(
  comment: string | null | undefined,
): PropertyType | undefined {
  if (!comment) return undefined;
  const m = TYPE_RE.exec(comment);
  if (!m) return undefined;
  const raw = m[1]!.trim();

  if (raw === "text" || raw === "string") return { kind: "string" };
  if (raw === "int") return { kind: "int" };
  if (raw === "float") return { kind: "float" };
  if (raw === "boolean") return { kind: "boolean" };
  if (raw === "list") return { kind: "list-of-strings" };

  if (raw === "float/currency") return { kind: "currency" };
  if (raw.startsWith("float/currency/")) {
    const code = raw.slice("float/currency/".length).trim().toLowerCase();
    return code ? { kind: "currency", currency: code } : { kind: "currency" };
  }
  if (raw.startsWith("enum(") && raw.endsWith(")")) {
    const inner = raw.slice("enum(".length, -1);
    const values = inner
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    return { kind: "enum", values };
  }
  if (raw === "date") return { kind: "date" };
  if (raw.startsWith("date:")) {
    const format = raw.slice("date:".length).trim();
    return isKnownDateFormat(format)
      ? { kind: "date", format }
      : { kind: "date" };
  }
  return undefined;
}

/** Whether a node comment is a recognized type hint. */
export function isTypeComment(comment: string | null | undefined): boolean {
  return parseTypeToken(comment) !== undefined;
}

/**
 * Build the comment token for a PropertyType, or `null` when the type is
 * not emittable (`raw`). The date format is appended only when it differs
 * from `defaultFormat`.
 */
export function typeToToken(
  type: PropertyType,
  defaultCurrency = "usd",
): string | null {
  switch (type.kind) {
    case "string":
      return "text";
    case "int":
      return "int";
    case "float":
      return "float";
    case "currency":
      // A currency matching the vault default is written bare. Safe because
      // the value is a format-agnostic number — changing the default only
      // re-skins the symbol.
      return type.currency && type.currency !== defaultCurrency
        ? `float/currency/${type.currency}`
        : "float/currency";
    case "boolean":
      return "boolean";
    case "enum":
      return `enum(${(type.values ?? []).join(",")})`;
    case "date":
      // Always write the format inline. Unlike currency, a date's value is
      // stored *in* its format, so omitting it and resolving via the vault
      // default would mis-read existing values if the default ever changes.
      return type.format ? `date:${type.format}` : "date";
    case "list-of-strings":
      return "list";
    case "raw":
      return null;
  }
}

/**
 * Read per-key type comments from a frontmatter YAML body. Only
 * top-level keys; the value's trailing `comment` (scalars) or
 * `commentBefore` (block lists) wins over the key-node comment.
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
