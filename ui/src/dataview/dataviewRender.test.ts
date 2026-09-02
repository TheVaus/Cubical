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
      items: [
        { text: "a", note: { path: "a.md", title: "a" } },
        { text: "b", note: { path: "b.md", title: "b" } },
      ],
    });
    const links = [...host.querySelectorAll("a.cq-dataview-link")];
    expect(links.length).toBe(2);
    expect(links[0]!.textContent).toBe("a");
    expect(links[0]!.getAttribute("data-path")).toBe("a.md");
    expect(links[1]!.getAttribute("data-path")).toBe("b.md");
  });

  it("renders unlinked list items as plain text when a row has no note", () => {
    const host = mount({
      kind: "list",
      items: [
        { text: "EU", note: null },
        { text: "APAC", note: null },
      ],
    });
    expect(host.querySelectorAll("a.cq-dataview-link").length).toBe(0);
    const texts = [...host.querySelectorAll("li")].map((li) => li.textContent);
    expect(texts).toEqual(["EU", "APAC"]);
  });

  it("renders a table with an implicit File column + cells", () => {
    const host = mount({
      kind: "table",
      columns: ["status", "due"],
      row_label: "File",
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

  it("omits the label column entirely for a data-file table", () => {
    const host = mount({
      kind: "table",
      columns: ["region", "amount"],
      row_label: null,
      rows: [
        { note: null, cells: ["EU", "120"] },
        { note: null, cells: ["APAC", "300"] },
      ],
    });
    const headers = [...host.querySelectorAll("th")].map((h) => h.textContent);
    expect(headers).toEqual(["region", "amount"]);
    const firstRow = [...host.querySelectorAll("tbody tr")][0]!;
    expect([...firstRow.querySelectorAll("td")].map((c) => c.textContent)).toEqual([
      "EU",
      "120",
    ]);
    expect(host.querySelectorAll("a.cq-dataview-link").length).toBe(0);
  });

  it("wraps a table in a horizontal scroll container so wide tables do not squeeze", () => {
    const host = mount({
      kind: "table",
      columns: ["a", "b"],
      row_label: null,
      rows: [{ note: null, cells: ["1", "2"] }],
    });
    const scroll = host.querySelector(".cq-dataview-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll?.querySelector("table.cq-dataview-table")).not.toBeNull();
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
    const host = mount({ kind: "list", items: [] });
    expect(host.querySelectorAll("li").length).toBe(0);
    expect(host.querySelector(".cq-dataview-list")).not.toBeNull();
  });
});
