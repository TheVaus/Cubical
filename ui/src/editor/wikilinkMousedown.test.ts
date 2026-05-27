/**
 * Regression coverage for the wiki-link click interceptor.
 *
 * Three production attempts (`click` → `mousedown` → `mousedown + async
 * resolver`) all routed wiki-link clicks via `EditorView.posAtDOM(target)`
 * + a Lezer tree scan; all three reliably worked in Chromium but failed
 * inside the production WKWebView. The current implementation in
 * `Editor.tsx` swapped that for DOM-based detection
 * (`target.closest('.cm-md-wikilink')`) at the *capture* phase on
 * `view.contentDOM`. This file pins that behaviour so we don't
 * regress to "wiki-link clicks just move the caret in Tauri".
 */
import { describe, expect, it, vi } from "vitest";

import {
  closestWikiLinkSpan,
  maybeInterceptWikiLinkMousedown,
  type WikiLinkMousedownEvent,
} from "./wikilinkMousedown";

/**
 * Minimal Node/Element fakes — vitest runs in a node environment with
 * no DOM, so we don't have a real Element or Text class. These fakes
 * are just enough for `instanceof Element` / `instanceof Node` checks
 * plus a working `closest(selector)` lookup.
 */
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

// Make `instanceof Element` / `instanceof Node` work for our fakes by
// patching the globals. Restore is not strictly needed because vitest
// gives each test file its own module scope, but we keep originals so
// jsdom-equipped projects don't get surprised if they ever inherit
// these tests.
const origElement = (globalThis as { Element?: unknown }).Element;
const origNode = (globalThis as { Node?: unknown }).Node;
(globalThis as { Element: unknown }).Element = FakeElement;
(globalThis as { Node: unknown }).Node = (class FakeNode {
  static [Symbol.hasInstance](instance: unknown) {
    return instance instanceof FakeElement || instance instanceof FakeTextNode;
  }
});
// Restore on teardown so we don't leak into sibling test files.
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
    // Even though the DOM target IS a wiki-link span, the production
    // hit-callback may decline (no resolver bound, posAtCoords returned
    // null, no WikiLink node at the resolved position). In that case we
    // must not eat the caret-move — the user's normal click behaviour
    // should still run.
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
    // Regression: this is the case that broke the L3 Session B click
    // handler in production WKWebView. In the user's real Tauri app,
    // event.target for a click on the visible "NoteB" text was the
    // Text node inside `<span class="cm-md-wikilink">NoteB</span>`,
    // not the span itself. `closest()` is only defined on Element, so
    // the previous code silently bailed and the caret moved.
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
