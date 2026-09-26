// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { SearchHit } from "../api/search";
import SearchResults from "./SearchResults";
import type { SearchState } from "./searchState";

const hit = (path: string): SearchHit => ({
  path,
  title: path,
  score: 1,
  mtime_secs: 0,
  matched_fields: [{ field: "body", snippet: `in <mark>${path}</mark>` }],
  tags: [],
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(hits: () => SearchHit[]) {
  const state = {
    hits,
    total: () => hits().length,
    error: () => null,
    status: () => null,
  } as unknown as SearchState;
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <SearchResults state={state} onNavigate={() => {}} />, host);
  return host;
}

describe("SearchResults keyboard navigation", () => {
  it("focuses the row shown at the target position after a reorder", () => {
    const [hits, setHits] = createSignal([hit("a.md"), hit("b.md")]);
    const host = mount(hits);
    const list = host.querySelector('[role="list"]')!;

    setHits([hit("b.md"), hit("a.md")]);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement?.getAttribute("title")).toBe("b.md");
  });
});
