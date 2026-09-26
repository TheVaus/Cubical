import {
  Document,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Pair,
  parseDocument,
  type Node,
  type Scalar,
  type YAMLMap,
} from "yaml";

import {
  isTypeComment,
  pairType,
  type PropertyType,
  typeToToken,
} from "./typeComments";

export type TypeDirective = PropertyType | null | "keep";

export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

export const FORMAT = { lineWidth: 0 } as const;

export interface Located {
  key: string;
  pair: Pair;
  lineStart: number;
  end: number;
}

export interface Layout {
  pairs: Located[];
  values: Record<string, unknown>;
  indent: string;
  indentSeq: boolean;
  eol: string;
}

export function layoutOf(yaml: string): Layout | null {
  let doc: Document;
  try {
    doc = parseDocument(yaml, { intAsBigInt: true });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const layout: Layout = {
    pairs: [],
    values: {},
    indent: "",
    indentSeq: true,
    eol,
  };
  if (doc.contents === null) return layout;
  if (!isMap(doc.contents) || doc.contents.flow) return null;
  const values = doc.toJS() as unknown;
  if (!values || typeof values !== "object") return null;
  layout.values = values as Record<string, unknown>;

  let seqSeen = false;
  for (const [i, pair] of doc.contents.items.entries()) {
    const key = pair.key;
    if (!isScalar(key) || !key.range) return null;
    const lineStart = lineStartOf(yaml, key.range[0]);
    const indent = yaml.slice(lineStart, key.range[0]);
    if (!/^ *$/.test(indent)) return null;
    if (i === 0) layout.indent = indent;
    else if (indent !== layout.indent) return null;

    const value = isNode(pair.value) ? pair.value : null;
    const last = Math.max(key.range[2], value?.range?.[2] ?? 0);
    const prev = layout.pairs.at(-1);
    if (prev && lineStart < prev.end) return null;
    layout.pairs.push({
      key: String(key.value),
      pair,
      lineStart,
      end: lineEndOf(yaml, last),
    });

    if (!seqSeen && isSeq(value) && !value.flow && value.range) {
      seqSeen = true;
      const col = value.range[0] - lineStartOf(yaml, value.range[0]);
      layout.indentSeq = col > indent.length;
    }
  }
  return layout;
}

function lineStartOf(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEndOf(text: string, at: number): number {
  if (at > 0 && text[at - 1] === "\n") return at;
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl + 1;
}

export function unchanged(
  layout: Layout,
  at: Located,
  value: unknown,
  directive: TypeDirective,
  currencyDefault: string,
): boolean {
  if (!valueEqual(layout.values[at.key], value)) return false;
  if (directive === "keep") return true;
  const prior = pairType(at.pair);
  const token = (t: PropertyType | null | undefined) =>
    t ? typeToToken(t, currencyDefault) : null;
  return token(prior) === token(directive);
}

function trailingComment(pair: Pair): string | undefined {
  const value = isNode(pair.value) ? pair.value : null;
  const key = pair.key as Scalar;
  if (value && !isCollection(value) && value.comment) return value.comment;
  return key.comment ?? value?.commentBefore ?? value?.comment ?? undefined;
}

export function renderPair(
  layout: Layout,
  key: string,
  value: unknown,
  prior: Pair | undefined,
  directive: TypeDirective,
  currencyDefault: string,
): string {
  const doc = new Document({});
  const keyNode = prior ? (prior.key as Scalar).clone() : doc.createNode(key);
  const same = prior && valueEqual(layout.values[key], value);
  const valueNode = (
    same && isNode(prior.value) ? prior.value.clone() : doc.createNode(value)
  ) as Node;
  for (const node of [keyNode, valueNode]) {
    node.comment = null;
    node.commentBefore = null;
    node.spaceBefore = false;
  }

  const priorComment = prior ? trailingComment(prior) : undefined;
  const token =
    directive && directive !== "keep"
      ? typeToToken(directive, currencyDefault)
      : null;
  const comment =
    directive === "keep"
      ? priorComment
      : token
        ? ` type:${token}`
        : priorComment && !isTypeComment(priorComment)
          ? priorComment
          : undefined;
  if (comment) {
    if (isSeq(valueNode)) keyNode.comment = comment;
    else valueNode.comment = comment;
  }

  (doc.contents as YAMLMap).items.push(new Pair(keyNode, valueNode));
  let text = doc.toString({ ...FORMAT, indentSeq: layout.indentSeq });
  if (layout.indent) {
    text = text
      .split("\n")
      .map((line) => (line === "" ? line : layout.indent + line))
      .join("\n");
  }
  return layout.eol === "\n" ? text : text.replace(/\n/g, layout.eol);
}

export function narrowEdit(before: string, after: string, offset: number): TextEdit {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  if (p > 0 && isHighSurrogate(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (
    s < max - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s++;
  }
  if (s > 0 && isLowSurrogate(before.charCodeAt(before.length - s))) s--;
  return {
    from: offset + p,
    to: offset + before.length - s,
    text: after.slice(p, after.length - s),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" && typeof b === "number") return Number(a) === b;
  if (typeof a === "number" && typeof b === "bigint") return a === Number(b);
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
