import { Document, isAlias, isScalar, parseDocument, visit } from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import {
  FORMAT,
  layoutOf,
  narrowEdit,
  renderPair,
  unchanged,
  type Layout,
  type TextEdit,
  type TypeDirective,
} from "./frontmatterLayout";
import type { PropertyType } from "./typeComments";

export type PropertyEdit =
  | { op: "set"; key: string; value: unknown; type?: PropertyType | null }
  | { op: "rename"; from: string; to: string };

export function serializeFrontmatter(
  entries: FrontmatterEntry[],
  types?: Map<string, PropertyType>,
  currencyDefault = "usd",
  existing?: string,
): string {
  if (entries.length === 0) return "---\n---\n";
  const parsed = layoutOf(existing ?? "");
  const yaml = parsed ? (existing ?? "") : "";
  const layout = parsed ?? layoutOf("")!;
  return `---\n${rebuild(yaml, layout, entries, types, currencyDefault)}---\n`;
}

export function planPropertyEdit(
  source: string,
  edit: PropertyEdit,
  currencyDefault = "usd",
): TextEdit | null {
  const split = splitFrontmatter(source);
  if (split.yaml === null) {
    if (edit.op !== "set") return null;
    const types = edit.type ? new Map([[edit.key, edit.type]]) : undefined;
    const block = serializeFrontmatter(
      [[edit.key, edit.value]],
      types,
      currencyDefault,
    );
    return { from: 0, to: 0, text: block };
  }
  const yaml = split.yaml;
  if (hasUnmodelableYaml(yaml)) return null;
  const layout = layoutOf(yaml);
  if (!layout) return null;
  const next =
    edit.op === "rename"
      ? renameIn(yaml, layout, edit.from, edit.to)
      : setIn(yaml, layout, edit, currencyDefault);
  if (next === null || next === yaml) return null;
  return narrowEdit(yaml, next, source.indexOf("\n") + 1);
}

function rebuild(
  yaml: string,
  layout: Layout,
  entries: FrontmatterEntry[],
  types: Map<string, PropertyType> | undefined,
  currencyDefault: string,
): string {
  const { pairs, eol } = layout;
  const byKey = new Map(pairs.map((p, i) => [p.key, i]));
  const head = pairs.length > 0 ? yaml.slice(0, pairs[0]!.lineStart) : yaml;
  const tail = pairs.length > 0 ? yaml.slice(pairs.at(-1)!.end) : "";

  let out = head === "" || head.endsWith("\n") ? head : head + eol;
  for (const [key, value] of entries) {
    const directive: TypeDirective = types?.get(key) ?? "keep";
    const i = byKey.get(key);
    if (i === undefined) {
      out += renderPair(
        layout,
        key,
        value,
        undefined,
        directive,
        currencyDefault,
      );
      continue;
    }
    const at = pairs[i]!;
    const leadStart = i === 0 ? at.lineStart : pairs[i - 1]!.end;
    const lead = yaml.slice(leadStart, at.lineStart);
    const own = unchanged(layout, at, value, directive, currencyDefault)
      ? yaml.slice(at.lineStart, at.end)
      : renderPair(layout, key, value, at.pair, directive, currencyDefault);
    out += lead + (own.endsWith("\n") ? own : own + eol);
  }
  return out + tail;
}

function setIn(
  yaml: string,
  layout: Layout,
  edit: Extract<PropertyEdit, { op: "set" }>,
  currencyDefault: string,
): string {
  const directive: TypeDirective =
    edit.type === undefined ? "keep" : edit.type;
  const at = layout.pairs.find((p) => p.key === edit.key);
  if (at && unchanged(layout, at, edit.value, directive, currencyDefault)) {
    return yaml;
  }
  const pair = renderPair(
    layout,
    edit.key,
    edit.value,
    at?.pair,
    directive,
    currencyDefault,
  );
  if (at) return yaml.slice(0, at.lineStart) + pair + yaml.slice(at.end);
  const insertAt = layout.pairs.at(-1)?.end ?? yaml.length;
  const before = yaml.slice(0, insertAt);
  const sep = before === "" || before.endsWith("\n") ? "" : layout.eol;
  return before + sep + pair + yaml.slice(insertAt);
}

function renameIn(
  yaml: string,
  layout: Layout,
  from: string,
  to: string,
): string | null {
  if (layout.pairs.some((p) => p.key === to)) return null;
  const key = layout.pairs.find((p) => p.key === from)?.pair.key;
  if (!isScalar(key) || !key.range) return null;
  const range = key.range;
  const text = new Document(to).toString(FORMAT).replace(/\n$/, "");
  if (text.includes("\n")) return null;
  return yaml.slice(0, range[0]) + text + yaml.slice(range[1]);
}

export function spliceFrontmatter(source: string, block: string): string {
  const split = splitFrontmatter(source);
  if (split.span === null) return block + source;
  return block + source.slice(split.span.end);
}

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
  return flagged || layoutOf(yamlText) === null;
}
