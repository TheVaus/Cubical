/**
 * Pure helper for the editor's ```query (dataview) link click interceptor.
 *
 * Mirrors `tagMousedown.ts` / `wikilinkMousedown.ts`: the rendered query
 * widget is a `Decoration.replace` over the fenced block, so its note
 * links have no backing Lezer node — a bubble-phase `click` handler is
 * also unreliable in WKWebView, where the caret moves on `mousedown`
 * before `click` fires (see Editor.tsx). So navigation runs from a
 * capture-phase `mousedown` interceptor that reads the link's `data-path`
 * directly, exactly like wiki-link / tag clicks.
 *
 * Returns `true` if the event was handled (in which case `preventDefault`
 * + `stopImmediatePropagation` have been called); `false` to let the
 * default flow continue.
 */

export interface DataviewMousedownEvent {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
}

export interface DataviewMousedownHandlerOptions {
  /** Look up the link element the click landed on (prod: `closestDataviewLink`). */
  findDataviewLink: (target: EventTarget | null) => Element | null;
  /** Look up the widget frame the click landed on (prod: `closestDataviewFrame`). */
  findDataviewFrame: (target: EventTarget | null) => Element | null;
  /**
   * Called once a click is confirmed on a dataview link. Production reads
   * the `data-path` off the element and routes it to the runner's `open`;
   * returns `true` only when navigation was actually dispatched.
   */
  onLinkHit: (link: Element) => boolean;
  /**
   * Called for a non-link click inside the widget frame. Production moves
   * the cursor to the block's start so cursor-line suppression reveals the
   * raw ```query source for editing (a `COUNT` widget has no link, so this
   * is its only interaction). Returns `true` when the reveal was dispatched.
   */
  onFrameHit: (frame: Element) => boolean;
}

export function maybeInterceptDataviewMousedown(
  event: DataviewMousedownEvent,
  opts: DataviewMousedownHandlerOptions,
): boolean {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  // A link click navigates; any other click inside the widget reveals the
  // raw source. Links sit inside the frame, so the link branch runs first.
  const link = opts.findDataviewLink(event.target);
  if (link && opts.onLinkHit(link)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  const frame = opts.findDataviewFrame(event.target);
  if (frame && opts.onFrameHit(frame)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  return false;
}

/**
 * Resolve a mousedown's `event.target` to the dataview link element that
 * contains the click, or `null`. Lifts `Text`-node targets to their
 * parent first — WKWebView dispatches mouse events on the text node, and
 * `closest()` is only defined on `Element` (same lesson as the wiki-link
 * and tag interceptors).
 */
export function closestDataviewLink(target: EventTarget | null): Element | null {
  return closestMatching(target, ".cq-dataview-link");
}

/**
 * Resolve a mousedown's `event.target` to the dataview widget frame that
 * contains the click, or `null`. Same `Text`-node lift as
 * `closestDataviewLink`.
 */
export function closestDataviewFrame(target: EventTarget | null): Element | null {
  return closestMatching(target, ".cm-dataview-frame");
}

function closestMatching(target: EventTarget | null, selector: string): Element | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return el?.closest(selector) ?? null;
}
