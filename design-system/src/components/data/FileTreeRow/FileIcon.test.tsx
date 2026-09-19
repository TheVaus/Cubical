// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import FileIcon, { type FileKind } from "./FileIcon";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe("FileIcon", () => {
  it("redraws when its kind changes", () => {
    const [kind, setKind] = createSignal<FileKind>("folder");
    const host = document.createElement("div");
    dispose = render(() => <FileIcon kind={kind()} />, host);
    const closed = host.innerHTML;

    setKind("folder-open");

    expect(host.innerHTML).not.toBe(closed);
    expect(host.querySelectorAll("svg")).toHaveLength(1);
  });
});
