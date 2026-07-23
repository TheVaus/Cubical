import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

import type { AutocompleteProvider } from "./autocompleteProvider";

export interface Trigger {
  query: string;
  from: number;
}

export function detectLinkTrigger(before: string, pos: number): Trigger | null {
  const m = /\[\[([^\]\n|#]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { query, from: pos - query.length };
}

export function detectTagTrigger(before: string, pos: number): Trigger | null {
  const m = /(?:^|\s)#([A-Za-z0-9_/-]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { query, from: pos - query.length };
}

export function linkInsertion(
  path: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? path : `${path}]]`;
  return { insert, cursorAfter: path.length + (closerFollows ? 0 : 2) };
}

export interface BlockTrigger {
  target: string;
  from: number;
}

export function detectBlockTrigger(
  before: string,
  pos: number,
): BlockTrigger | null {
  const m = /\[\[([^\]\n|#]+)#\^([A-Za-z0-9_-]*)$/.exec(before);
  if (!m) return null;
  const target = m[1] ?? "";
  if (target.trim().length === 0) return null;
  const prefix = m[2] ?? "";
  return { target, from: pos - prefix.length };
}

export function blockInsertion(
  id: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? id : `${id}]]`;
  return { insert, cursorAfter: id.length + (closerFollows ? 0 : 2) };
}

const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "InlineCode",
  "Comment",
  "CommentBlock",
  "HTMLBlock",
  "HTMLTag",
]);

export function isInhibited(
  state: EditorState,
  pos: number,
  denyWikiLink: boolean,
): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (CODE_NODES.has(node.name)) return true;
    if (denyWikiLink && node.name === "WikiLink") return true;
    node = node.parent;
  }
  return false;
}

function lineBefore(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from);
}

export function linkCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectLinkTrigger(before, context.pos);
    if (!trig) return null;
    if (isInhibited(context.state, context.pos, false)) return null;

    const candidates = await provider.links(trig.query);
    if (candidates.length === 0) return null;

    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const closerFollows = after === "]]";

    return {
      from: trig.from,
      options: candidates.map((c) => ({
        label: c.title,
        detail: c.path,
        apply: (view: import("@codemirror/view").EditorView, _completion: import("@codemirror/autocomplete").Completion, from: number, to: number) => {
          const { insert, cursorAfter } = linkInsertion(c.path, closerFollows);
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + cursorAfter },
          });
        },
      })),
      validFor: /^[^\]\n|#]*$/,
    };
  };
}

export function blockCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectBlockTrigger(before, context.pos);
    if (!trig) return null;
    if (isInhibited(context.state, context.pos, false)) return null;

    const candidates = await provider.blockIds(trig.target);
    if (candidates.length === 0) return null;

    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const closerFollows = after === "]]";

    return {
      from: trig.from,
      options: candidates.map((id) => ({
        label: id,
        apply: (
          view: import("@codemirror/view").EditorView,
          _completion: import("@codemirror/autocomplete").Completion,
          from: number,
          to: number,
        ) => {
          const { insert, cursorAfter } = blockInsertion(id, closerFollows);
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + cursorAfter },
          });
        },
      })),
      validFor: /^[A-Za-z0-9_-]*$/,
    };
  };
}

export function tagCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectTagTrigger(before, context.pos);
    if (!trig) return null;
    if (isInhibited(context.state, context.pos, true)) return null;

    const candidates = await provider.tags(trig.query);
    if (candidates.length === 0) return null;

    return {
      from: trig.from,
      options: candidates.map((tag) => ({ label: tag, apply: tag })),
      validFor: /^[A-Za-z0-9_/-]*$/,
    };
  };
}
