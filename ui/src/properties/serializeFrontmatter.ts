/**
 * Frontmatter serializer (L2 Session F, spec §2.4 / §5 #1).
 *
 * The counterpart to `ui/src/ast/frontmatter.ts`'s splitter/parser. The
 * frontend owns frontmatter serialization — there is no Rust-side
 * reserializer until plugins demand one (spec §5 #1). Properties
 * commits reserialize the *whole* block from the edited entries and
 * splice it back into the source.
 *
 * Lossless-round-trip guarantee: `serializeFrontmatter` reproduces only
 * what the entries model — scalars, string lists, and nested mappings.
 * YAML comments, anchors, and aliases are *not* in the entries shape
 * and would be silently dropped. `hasUnmodelableYaml` is the guard:
 * Properties renders read-only whenever it returns `true`, so the
 * serializer never runs on frontmatter it cannot faithfully reproduce.
 */

import { isAlias, parseDocument, stringify, visit } from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";

/**
 * Serialize `entries` into a complete `---\n…\n---\n` frontmatter block.
 *
 * Key order follows `entries` order (`yaml.stringify` preserves object
 * insertion order). An empty entry list yields a bare `---\n---\n`.
 */
export function serializeFrontmatter(entries: FrontmatterEntry[]): string {
  if (entries.length === 0) return "---\n---\n";
  const obj: Record<string, unknown> = {};
  for (const [key, value] of entries) obj[key] = value;
  return `---\n${stringify(obj)}---\n`;
}

/**
 * Splice a fresh frontmatter `block` into `source`, replacing any
 * existing block. When `source` has no frontmatter the block is
 * inserted at offset 0.
 */
export function spliceFrontmatter(source: string, block: string): string {
  const split = splitFrontmatter(source);
  if (split.span === null) {
    return block + source;
  }
  return block + source.slice(split.span.end);
}

/**
 * Report whether `yamlText` contains YAML the entries-based serializer
 * cannot losslessly reproduce — comments, anchors, aliases, or syntax
 * the parser rejects outright. When `true`, the Properties UI degrades
 * to read-only so a commit cannot silently destroy the content.
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
    if (n.comment || n.commentBefore || n.anchor) {
      flagged = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return flagged;
}
