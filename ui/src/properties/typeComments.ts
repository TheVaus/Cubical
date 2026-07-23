import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { isKnownDateFormat } from "./dateFormats";
import type { CellKind } from "./inferType";

export interface PropertyType {
  kind: CellKind;
  format?: string;
  currency?: string;
  values?: string[];
}

const TYPE_RE = /^\s*type:(.+?)\s*$/;

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

export function isTypeComment(comment: string | null | undefined): boolean {
  return parseTypeToken(comment) !== undefined;
}

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
      return type.currency && type.currency !== defaultCurrency
        ? `float/currency/${type.currency}`
        : "float/currency";
    case "boolean":
      return "boolean";
    case "enum":
      return `enum(${(type.values ?? []).join(",")})`;
    case "date":
      return type.format ? `date:${type.format}` : "date";
    case "list-of-strings":
      return "list";
    case "raw":
      return null;
  }
}

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

export { isMap, isScalar, isSeq };
