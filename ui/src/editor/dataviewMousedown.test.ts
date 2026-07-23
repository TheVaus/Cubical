// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  closestDataviewFrame,
  closestDataviewLink,
  maybeInterceptDataviewMousedown,
  type DataviewMousedownEvent,
  type DataviewMousedownHandlerOptions,
} from "./dataviewMousedown";

function evt(over: Partial<DataviewMousedownEvent> = {}): DataviewMousedownEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...over,
  };
}

function opts(
  over: Partial<DataviewMousedownHandlerOptions> = {},
): DataviewMousedownHandlerOptions {
  return {
    findDataviewLink: () => null,
    findDataviewFrame: () => null,
    onLinkHit: vi.fn().mockReturnValue(false),
    onFrameHit: vi.fn().mockReturnValue(false),
    ...over,
  };
}

describe("maybeInterceptDataviewMousedown", () => {
  it("navigates and swallows the event on a plain left-click of a link", () => {
    const link = document.createElement("a");
    const e = evt();
    const onLinkHit = vi.fn().mockReturnValue(true);

    const handled = maybeInterceptDataviewMousedown(
      e,
      opts({ findDataviewLink: () => link, onLinkHit }),
    );

    expect(handled).toBe(true);
    expect(onLinkHit).toHaveBeenCalledWith(link);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("reveals source and swallows the event on a non-link click inside the widget", () => {
    const frame = document.createElement("div");
    const e = evt();
    const onFrameHit = vi.fn().mockReturnValue(true);

    const handled = maybeInterceptDataviewMousedown(
      e,
      opts({ findDataviewFrame: () => frame, onFrameHit }),
    );

    expect(handled).toBe(true);
    expect(onFrameHit).toHaveBeenCalledWith(frame);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("prefers link navigation over frame reveal when both match", () => {
    const link = document.createElement("a");
    const frame = document.createElement("div");
    const onLinkHit = vi.fn().mockReturnValue(true);
    const onFrameHit = vi.fn().mockReturnValue(true);

    const handled = maybeInterceptDataviewMousedown(
      evt(),
      opts({
        findDataviewLink: () => link,
        findDataviewFrame: () => frame,
        onLinkHit,
        onFrameHit,
      }),
    );

    expect(handled).toBe(true);
    expect(onLinkHit).toHaveBeenCalled();
    expect(onFrameHit).not.toHaveBeenCalled();
  });

  it("ignores clicks outside any dataview link or frame", () => {
    const e = evt();
    const handled = maybeInterceptDataviewMousedown(e, opts());
    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores non-left buttons", () => {
    const e = evt({ button: 2 });
    const handled = maybeInterceptDataviewMousedown(
      e,
      opts({
        findDataviewFrame: () => document.createElement("div"),
        onFrameHit: vi.fn().mockReturnValue(true),
      }),
    );
    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores modifier-clicks (cmd/ctrl/shift/alt) so the browser can act", () => {
    for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const e = evt({ [mod]: true });
      const handled = maybeInterceptDataviewMousedown(
        e,
        opts({
          findDataviewLink: () => document.createElement("a"),
          onLinkHit: vi.fn().mockReturnValue(true),
        }),
      );
      expect(handled).toBe(false);
    }
  });

  it("does not swallow the event when nothing handles the click", () => {
    const e = evt();
    const handled = maybeInterceptDataviewMousedown(
      e,
      opts({
        findDataviewLink: () => document.createElement("a"),
        onLinkHit: vi.fn().mockReturnValue(false),
      }),
    );
    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("closestDataviewLink", () => {
  it("finds the link element from a click on its text node", () => {
    const a = document.createElement("a");
    a.className = "cq-dataview-link";
    a.textContent = "Mobile App";
    document.body.appendChild(a);
    const textNode = a.firstChild!;
    expect(closestDataviewLink(textNode)).toBe(a);
    a.remove();
  });

  it("returns null for clicks outside any dataview link", () => {
    const div = document.createElement("div");
    expect(closestDataviewLink(div)).toBeNull();
  });
});

describe("closestDataviewFrame", () => {
  it("finds the widget frame from a click on the count text node", () => {
    const frame = document.createElement("div");
    frame.className = "cm-dataview-frame";
    const count = document.createElement("div");
    count.className = "cq-dataview-count";
    count.textContent = "3";
    frame.appendChild(count);
    document.body.appendChild(frame);
    expect(closestDataviewFrame(count.firstChild)).toBe(frame);
    frame.remove();
  });

  it("returns null for clicks outside any widget frame", () => {
    const div = document.createElement("div");
    expect(closestDataviewFrame(div)).toBeNull();
  });
});
