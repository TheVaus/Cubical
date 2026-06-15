// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderDataview } from "./dataviewRender";
import type { DataviewResult } from "../api/ipc";

function mount(result: DataviewResult) {
  const host = document.createElement("div");
  host.appendChild(renderDataview(result));
  return host;
}

describe("renderDataview", () => {
  it("renders a list of note links carrying their target path", () => {
    const host = mount({
      kind: "list",
      notes: [
        { path: "a.md", title: "a" },
        { path: "b.md", title: "b" },
      ],
    });
    const links = [...host.querySelectorAll("a.cq-dataview-link")];
    expect(links.length).toBe(2);
    expect(links[0]!.textContent).toBe("a");
    // Navigation is the editor's job (capture-phase interceptor); the
    // renderer only records the target on the element.
    expect(links[0]!.getAttribute("data-path")).toBe("a.md");
    expect(links[1]!.getAttribute("data-path")).toBe("b.md");
  });

  it("renders a table with an implicit File column + cells", () => {
    const host = mount({
      kind: "table",
      columns: ["status", "due"],
      rows: [
        { note: { path: "a.md", title: "a" }, cells: ["in-progress", ""] },
      ],
    });
    const headers = [...host.querySelectorAll("th")].map((h) => h.textContent);
    expect(headers).toEqual(["File", "status", "due"]);
    const cells = [...host.querySelectorAll("tbody td")].map((c) => c.textContent);
    expect(cells).toEqual(["a", "in-progress", ""]);
    const link = host.querySelector("tbody td a.cq-dataview-link");
    expect(link?.textContent).toBe("a");
    expect(link?.getAttribute("data-path")).toBe("a.md");
  });

  it("renders a count", () => {
    const host = mount({ kind: "count", count: 7 });
    expect(host.querySelector(".cq-dataview-count")?.textContent).toBe("7");
  });

  it("renders an error", () => {
    const host = mount({
      kind: "error",
      message: "expected LIST, TABLE, or COUNT",
    });
    expect(host.querySelector(".cq-dataview-error")?.textContent).toContain(
      "expected LIST",
    );
  });

  it("renders an empty list without rows", () => {
    const host = mount({ kind: "list", notes: [] });
    expect(host.querySelectorAll("li").length).toBe(0);
    expect(host.querySelector(".cq-dataview-list")).not.toBeNull();
  });
});
