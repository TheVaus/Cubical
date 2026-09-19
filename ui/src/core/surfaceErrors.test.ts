import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createSurfaceErrors } from "./surfaceErrors";

const build = (initial: string | null = "file:a.md") =>
  createRoot(() => {
    const [active, setActive] = createSignal<string | null>(initial);
    return { errors: createSurfaceErrors(active), setActive };
  });

describe("a tab that failed to load", () => {
  it("shows its failure while it is the active tab", () => {
    const { errors } = build();
    errors.tabFailed("file:a.md", "read failed");
    expect(errors.banner()).toBe("read failed");
  });

  it("clears once a later load of the same tab succeeds", () => {
    const { errors } = build();
    errors.tabFailed("file:a.md", "read failed");
    errors.tabLoaded("file:a.md");
    expect(errors.banner()).toBeNull();
  });

  it("is not cleared by another tab loading", () => {
    const { errors } = build();
    errors.tabFailed("file:a.md", "read failed");
    errors.tabLoaded("file:b.md");
    expect(errors.banner()).toBe("read failed");
  });

  it("is hidden while another tab is active", () => {
    const { errors, setActive } = build();
    errors.tabFailed("file:a.md", "read failed");
    setActive("file:b.md");
    expect(errors.banner()).toBeNull();
  });
});

describe("a vault that failed to open", () => {
  it("wins over a tab failure", () => {
    const { errors } = build();
    errors.tabFailed("file:a.md", "read failed");
    errors.vaultFailed("no such vault");
    expect(errors.banner()).toBe("no such vault");
  });

  it("clears when a vault opens", () => {
    const { errors } = build(null);
    errors.vaultFailed("no such vault");
    errors.vaultOpened();
    expect(errors.banner()).toBeNull();
  });
});

describe("clear, on releasing the vault", () => {
  it("drops every failure", () => {
    const { errors } = build();
    errors.vaultFailed("no such vault");
    errors.tabFailed("file:a.md", "read failed");
    errors.clear();
    expect(errors.banner()).toBeNull();
  });
});
