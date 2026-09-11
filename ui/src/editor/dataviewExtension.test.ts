// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  dataviewExtensionFor,
  dataviewRunnerFacet,
  dataviewRunnerUpdated,
  type DataviewRunner,
} from "./dataview";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

function fakeRunner() {
  let handlers: (() => void)[] = [];
  const runner: DataviewRunner = {
    get: () => undefined,
    fetch: () => {},
    invalidate: () => {},
    onUpdate(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
    version: () => 0,
    open: vi.fn(),
  };
  return {
    runner,
    fire: () => handlers.forEach((h) => h()),
    listeners: () => handlers.length,
  };
}

function mount(runner: DataviewRunner | null, seen: string[] = []) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "text",
      extensions: [
        dataviewExtensionFor(runner),
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) {
            if (tr.effects.some((e) => e.is(dataviewRunnerUpdated))) {
              seen.push("updated");
            }
          }
        }),
      ],
    }),
  });
  return view;
}

function resultLink(v: EditorView, path: string): HTMLElement {
  const link = document.createElement("span");
  link.className = "cq-dataview-link";
  link.setAttribute("data-path", path);
  v.contentDOM.appendChild(link);
  return link;
}

describe("dataviewExtensionFor", () => {
  it("puts the runner in the facet", () => {
    const { runner } = fakeRunner();
    expect(mount(runner).state.facet(dataviewRunnerFacet)).toBe(runner);
  });

  it("tells the view when the runner has new results", () => {
    const { runner, fire } = fakeRunner();
    const seen: string[] = [];
    mount(runner, seen);
    fire();
    expect(seen).toEqual(["updated"]);
  });

  it("opens the note a result link names", () => {
    const { runner } = fakeRunner();
    const v = mount(runner);
    resultLink(v, "notes/a.md").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(runner.open).toHaveBeenCalledWith("notes/a.md");
  });

  it("drops its subscription and its listener with the view", () => {
    const { runner, listeners } = fakeRunner();
    const v = mount(runner);
    const removed = vi.spyOn(v.contentDOM, "removeEventListener");
    v.destroy();
    view = undefined;
    expect(listeners()).toBe(0);
    expect(removed).toHaveBeenCalledWith("mousedown", expect.any(Function), true);
  });
});
