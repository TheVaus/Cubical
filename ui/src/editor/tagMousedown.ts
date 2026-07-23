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
  findTagSpan: (target: EventTarget | null) => Element | null;
  onTagHit: (event: TagMousedownEvent) => boolean;
}

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

export function closestTagSpan(target: EventTarget | null): Element | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return el?.closest(".cm-md-tag") ?? null;
}

export function tagPathFromSlice(raw: string): string | null {
  if (raw.length < 2 || raw.charCodeAt(0) !== 0x23 ) return null;
  const body = raw.slice(1);
  return body.length === 0 ? null : body;
}
