// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderEquation } from "./equationRender";

describe("renderEquation", () => {
  it("shows the formatted result", () => {
    const el = renderEquation({ status: "ok", value: "2" });
    expect(el.textContent).toBe("2");
    expect(el.className).toContain("cm-equation");
    expect(el.className).not.toContain("error");
  });

  it("shows the source while operands are still resolving", () => {
    const el = renderEquation({ status: "loading", raw: "[[dan.age]] - 3" });
    expect(el.textContent).toBe("[[dan.age]] - 3");
    expect(el.className).toContain("loading");
  });

  it("names a non-numeric operand rather than showing a bare source", () => {
    const el = renderEquation({
      status: "error",
      kind: "not_a_number",
      raw: "[[dan.age]] - 3",
    });
    expect(el.className).toContain("error");
    expect(el.textContent).toContain("not a number");
  });

  it("names a missing note", () => {
    const el = renderEquation({
      status: "error",
      kind: "unresolved_note",
      raw: "[[ghost.age]]",
    });
    expect(el.textContent).toContain("note not found");
  });

  it("names division by zero", () => {
    const el = renderEquation({
      status: "error",
      kind: "divide_by_zero",
      raw: "5 / 0",
    });
    expect(el.textContent).toContain("divide by zero");
  });
});
