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
  findWikiLinkSpan: (target: EventTarget | null) => Element | null;
  onWikiLinkHit: (event: WikiLinkMousedownEvent) => boolean;
}

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
