// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

import Editor from "./Editor";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function tracked(label: string, log: string[]): Extension {
  return ViewPlugin.define(() => {
    log.push(`+${label}`);
    return { destroy: () => log.push(`-${label}`) };
  });
}

function mount(blocks: () => readonly Extension[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <Editor
        value="# note"
        resolvedTheme="light"
        rawSource={false}
        blockExtensions={blocks()}
      />
    ),
    host,
  );
}

describe("Editor block extensions", () => {
  it("installs every block the shell passes", () => {
    const log: string[] = [];
    mount(() => [tracked("a", log), tracked("b", log)]);
    expect(log).toEqual(["+a", "+b"]);
  });

  it("reconfigures only the block whose extension changed", () => {
    const log: string[] = [];
    const a = tracked("a", log);
    const [second, setSecond] = createSignal(tracked("b1", log));
    mount(() => [a, second()]);
    log.length = 0;

    setSecond(tracked("b2", log));

    expect(log).toEqual(["-b1", "+b2"]);
  });

  it("tears every block down with the view", () => {
    const log: string[] = [];
    mount(() => [tracked("a", log)]);
    dispose?.();
    dispose = undefined;
    expect(log).toEqual(["+a", "-a"]);
  });
});
