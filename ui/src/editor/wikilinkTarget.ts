import type { TokenizedRun } from "../ast/wikilink";

export type WikiLinkToken = Extract<TokenizedRun, { kind: "wiki_link" }>;

export function wikiLinkTargetRaw(tok: WikiLinkToken): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}
