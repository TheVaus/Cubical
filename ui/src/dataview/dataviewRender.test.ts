// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderDataview } from "./dataviewRender";
import type { DataviewResult } from "../api/ipc";

function mount(result: DataviewResult, onOpen = vi.fn()) {
  const host = document.createElement("div");
  host.appendChild(renderDataview(result, { onOpen }));
  return host;
}

describe("renderDataview", () => {
  it("renders a list of note links and fires onOpen on click", () => {
    const onOpen = vi.fn();
    const host = mount(
      {
        kind: "list",
        notes: [
          { path: "a.md", title: "a" },
          { path: "b.md", title: "b" },
        ],
      },
      onOpen,
    );
    const links = host.querySelectorAll("a");
    expect(links.length).toBe(2);
    const first = links[0]!;
    expect(first.textContent).toBe("a");
    first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("a.md");
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
    expect(host.querySelector("tbody td a")?.textContent).toBe("a");
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
