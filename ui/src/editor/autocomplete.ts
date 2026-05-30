/**
 * Link + tag autocomplete for the editor (L3 Session F, spec §2.6).
 *
 * Trigger detection and insert-text construction are pure (unit-tested
 * in autocomplete.test.ts). The two `CompletionSource`s combine pure
 * detection + Lezer "inside code" gating + an injected
 * {@link AutocompleteProvider} (the IPC adapter). Anchors/block-ids
 * inside `[[…#…]]` are intentionally NOT completed here — the link
 * trigger stops at `#`/`|`; in-bracket anchor completion is a later
 * session (needs the L3 Session G blocks table).
 */

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
  /** The text typed after the trigger, used to query candidates. */
  query: string;
  /** Absolute doc offset where the query starts (the completion `from`). */
  from: number;
}

/**
 * Detect a `[[` link trigger ending at `pos`. `before` is the text from
 * the start of the current line up to `pos`. Returns the target query
 * (chars after the last unclosed `[[`, stopping before `]`, `|`, `#`,
 * or newline) and where it begins, or null when the cursor is not
 * inside an open, target-position `[[`.
 */
export function detectLinkTrigger(before: string, pos: number): Trigger | null {
  const m = /\[\[([^\]\n|#]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { query, from: pos - query.length };
}

/**
 * Detect a `#` tag trigger ending at `pos`. The `#` must be at a word
 * boundary (start of `before`, or preceded by whitespace) and followed
 * only by valid tag-body chars (`[A-Za-z0-9_/-]`). Returns the body
 * typed so far and where it begins, or null.
 */
export function detectTagTrigger(before: string, pos: number): Trigger | null {
  const m = /(?:^|\s)#([A-Za-z0-9_/-]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { query, from: pos - query.length };
}

/**
 * Build the text to insert when a link candidate is chosen. Appends the
 * closing `]]` unless it already follows the cursor. `cursorAfter` is
 * the offset (relative to the insert start) where the caret should land.
 */
export function linkInsertion(
  path: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? path : `${path}]]`;
  return { insert, cursorAfter: path.length + (closerFollows ? 0 : 2) };
}

/** Output of {@link detectBlockTrigger}: which target's blocks to query. */
export interface BlockTrigger {
  /** Wiki-link target as typed (between `[[` and `#^`). */
  target: string;
  /** Absolute doc offset where the partial id starts (completion `from`). */
  from: number;
}

/**
 * Detect a `[[target#^prefix` trigger ending at `pos`. Returns the
 * target text and the offset where the partial id begins, or `null`
 * when no match (including empty target). The regex deliberately
 * requires the literal `#^` so it never collides with heading
 * completion (`[[target#headline`, deferred — no headings index).
 */
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

/**
 * Build the text to insert when a block-id candidate is chosen. Mirrors
 * {@link linkInsertion} but the inserted string is just the id (the
 * user has already typed `^`). Appends `]]` unless it already follows.
 */
export function blockInsertion(
  id: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? id : `${id}]]`;
  return { insert, cursorAfter: id.length + (closerFollows ? 0 : 2) };
}

/** Lezer node names that suppress autocomplete (raw / code contexts). */
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

/**
 * True when `pos` sits inside a code/raw context (and, when
 * `denyWikiLink`, inside a `WikiLink` node — a `#` there is an anchor,
 * not a tag). Walks the resolved node's ancestor chain.
 */
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

/** Read the current line's text from its start up to `pos`. */
function lineBefore(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from);
}

/** `[[` link-completion source backed by `provider.links`. */
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

/** `#` tag-completion source backed by `provider.tags`. */
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
