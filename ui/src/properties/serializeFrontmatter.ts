/**
 * Frontmatter serializer (spec §7.2). Reproduces scalars, string lists,
 * nested mappings, plus this app's own `# type:` comments (the type
 * registry). Foreign comments/anchors/aliases are NOT reproduced —
 * `hasUnmodelableYaml` guards: the Properties UI renders read-only
 * whenever it returns `true`. Recognized `# type:` comments are exempted.
 */

import { Document, isAlias, parseDocument, visit } from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import {
  isMap,
  isScalar,
  isSeq,
  isTypeComment,
  type PropertyType,
  typeToToken,
} from "./typeComments";

/**
 * Serialize `entries` into a `---\n…\n---\n` block. When `types` is
 * supplied, each emittable key gets a trailing `# type:<token>` comment;
 * `dateDefault` decides whether a date's format param is written.
 */
export function serializeFrontmatter(
  entries: FrontmatterEntry[],
  types?: Map<string, PropertyType>,
  dateDefault = "YYYY-MM-DD",
): string {
  if (entries.length === 0) return "---\n---\n";
  const obj: Record<string, unknown> = {};
  for (const [key, value] of entries) obj[key] = value;
  const doc = new Document(obj);

  if (types && isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key)) continue;
      const type = types.get(String(pair.key.value));
      if (!type) continue;
      const token = typeToToken(type, dateDefault);
      if (!token) continue;
      const comment = ` type:${token}`;
      // Scalar value → comment after the value; block list → on the key
      // line (which re-parses as the value's `commentBefore`).
      if (pair.value && !isSeq(pair.value)) {
        (pair.value as { comment?: string | null }).comment = comment;
      } else {
        (pair.key as { comment?: string | null }).comment = comment;
      }
    }
  }

  return `---\n${String(doc)}---\n`;
}

/**
 * Splice a fresh `block` into `source`, replacing any existing block.
 */
export function spliceFrontmatter(source: string, block: string): string {
  const split = splitFrontmatter(source);
  if (split.span === null) return block + source;
  return block + source.slice(split.span.end);
}

/**
 * Whether `yamlText` contains YAML the serializer cannot losslessly
 * reproduce — foreign comments, anchors, aliases, or rejected syntax.
 * Recognized `# type:` comments (trailing on scalars, or `commentBefore`
 * on block-list values) do NOT count.
 */
export function hasUnmodelableYaml(yamlText: string): boolean {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch {
    return true;
  }
  if (doc.errors.length > 0) return true;
  if (doc.commentBefore || doc.comment) return true;

  let flagged = false;
  visit(doc, (_key, node) => {
    if (node == null || typeof node !== "object") return undefined;
    if (isAlias(node)) {
      flagged = true;
      return visit.BREAK;
    }
    const n = node as {
      comment?: string | null;
      commentBefore?: string | null;
      anchor?: string;
    };
    if (n.anchor) {
      flagged = true;
      return visit.BREAK;
    }
    if (n.comment && !isTypeComment(n.comment)) {
      flagged = true;
      return visit.BREAK;
    }
    if (n.commentBefore && !isTypeComment(n.commentBefore)) {
      flagged = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return flagged;
}
