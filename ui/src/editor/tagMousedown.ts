/**
 * Pure helper for the editor's tag click interceptor (L3 Session E).
 *
 * Mirrors `wikilinkMousedown.ts` byte-for-byte in spirit: lives outside
 * `Editor.tsx` so it's unit-testable without spinning up a real
 * `EditorView`, and defers the "do we navigate?" call to
 * `onTagHit` (the production code uses `posAtCoords` + Lezer there).
 *
 * Returns `true` if the event was handled (caller should already have
 * called `preventDefault`/`stopImmediatePropagation`). Returns `false`
 * if the click is not a tag click and the default flow should continue.
 */

export interface TagMousedownEvent {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
}

export interface TagMousedownHandlerOptions {
  /**
   * Look up the span the user clicked on. Mirrors
   * `target.closest('.cm-md-tag')` in production; tests can stub it.
   */
  findTagSpan: (target: EventTarget | null) => Element | null;
  /**
   * Called once we've confirmed the click landed on a tag span. The
   * production wiring resolves screen coords to a doc position via
   * `view.posAtCoords` and pulls the tag path off the `Tag` Lezer node;
   * the callback returns `true` only when the click was actually
   * handled.
   */
  onTagHit: (event: TagMousedownEvent) => boolean;
}

/**
 * Inspect a mousedown event; if it's a plain left-click on a tag span,
 * delegate to `onTagHit` and (on success) call `preventDefault` +
 * `stopImmediatePropagation` so neither CM6 nor the browser's
 * contenteditable selection logic moves the caret.
 */
export function maybeInterceptTagMousedown(
  event: TagMousedownEvent,
  opts: TagMousedownHandlerOptions,
): boolean {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const span = opts.findTagSpan(event.target);
  if (!span) return false;
  if (!opts.onTagHit(event)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

/**
 * Resolve a mousedown's `event.target` to the tag span that contains
 * the click, returning `null` for clicks outside any tag mark. Lifts
 * `Text` node targets to their parent element first — WKWebView
 * dispatches mouse events on the text node inside a mark span, and
 * `closest()` is only defined on `Element`. (Same lesson learned from
 * the L3 Session B wiki-link click bug; see `closestWikiLinkSpan`.)
 */
export function closestTagSpan(target: EventTarget | null): Element | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return el?.closest(".cm-md-tag") ?? null;
}

/**
 * Extract the tag path from a chunk of literal source matching a `Tag`
 * Lezer node — strips the leading `#` and returns the body. Returns
 * `null` for a malformed slice (no `#` opener or empty body).
 */
export function tagPathFromSlice(raw: string): string | null {
  if (raw.length < 2 || raw.charCodeAt(0) !== 0x23 /* # */) return null;
  const body = raw.slice(1);
  return body.length === 0 ? null : body;
}
