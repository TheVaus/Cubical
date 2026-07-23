import { afterAll, describe, expect, it, vi } from "vitest";

import {
  closestTagSpan,
  maybeInterceptTagMousedown,
  tagPathFromSlice,
  type TagMousedownEvent,
} from "./tagMousedown";

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
(globalThis as { Node: unknown }).Node = class FakeNode {
  static [Symbol.hasInstance](instance: unknown) {
    return instance instanceof FakeElement || instance instanceof FakeTextNode;
  }
};
afterAll(() => {
  if (origElement !== undefined) {
    (globalThis as { Element: unknown }).Element = origElement;
  }
  if (origNode !== undefined) {
    (globalThis as { Node: unknown }).Node = origNode;
  }
});

function mkEvent(
  overrides: Partial<TagMousedownEvent> = {},
): TagMousedownEvent {
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

describe("maybeInterceptTagMousedown", () => {
  it("intercepts a left-click on a tag span and stops the event", () => {
    const event = mkEvent();
    const span = {} as unknown as Element;
    const handled = maybeInterceptTagMousedown(event, {
      findTagSpan: () => span,
      onTagHit: () => true,
    });
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("returns false (does not interfere) when target is not a tag span", () => {
    const event = mkEvent();
    const handled = maybeInterceptTagMousedown(event, {
      findTagSpan: () => null,
      onTagHit: () => {
        throw new Error("onTagHit must not be called when no span found");
      },
    });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores right-clicks even on a tag span", () => {
    const event = mkEvent({ button: 2 });
    const handled = maybeInterceptTagMousedown(event, {
      findTagSpan: () => ({}) as unknown as Element,
      onTagHit: () => {
        throw new Error("onTagHit must not be called for right-click");
      },
    });
    expect(handled).toBe(false);
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
  ] as const)(
    "ignores clicks with %s held",
    (_label, mod) => {
      const event = mkEvent(mod);
      const handled = maybeInterceptTagMousedown(event, {
        findTagSpan: () => ({}) as unknown as Element,
        onTagHit: () => {
          throw new Error("onTagHit must not be called for modifier-held");
        },
      });
      expect(handled).toBe(false);
    },
  );

  it("does NOT preventDefault when onTagHit returns false", () => {
    const event = mkEvent();
    const handled = maybeInterceptTagMousedown(event, {
      findTagSpan: () => ({}) as unknown as Element,
      onTagHit: () => false,
    });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

describe("closestTagSpan", () => {
  it("returns the span when target IS the tag element", () => {
    const span = new FakeElement(["cm-md-tag"]);
    const got = closestTagSpan(span as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("returns the span when target is a Text node inside the span (WKWebView)", () => {
    const span = new FakeElement(["cm-md-tag"]);
    const text = new FakeTextNode(span);
    const got = closestTagSpan(text as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("walks up to find the tag ancestor when target is a nested child node", () => {
    const span = new FakeElement(["cm-md-tag"]);
    const inner = new FakeElement([], span);
    const text = new FakeTextNode(inner);
    const got = closestTagSpan(text as unknown as EventTarget);
    expect(got).toBe(span);
  });

  it("returns null when the target's ancestry has no tag span", () => {
    const para = new FakeElement(["cm-line"]);
    const text = new FakeTextNode(para);
    const got = closestTagSpan(text as unknown as EventTarget);
    expect(got).toBeNull();
  });

  it("returns null when the target is null", () => {
    expect(closestTagSpan(null)).toBeNull();
  });
});

describe("tagPathFromSlice", () => {
  it("strips the leading `#` from a simple tag", () => {
    expect(tagPathFromSlice("#todo")).toBe("todo");
  });

  it("preserves nested tag separators", () => {
    expect(tagPathFromSlice("#project/cubical/l3")).toBe("project/cubical/l3");
  });

  it("preserves casing", () => {
    expect(tagPathFromSlice("#ToDo")).toBe("ToDo");
  });

  it("returns null for an empty slice", () => {
    expect(tagPathFromSlice("")).toBeNull();
  });

  it("returns null for a slice missing the `#` opener", () => {
    expect(tagPathFromSlice("todo")).toBeNull();
  });

  it("returns null for a bare `#` with no body", () => {
    expect(tagPathFromSlice("#")).toBeNull();
  });
});
