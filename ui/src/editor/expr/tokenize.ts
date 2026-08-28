import { scanWikilinks } from "../../ast/wikilink";

export type BinaryOp = "+" | "-" | "*" | "/" | "%";

export type Token =
  | { kind: "number"; value: number }
  | { kind: "ref"; note: string | null; property: string }
  | { kind: "op"; op: BinaryOp }
  | { kind: "lparen" }
  | { kind: "rparen" };

export const MAX_SOURCE_LENGTH = 1024;
export const MAX_TOKENS = 256;

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; reason: "syntax" | "too_complex" };

const OPERATORS = new Set<string>(["+", "-", "*", "/", "%"]);

function readRef(source: string, start: number): { token: Token; next: number } | null {
  const close = source.indexOf("]]", start + 2);
  if (close < 0) return null;
  const raw = source.slice(start, close + 2);
  const runs = scanWikilinks(raw);
  const first = runs[0];
  if (runs.length !== 1 || !first || first.kind !== "property_ref") return null;
  return {
    token: { kind: "ref", note: first.note, property: first.property },
    next: close + 2,
  };
}

export function tokenize(source: string): TokenizeResult {
  if (source.length > MAX_SOURCE_LENGTH) return { ok: false, reason: "too_complex" };
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) return { ok: false, reason: "too_complex" };
    if (ch === "[" && source[i + 1] === "[") {
      const ref = readRef(source, i);
      if (!ref) return { ok: false, reason: "syntax" };
      tokens.push(ref.token);
      i = ref.next;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (OPERATORS.has(ch)) {
      tokens.push({ kind: "op", op: ch as BinaryOp });
      i += 1;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let j = i;
      while (j < source.length) {
        const c = source[j]!;
        if ((c >= "0" && c <= "9") || c === ".") j += 1;
        else break;
      }
      const text = source.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, reason: "syntax" };
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }
    return { ok: false, reason: "syntax" };
  }
  if (tokens.length === 0) return { ok: false, reason: "syntax" };
  return { ok: true, tokens };
}
