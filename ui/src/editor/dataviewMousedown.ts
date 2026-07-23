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
  findDataviewLink: (target: EventTarget | null) => Element | null;
  findDataviewFrame: (target: EventTarget | null) => Element | null;
  onLinkHit: (link: Element) => boolean;
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

export function closestDataviewLink(target: EventTarget | null): Element | null {
  return closestMatching(target, ".cq-dataview-link");
}

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
