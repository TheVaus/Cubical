import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createNavSession } from "./navSession";

const build = () => createRoot(() => createNavSession());

describe("navigation", () => {
  it("walks back and forward over the visited paths", () => {
    const nav = build();
    nav.push("a.md");
    nav.push("b.md");

    expect(nav.canBack()).toBe(true);
    expect(nav.canForward()).toBe(false);
    expect(nav.back()).toBe("a.md");
    expect(nav.forward()).toBe("b.md");
  });

  it("reports no move at either end of the stack", () => {
    const nav = build();
    nav.push("a.md");

    expect(nav.back()).toBeNull();
    expect(nav.forward()).toBeNull();
  });
});

describe("reset", () => {
  it("leaves nowhere to navigate", () => {
    const nav = build();
    nav.push("a.md");
    nav.push("b.md");

    nav.reset();

    expect(nav.canBack()).toBe(false);
    expect(nav.canForward()).toBe(false);
    expect(nav.current()).toBeNull();
  });

  it("does not let a path from before the reset come back", () => {
    const nav = build();
    nav.push("old-vault-note.md");
    nav.reset();

    nav.push("new-vault-note.md");

    expect(nav.canBack()).toBe(false);
    expect(nav.back()).toBeNull();
    expect(nav.current()).toBe("new-vault-note.md");
  });
});
