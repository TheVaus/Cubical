/**
 * Frontmatter serializer (spec §7.2). Reproduces scalars, string lists,
 * nested mappings, plus this app's own `# type:` comments (the type
 * registry).
 *
 * When an `existing` block is supplied, the serializer edits that block
 * *in place* — it reuses each unchanged key's parsed node — so foreign
 * comments and blank lines survive an edit to some *other* property. Only
 * anchors and aliases remain unmodelable (`hasUnmodelableYaml`): editing a
 * value that is shared by reference is genuinely ambiguous, so the
 * Properties UI renders read-only for those.
 */

import {
  Document,
  isAlias,
  parseDocument,
  visit,
  type Pair,
  type YAMLMap,
} from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import {
  isMap,
  isScalar,
  isSeq,
  type PropertyType,
  typeToToken,
} from "./typeComments";

/**
 * Serialize `entries` into a `---\n…\n---\n` block. When `types` is
 * supplied, each emittable key gets a trailing `# type:<token>` comment;
 * `currencyDefault` decides whether a currency's code is written. When
 * `existing` is the current block's YAML body, unchanged keys keep their
 * parsed nodes (and thus their comments and spacing).
 */
export function serializeFrontmatter(
  entries: FrontmatterEntry[],
  types?: Map<string, PropertyType>,
  currencyDefault = "usd",
  existing?: string,
): string {
  if (entries.length === 0) return "---\n---\n";

  const doc = buildDoc(entries, existing);
  if (types && isMap(doc.contents)) {
    applyTypeComments(doc.contents, types, currencyDefault);
  }
  return `---\n${String(doc)}---\n`;
}

/**
 * A Document whose top-level map matches `entries`. With a parseable
 * `existing` map we mutate it in place (preserving foreign content);
 * otherwise we build a fresh one from scratch.
 */
function buildDoc(entries: FrontmatterEntry[], existing?: string): Document {
  if (existing !== undefined && existing.trim() !== "") {
    const doc = parseDocument(existing);
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      syncMap(doc, doc.contents, entries);
      return doc;
    }
  }
  const obj: Record<string, unknown> = {};
  for (const [key, value] of entries) obj[key] = value;
  return new Document(obj);
}

/**
 * Reconcile `map`'s items with `entries`: reuse each surviving key's
 * existing pair (replacing its value node only when the value changed),
 * append pairs for new keys, drop pairs whose key is gone, and reorder to
 * match `entries`. Reused pairs carry their comments and spacing along.
 */
function syncMap(
  doc: Document,
  map: YAMLMap,
  entries: FrontmatterEntry[],
): void {
  const byKey = new Map<string, Pair>();
  for (const pair of map.items) {
    if (isScalar(pair.key)) byKey.set(String(pair.key.value), pair);
  }

  const next: Pair[] = [];
  for (const [key, value] of entries) {
    const prior = byKey.get(key);
    if (prior) {
      const current =
        prior.value == null
          ? null
          : ((prior.value as { toJSON?: () => unknown }).toJSON?.() ?? null);
      if (!valueEqual(current, value)) {
        prior.value = doc.createNode(value);
      }
      next.push(prior);
    } else {
      next.push(doc.createPair(key, value));
    }
  }
  map.items = next;
}

/** Structural equality over the JSON-ish shapes frontmatter values take. */
function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valueEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return (
      ak.length === bk.length &&
      ak.every((k) =>
        valueEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return false;
}

/**
 * Stamp each emittable key with its `# type:<token>` comment. A scalar
 * value carries it on the value (trailing the value); a block list carries
 * it on the key line (which re-parses as the value's `commentBefore`).
 */
function applyTypeComments(
  map: YAMLMap,
  types: Map<string, PropertyType>,
  currencyDefault: string,
): void {
  for (const pair of map.items) {
    if (!isScalar(pair.key)) continue;
    const type = types.get(String(pair.key.value));
    if (!type) continue;
    const token = typeToToken(type, currencyDefault);
    if (!token) continue;
    const comment = ` type:${token}`;
    if (pair.value && !isSeq(pair.value)) {
      (pair.value as { comment?: string | null }).comment = comment;
    } else {
      (pair.key as { comment?: string | null }).comment = comment;
    }
  }
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
 * Whether `yamlText` uses YAML the in-place serializer cannot safely
 * round-trip: anchors, aliases, or syntax the parser rejects. Comments and
 * blank lines are preserved by `serializeFrontmatter`, so they do NOT count.
 */
export function hasUnmodelableYaml(yamlText: string): boolean {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch {
    return true;
  }
  if (doc.errors.length > 0) return true;

  let flagged = false;
  visit(doc, (_key, node) => {
    if (node == null || typeof node !== "object") return undefined;
    if (isAlias(node)) {
      flagged = true;
      return visit.BREAK;
    }
    if ((node as { anchor?: string }).anchor) {
      flagged = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return flagged;
}
