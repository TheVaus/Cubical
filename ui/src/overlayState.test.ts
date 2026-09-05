// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { hasOpenOverlay, isOverlayOpen, OVERLAY_SELECTOR } from "./overlayState";

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe("overlayState", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports no overlay for an empty document", () => {
    mount("");
    expect(isOverlayOpen()).toBe(false);
  });

  it("reports an overlay when a tagged element is present", () => {
    mount('<div data-ds-overlay="modal"></div>');
    expect(isOverlayOpen()).toBe(true);
  });

  it("matches any overlay role, not one specific value", () => {
    for (const role of ["modal", "menu", "popover"]) {
      mount(`<div data-ds-overlay="${role}"></div>`);
      expect(isOverlayOpen()).toBe(true);
    }
  });

  it("finds an overlay nested inside other markup", () => {
    mount('<div><section><span data-ds-overlay="menu"></span></section></div>');
    expect(isOverlayOpen()).toBe(true);
  });

  it("ignores markup that only looks like an overlay", () => {
    mount('<div class="modal-scrim"></div><div data-overlay="modal"></div>');
    expect(isOverlayOpen()).toBe(false);
  });

  it("hasOpenOverlay scopes the search to the given root", () => {
    mount('<div id="a"></div><div id="b" data-ds-overlay="modal"></div>');
    const a = document.getElementById("a") as HTMLElement;
    expect(hasOpenOverlay(a)).toBe(false);
    expect(hasOpenOverlay(document)).toBe(true);
  });

  it("exports the selector the design system tags overlays with", () => {
    expect(OVERLAY_SELECTOR).toBe("[data-ds-overlay]");
  });
});
