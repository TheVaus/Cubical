import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";

import {
  activeRenderers,
  type BlockCompletion,
  type BlockRenderer,
} from "./blockRenderers";
import { isOpenAbove } from "./autoClose";

const TRIGGER = /^\s*(?:`{3,}|~{3,})([A-Za-z0-9_+#-]*)$/;

export interface FenceTrigger {
  query: string;
  from: number;
}

export function detectFenceTrigger(
  before: string,
  pos: number,
): FenceTrigger | null {
  const m = TRIGGER.exec(before);
  if (m === null) return null;
  const query = m[1] ?? "";
  return { query, from: pos - query.length };
}

export interface FenceOption {
  language: string;
  detail: string;
  aliases: readonly string[];
}

export function blockCompletions(
  renderers: readonly BlockRenderer[],
): FenceOption[] {
  const out: FenceOption[] = [];
  const seen = new Set<string>();
  for (const renderer of renderers) {
    const entries: readonly BlockCompletion[] =
      renderer.completions ??
      renderer.languages.map((language) => ({
        language,
        detail: renderer.id,
      }));
    for (const entry of entries) {
      if (seen.has(entry.language)) continue;
      seen.add(entry.language);
      out.push({
        language: entry.language,
        detail: entry.detail,
        aliases: entry.aliases ?? [],
      });
    }
  }
  return out;
}

function rank(option: FenceOption, query: string): number | null {
  if (query.length === 0) return 0;
  if (option.language.startsWith(query)) return 0;
  if (option.aliases.some((a) => a.startsWith(query))) return 1;
  return null;
}

export function matchingCompletions(
  options: readonly FenceOption[],
  query: string,
): FenceOption[] {
  const lowered = query.toLowerCase();
  return options
    .map((option) => ({ option, rank: rank(option, lowered) }))
    .filter((scored) => scored.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .map((scored) => scored.option);
}

export function fenceCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;

  const trigger = detectFenceTrigger(line.text.slice(0, pos - line.from), pos);
  if (trigger === null) return null;
  if (isOpenAbove(state.sliceDoc(0, line.from))) return null;

  const matched = matchingCompletions(
    blockCompletions(activeRenderers(state)),
    trigger.query,
  );
  if (matched.length === 0) return null;

  return {
    from: trigger.from,
    filter: false,
    options: matched.map((option) => ({
      label: option.language,
      detail: option.detail,
      type: "keyword",
    })),
  };
}
