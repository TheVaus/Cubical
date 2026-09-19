// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import type { Frontmatter } from "../ast/types";
import Properties from "./Properties";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(frontmatter: Frontmatter, initial: string) {
  let source = initial;
  const root = document.createElement("div");
  document.body.appendChild(root);
  dispose = render(
    () => (
      <Properties
        frontmatter={frontmatter}
        path="note.md"
        getSource={() => source}
        applyEdit={(from, to, text) => {
          source = source.slice(0, from) + text + source.slice(to);
        }}
        onOpenRaw={() => {}}
        typedEnabled
        dateDefault="YYYY-MM-DD"
        currencyDefault="usd"
        tagsKeyAsTags={false}
      />
    ),
    root,
  );
  return { root, source: () => source };
}

describe("Properties write-back", () => {
  it("builds a commit from the live source, not the debounced snapshot", () => {
    const stale: Frontmatter = {
      entries: [
        ["x", "old"],
        ["done", false],
      ],
      span: { start: 0, end: 0 },
    };
    const view = mount(stale, "---\nx: new\ndone: false\n---\n");
    const toggle = view.root.querySelector<HTMLButtonElement>('[role="switch"]')!;
    toggle.click();
    expect(view.source()).toBe("---\nx: new\ndone: true\n---\n");
  });

  it("keeps the type comment when a property is renamed", () => {
    const fm: Frontmatter = {
      entries: [["old", 5]],
      span: { start: 0, end: 0 },
    };
    const view = mount(fm, "---\nold: 5 # type:int\n---\n");
    const input = view.root.querySelector<HTMLInputElement>(
      'input[aria-label="Property name: old"]',
    )!;
    input.dispatchEvent(new FocusEvent("focus"));
    input.value = "new";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(view.source()).toBe("---\nnew: 5 # type:int\n---\n");
  });
});
