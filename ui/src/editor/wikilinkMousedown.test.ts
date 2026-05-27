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
  maybeInterceptWikiLinkMousedown,
  type WikiLinkMousedownEvent,
} from "./wikilinkMousedown";

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
