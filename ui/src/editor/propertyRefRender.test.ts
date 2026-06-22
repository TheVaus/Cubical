// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

import { renderPropertyRef } from "./propertyRefRender";

describe("renderPropertyRef", () => {
  it("renders a resolved value", () => {
    const el = renderPropertyRef({ status: "resolved", value: "2019" });
    expect(el.textContent).toBe("2019");
    expect(el.className).toContain("cm-md-propref");
    expect(el.className).not.toContain("broken");
  });

  it("renders the raw token while loading", () => {
    const el = renderPropertyRef({ status: "loading", raw: "[[Gandalf.age]]" });
    expect(el.textContent).toBe("[[Gandalf.age]]");
    expect(el.className).toContain("cm-md-propref-loading");
  });

  it("renders broken refs with the raw token and a broken class", () => {
    const el = renderPropertyRef({ status: "broken", raw: "[[Ghost.age]]" });
    expect(el.textContent).toBe("[[Ghost.age]]");
    expect(el.className).toContain("cm-md-propref-broken");
  });
});
