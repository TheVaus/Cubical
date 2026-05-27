/**
 * Pure helper for the editor's wiki-link click interceptor.
 *
 * Lives outside `Editor.tsx` so it's unit-testable without spinning up
 * a real `EditorView` (no jsdom, no layout, no posAtCoords resolution).
 * See `Editor.tsx` `onContentMousedown` for the production caller and
 * the WKWebView background that drove this design.
 *
 * The function decides whether a given mousedown should be treated as
 * a wiki-link click — purely from the DOM target + modifier state — and
 * defers the "do we navigate?" call to the supplied `onWikilinkHit`
 * callback (the production code uses `posAtCoords` + Lezer there).
 *
 * Returns `true` if the event was handled (caller should already have
 * called `preventDefault`/`stopImmediatePropagation`). Returns `false`
 * if the click is not a wiki-link click and the default flow should
 * continue.
 */
export interface WikiLinkMousedownEvent {
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

export interface WikiLinkMousedownHandlerOptions {
  /**
   * Look up the span the user clicked on. Mirrors
   * `target.closest('.cm-md-wikilink, .cm-md-wikilink-unresolved')`
   * in production; tests can stub it.
   */
  findWikiLinkSpan: (target: EventTarget | null) => Element | null;
  /**
   * Called once we've confirmed the click is on a wiki-link span.
   * The production wiring resolves screen coords to a doc position via
   * `view.posAtCoords` and looks up the WikiLink Lezer node before
   * firing the async navigation; the callback returns `true` only when
   * the click was actually handled (e.g. the resolver was present and a
   * wiki-link node existed at the click position).
   */
  onWikiLinkHit: (event: WikiLinkMousedownEvent) => boolean;
}

/**
 * Inspect a mousedown event; if it's a left-click on a wiki-link span
 * with no modifiers, delegate to `onWikiLinkHit` and (on success) call
 * `preventDefault` + `stopImmediatePropagation` so neither CM6 nor the
 * browser's contenteditable selection logic moves the caret.
 */
export function maybeInterceptWikiLinkMousedown(
  event: WikiLinkMousedownEvent,
  opts: WikiLinkMousedownHandlerOptions,
): boolean {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const span = opts.findWikiLinkSpan(event.target);
  if (!span) return false;
  if (!opts.onWikiLinkHit(event)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

/**
 * Resolve a mousedown's `event.target` to the wiki-link span that
 * contains the click, returning `null` for clicks outside any
 * wiki-link mark.
 *
 * Production caller passes `(target) => closestWikiLinkSpan(target)`
 * so this is the only place we encode the WebKit/Chromium difference:
 * Chromium tends to dispatch mouse events on the visible `<span>` of
 * a mark decoration, while WebKit/WKWebView dispatches on the Text
 * node *inside* the span. `closest()` is only defined on `Element`,
 * so a Text-node target must be lifted to its parent first or the
 * lookup silently returns null and we never preventDefault — that
 * was the root cause of the L3 Session B click bug staying alive
 * through two prior fix attempts.
 */
export function closestWikiLinkSpan(
  target: EventTarget | null,
): Element | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return (
    el?.closest(".cm-md-wikilink, .cm-md-wikilink-unresolved") ?? null
  );
}
