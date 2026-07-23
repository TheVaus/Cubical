import { describe, expect, it, vi } from "vitest";

import {
  closestWikiLinkSpan,
  maybeInterceptWikiLinkMousedown,
  type WikiLinkMousedownEvent,
} from "./wikilinkMousedown";

class FakeElement {
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  private classes: string[];
  constructor(classes: string[] = [], parent: FakeElement | null = null) {
    this.classes = classes;
    if (parent) {
      this.parentNode = parent;
      this.parentElement = parent;
    }
  }
  closest(selector: string): FakeElement | null {
    const sels = selector.split(",").map((s) => s.trim().replace(/^\./, ""));
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.classes.some((c) => sels.includes(c))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}
class FakeTextNode {
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  constructor(parent: FakeElement | null = null) {
    if (parent) {
      this.parentNode = parent;
      this.parentElement = parent;
    }
  }
}

const origElement = (globalThis as { Element?: unknown }).Element;
const origNode = (globalThis as { Node?: unknown }).Node;
(globalThis as { Element: unknown }).Element = FakeElement;
(globalThis as { Node: unknown }).Node = (class FakeNode {
  static [Symbol.hasInstance](instance: unknown) {
    return instance instanceof FakeElement || instance instanceof FakeTextNode;
  }
});
import { afterAll } from "vitest";
afterAll(() => {
  if (origElement !== undefined) {
    (globalThis as { Element: unknown }).Element = origElement;
  }
  if (origNode !== undefined) {
    (globalThis as { Node: unknown }).Node = origNode;
  }
});

function mkEvent(
  overrides: Partial<WikiLinkMousedownEvent> = {},
): WikiLinkMousedownEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

describe("maybeInterceptWikiLinkMousedown", () => {
  it("intercepts a left-click on a wiki-link span and stops the event", () => {
    const event = mkEvent();
    const span = {} as unknown as Element;
    const handled = maybeInterceptWikiLinkMousedown(event, {
      findWikiLinkSpan: () => span,
      onWikiLinkHit: () => true,
    });
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("returns false (does not interfere) when target is not a wiki-link span", () => {
    const event = mkEvent();
    const handled = maybeInterceptWikiLinkMousedown(event, {
      findWikiLinkSpan: () => null,
      onWikiLinkHit: () => {
        throw new Error("onWikiLinkHit must not be called when no span found");
      },
    });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("ignores right-clicks even on a wiki-link span", () => {
    const event = mkEvent({ button: 2 });
    const handled = maybeInterceptWikiLinkMousedown(event, {
      findWikiLinkSpan: () => ({}) as unknown as Element,
      onWikiLinkHit: () => {
        throw new Error("onWikiLinkHit must not be called for right-click");
      },
    });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
  ] as const)(
    "ignores clicks with %s held (lets the user open in a new tab / extend selection)",
    (_label, mod) => {
      const event = mkEvent(mod);
      const handled = maybeInterceptWikiLinkMousedown(event, {
        findWikiLinkSpan: () => ({}) as unknown as Element,
        onWikiLinkHit: () => {
          throw new Error("onWikiLinkHit must not be called for modifier-held");
        },
      });
      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );

  it("does NOT preventDefault if onWikiLinkHit returns false (e.g. no resolver yet, no Lezer node at coords)", () => {
    const event = mkEvent();
    const handled = maybeInterceptWikiLinkMousedown(event, {
      findWikiLinkSpan: () => ({}) as unknown as Element,
      onWikiLinkHit: () => false,
    });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("passes the same event reference to onWikiLinkHit (so callers can read clientX/Y)", () => {
    const event = mkEvent({ clientX: 123, clientY: 456 });
    let seen: WikiLinkMousedownEvent | null = null;
    maybeInterceptWikiLinkMousedown(event, {
      findWikiLinkSpan: () => ({}) as unknown as Element,
      onWikiLinkHit: (e) => {
        seen = e;
        return true;
      },
    });
    expect(seen).toBe(event);
  });
});

describe("closestWikiLinkSpan", () => {
  it("returns the span when target IS the wiki-link element (Chromium dispatch shape)", () => {
    const span = new FakeElement(["cm-md-wikilink"]);
    const got = closestWikiLinkSpan(span as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("returns the span when target is a Text node inside the span (WebKit dispatch shape)", () => {
    const span = new FakeElement(["cm-md-wikilink"]);
    const text = new FakeTextNode(span);
    const got = closestWikiLinkSpan(text as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("walks up to find the wiki-link ancestor when target is a nested child node", () => {
    const span = new FakeElement(["cm-md-wikilink"]);
    const inner = new FakeElement([], span);
    const text = new FakeTextNode(inner);
    const got = closestWikiLinkSpan(text as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("matches the unresolved wiki-link class too", () => {
    const span = new FakeElement(["cm-md-wikilink-unresolved"]);
    const text = new FakeTextNode(span);
    const got = closestWikiLinkSpan(text as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("returns null when the target's ancestry has no wiki-link span", () => {
    const para = new FakeElement(["cm-line"]);
    const text = new FakeTextNode(para);
    const got = closestWikiLinkSpan(text as unknown as EventTarget);
    expect(got).toBeNull();
  });

  it("returns null when the target is null", () => {
    expect(closestWikiLinkSpan(null)).toBeNull();
  });

  it("returns null when the target is neither Element nor Node", () => {
    const got = closestWikiLinkSpan({} as EventTarget);
    expect(got).toBeNull();
  });
});
